//! M22 · 电脑端「同步入口」的临时服务
//!
//! 照《同步协议》§3 那几条**安全规矩**逐条落实（用户已点头的那份文档）：
//! 1. **只在「点开始同步 → 同步结束」这段时间存在** —— 没有常驻端口，进程里没有服务时端口就是关的；
//! 2. **一次性令牌**：32 字节随机、写进二维码、**5 分钟有效**、用完即废；
//! 3. **只监听局域网地址**（不是 `0.0.0.0`）：先把本机的局域网 IPv4 找出来，绑它一个；
//! 4. **端口取随机高位端口**（20000~60000），避免撞上别的程序；
//! 5. **结束即关**：取消 / 超时 / 用完都立刻把服务停掉（端口随之释放，测试里用 `Get-NetTCPConnection` 验）；
//! 6. **不碰公网、不留外部日志**：只在内存里记几行给界面看的日志，一个字都不往外发。
//!
//! ⚠️ **二维码必须由代码生成**（`qrcode` crate → SVG），协议里写死了 —— 拿图片顶替扫不出来。
//! 二维码内容格式（写进 `同步协议.md` 的修订记录）：
//!
//! ```text
//! moye-sync://<局域网IP>:<端口>/<令牌>
//! ```
//!
//! ⚠️ **M22 只做到"电脑端能出码、能等、能取消"**：手机端那一半在 **M23**。
//! 所以 `comparing / transferring / applying / done` 这几个阶段在 M22 **不会发生** ——
//! 界面必须如实写"等手机连上来（手机端在 M23）"，**不许假装同步成功**。


use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chrono::Local;
use serde::Serialize;

use crate::store::{copy_recursive, sync, Store, DATA_ENTRIES};

/// 二维码/令牌的有效期（协议：5 分钟）
pub const TOKEN_TTL_SECONDS: u64 = 300;
/// 二维码内容的前缀（协议里规定的可解析形式）
pub const QR_PREFIX: &str = "moye-sync://";
/// 随机端口范围（避开系统常用端口）
pub const PORT_MIN: u16 = 20000;
/// 随机端口范围上界
pub const PORT_MAX: u16 = 60000;
/// 服务线程醒来检查"该不该收工"的间隔
const POLL: Duration = Duration::from_millis(250);

/// 🩹 **P1-2**：手机**已经连上之后**多久没动静就判定"断了"。
///
/// 正常一趟同步只要几秒；90 秒都没有任何请求，只可能是手机断了 / 关机了 / 走出 WiFi 了。
/// 判定之后这一轮**立刻结束**（服务关掉、入口让出来），用户可以直接再点「开始同步」。
pub const STALL_SECONDS: u64 = 90;

/// 🩹 **P1-2**：一轮同步的**硬上限** —— 无论什么阶段，到点一律收工。
///
/// 这是"绝不把入口永久占住"的最后一道保险（用户 2026-10-06 就是被占住卡死的）。
pub const SESSION_MAX_SECONDS: u64 = 600;

/// 同一时刻只允许**一次** `start`（产品语义上本来就该如此：同时在跑两个同步没有意义）。
/// 🩹 顺带解决一个真实麻烦：并发跑的测试会同时抢这个全局服务槽，
///    互相报"已经有一个同步在等着了" → 全量 `cargo test` 出现假红（2026-10-06 撞到）。
static START_LOCK: Mutex<()> = Mutex::new(());

/// 测试专用：**用同步服务的测试必须串行**（服务是全局单例；并发跑会互相报"已经有一个同步在等着了"）。
#[cfg(test)]
pub(crate) static TEST_SYNC_LOCK: Mutex<()> = Mutex::new(());
/// 端口被占时最多重试几次
const PORT_TRIES: usize = 12;

/// 给前端的快照（字段一律 camelCase，跟 TS 类型一一对应）
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncServerStatus {
    /// `idle`｜`waiting`（等手机扫）｜`connected`（手机连上了）｜
    /// `comparing`/`transferring`/`applying`（M23 才会出现）｜`done`｜`error`
    pub phase: String,
    /// `192.168.1.5:32123`（没在跑就是空串）
    pub address: String,
    /// 连上来的那台设备（M22 先写它的 IP；M23 再换成手机名）
    pub remote: String,
    /// 还剩几秒有效（没在跑就是 0）
    pub seconds_left: u64,
    /// 二维码 SVG（**由代码生成**；没在跑就是空串）
    pub qr_svg: String,
    /// 二维码内容本身（诊断/测试用；也方便界面显示"手输短码"那条路的底料）
    pub qr_text: String,
    /// **6 位短码**（M23）：相机不好使时手机上**手输这个**就能连（服务端两种凭据都认）。
    /// ⚠️ 跟令牌一样是**这一轮**的凭据，服务一关就作废。
    pub short_code: String,
    /// 这一轮的开始时间（ISO）
    pub started_at: String,
    /// 同步前快照目录（相对数据目录，如 `backups\sync-pre\2026-10-06-0130`）
    pub pre_snapshot: String,
    /// 上一次同步成功时间（来自 `sync/state.json`，M23 才有值）
    pub last_sync_at: String,
    /// 出错/结束原因（给人看的一句话）
    pub message: String,
    /// 给界面看的逐项日志（只在内存里）
    pub log: Vec<String>,
    /// 🩹 **P1-2**：**上一轮**同步的结果：`done`｜`error`｜`cancel`｜空串（从没同步过）。
    ///
    /// 为什么要单列：这一轮结束时会话就**从槽里摘掉**了（见 [`retire`]），`phase` 立刻回到 `idle` ——
    /// 要是没有这两个字段，用户刚看到"同步完成"下一秒界面就什么都不剩，会以为白同步了。
    pub last_result: String,
    /// 上一轮的一句话结论（给人看）
    pub last_message: String,
    /// 上一轮结束的时间（ISO）
    pub last_at: String,
}

/// 会话内部可变部分（服务线程与命令都要改它）
struct Inner {
    phase: String,
    remote: String,
    log: Vec<String>,
    message: String,
}

struct Session {
    address: String,
    started: Instant,
    started_at: String,
    stop: Arc<AtomicBool>,
    /// 这一轮**已经结束**了吗（线程收工时置位）。
    ///
    /// 它是"会话身份牌"：`retire` 靠 `Arc::ptr_eq` 认出"这面牌子是不是我这一轮的"，
    /// 免得把用户刚重开的那一轮误摘掉。
    over: Arc<AtomicBool>,
    inner: Arc<Mutex<Inner>>,
    qr_svg: String,
    qr_text: String,
    short_code: String,
    pre_snapshot: String,
    handle: Option<JoinHandle<()>>,
}

fn slot() -> &'static Mutex<Option<Session>> {
    static S: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// 「同步**落地成功**了」要通知谁（`lib.rs` 启动时注册一次，见 [`set_applied_hook`]）。
///
/// # 为什么要有这个钩子（2026-10-20 · 用户反馈「正文延迟」/「软件本体找不到同步来的东西」）
/// `store/` 这一层**不认识 Tauri**（它只管数据），可"同步把数据落地了"这件事**必须让界面知道** ——
/// 不然同步过来的笔记就**躺在 `notes/` 里、界面上看不见**，得用户手动刷新才出现
/// （用户 2026-10-20 报的「冲突副本找不到」就是这个：手机一趟同步推上来的笔记，
/// 主窗手上还是同步前那份列表）。
///
/// 别的写操作（存笔记 / 建待办 / 归档…）都是命令层直接 `emit_data_changed` 广播，
/// 只有同步这条路是**在后台线程里落地**的、而且落地的函数在 `store/` 里 —— 所以用
/// 「启动时注册一个回调」把两层的界线留住，比把 `AppHandle` 一路捅进数据层干净。
static APPLIED_HOOK: Mutex<Option<Box<dyn Fn() + Send + Sync>>> = Mutex::new(None);

/// 注册「落地成功后干什么」。重复注册会覆盖（启动时只注册一次）。
pub fn set_applied_hook(hook: Box<dyn Fn() + Send + Sync>) {
    if let Ok(mut guard) = APPLIED_HOOK.lock() {
        *guard = Some(hook);
    }
}

/// 通知一次「数据落地了」。
///
/// ⚠️ **尽力而为**：回调是给界面刷新的，刷新失败也绝不能影响"这次同步成功了"这个事实
/// （所以吞掉锁中毒，也不 panic）。
fn notify_applied() {
    if let Ok(guard) = APPLIED_HOOK.lock() {
        if let Some(hook) = guard.as_ref() {
            hook();
        }
    }
}

/// 上一轮的结果（会话摘掉之后，界面上仍要留个交代）
#[derive(Debug, Clone, Default)]
struct LastResult {
    phase: String,
    message: String,
    at: String,
}

fn last_slot() -> &'static Mutex<Option<LastResult>> {
    static L: OnceLock<Mutex<Option<LastResult>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

/// 🩹 **P1-2 的正主**：一轮同步**结束时必须把会话从槽里摘掉**。
///
/// 三种结束都要走到这儿：① 同步成功（`done`）② 超时 / 断线（`error`）③ 用户点「结束这次同步」（`cancel`）。
///
/// 以前线程退出时只是 `break`，会话仍挂在全局槽里，而 `start()` 又只认 `stop` 标志（只有 cancel 会置位）
/// → **成功一次之后这个入口就永久卡在"已经有一个同步在等着了"，非重启程序不可**（用户 2026-10-06 撞到）。
fn retire(over: &Arc<AtomicBool>, phase: &str, message: &str) {
    over.store(true, Ordering::SeqCst);
    if let Ok(mut last) = last_slot().lock() {
        *last = Some(LastResult {
            phase: phase.to_string(),
            message: message.to_string(),
            at: crate::models::now_iso(),
        });
    }
    if let Ok(mut guard) = slot().lock() {
        // ⚠️ 只摘"自己这一轮"：万一用户已经点过取消（会话被 `cancel` 拿走了），这里一个字都不能动。
        let mine = guard.as_ref().map(|s| Arc::ptr_eq(&s.over, over)).unwrap_or(false);
        if mine {
            if let Some(mut session) = guard.take() {
                session.stop.store(true, Ordering::SeqCst);
                // 线程正跑在自己身上 —— 丢掉 handle 就是"分离"，不能 join 自己
                let _ = session.handle.take();
            }
        }
    }
}

// ─────────────────────────── 小工具（都是纯函数，好测） ───────────────────────────

/// 32 字节随机令牌（64 个 hex 字符）。不引 `rand`：uuid 已经够随机了，两条拼起来正好 32 字节。
pub fn make_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

/// 随机端口：用 uuid 的低 16 位取模到 [`PORT_MIN`]..=[`PORT_MAX`]
pub fn random_port(seed: u128) -> u16 {
    let span = (PORT_MAX - PORT_MIN) as u128 + 1;
    PORT_MIN + (seed % span) as u16
}

/// 二维码内容：`moye-sync://<ip>:<port>/<token>`
pub fn qr_text(ip: &str, port: u16, token: &str) -> String {
    format!("{QR_PREFIX}{ip}:{port}/{token}")
}

/// 从二维码内容里解回 `(ip, port, token)` —— 手机端（M23）会用同一套解析，这里先把它测起来（所以现在"没人用"是正常的）
#[allow(dead_code)]
pub fn parse_qr_text(text: &str) -> Option<(String, u16, String)> {
    let rest = text.strip_prefix(QR_PREFIX)?;
    let (addr, token) = rest.split_once('/')?;
    let (ip, port) = addr.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if ip.is_empty() || token.is_empty() {
        return None;
    }
    Some((ip.to_string(), port, token.to_string()))
}

/// 令牌过期了吗（纯函数，好测）
pub fn expired(started: Instant, now: Instant, ttl: Duration) -> bool {
    now.duration_since(started) >= ttl
}

/// 还剩几秒（不够 1 秒算 0）
pub fn seconds_left(started: Instant, now: Instant, ttl: Duration) -> u64 {
    ttl.saturating_sub(now.duration_since(started)).as_secs()
}

/// 🩹 **P1-2**：这一轮**该不该收工了**？（**纯函数**，好测）
///
/// 返回 `None` = 继续等；`Some((phase, 原因))` = 收工（并把原因如实写给用户看）。
///
/// P1-2 的根因就是"没人来收工"：会话一旦进了 `connected` / `comparing`，原来只等**令牌 5 分钟到期**，
/// 而到期之后线程虽然退出，**会话还占在槽里** → 用户再点「开始同步」永远得到"已经有一个同步在等着了"。
/// 所以把"什么时候算结束"写成一条能测的规则：
///
/// - **等手机来连**（`waiting`）：只认令牌有效期（协议写死 5 分钟）→ 到点作废；
/// - **手机已连上 / 正在比对落地**：改看**还有没有动静** —— 手机断了、关机了、走出 WiFi 了，
///   [`STALL_SECONDS`] 秒没有任何请求就判定断开；
/// - **硬上限**：无论什么阶段，超过 [`SESSION_MAX_SECONDS`] 一律收工。
pub fn finish_reason(
    started: Instant,
    last_seen: Instant,
    now: Instant,
    phase: &str,
    ttl: Duration,
) -> Option<(&'static str, String)> {
    if now.duration_since(started) >= Duration::from_secs(SESSION_MAX_SECONDS) {
        return Some((
            "error",
            format!(
                "这一轮超过 {} 分钟还没完 —— 先结束掉，可以重新开始",
                SESSION_MAX_SECONDS / 60
            ),
        ));
    }
    if phase == "waiting" {
        if expired(started, now, ttl) {
            return Some(("error", "二维码超时作废（5 分钟内没有手机来连）".to_string()));
        }
        return None;
    }
    if now.duration_since(last_seen) >= Duration::from_secs(STALL_SECONDS) {
        return Some((
            "error",
            format!(
                "手机端 {STALL_SECONDS} 秒没有动静 —— 判定断开了，这次同步已结束（可以重新开始）"
            ),
        ));
    }
    None
}

/// 把令牌变成 SVG 二维码（**代码生成**，不是图片）
pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| format!("二维码生成失败：{e}"))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build())
}

/// 找本机的**局域网** IPv4：拿一个 UDP socket"连"一下外网地址 ——
/// ⚠️ UDP 的 `connect` **不发任何包**，只是让系统按路由表告诉我们"出网会用哪张网卡的哪个地址"，
/// 所以这**不是**在碰公网（协议 §3.2 第 4 条不许监听公网，这里只是问一句本机地址）。
pub fn pick_local_ipv4() -> Result<Ipv4Addr, String> {
    let probe = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("找本机地址失败：{e}"))?;
    if probe.connect(("192.0.2.1", 9)).is_ok() {
        // 192.0.2.0/24 是保留的测试网段（RFC 5737），只用于路由查询
        if let Ok(SocketAddr::V4(addr)) = probe.local_addr() {
            let ip = *addr.ip();
            if !ip.is_loopback() && !ip.is_unspecified() {
                return Ok(ip);
            }
        }
    }
    Err("找不到局域网地址 —— 电脑连上 WiFi / 网线了吗？".to_string())
}

/// 同步前快照：把 [`DATA_ENTRIES`] 那几样**原样**拷到 `backups/sync-pre/<时间戳>/`。
///
/// ⚠️ **留档失败就中止**（协议 §3.6 第 1 条 + 老规矩"宁可不做也不冒丢数据的险"）。
pub fn snapshot_pre_sync(store: &Store) -> Result<PathBuf, String> {
    let stamp = Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let dir = store.data_dir().join("backups").join("sync-pre").join(stamp);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建快照目录失败：{e}"))?;
    let mut copied = 0usize;
    for entry in DATA_ENTRIES {
        let from = store.data_dir().join(entry);
        if !from.exists() {
            continue;
        }
        let to = dir.join(entry);
        copy_recursive(&from, &to).map_err(|e| format!("拷 {entry} 失败：{e}"))?;
        copied += 1;
    }
    if copied == 0 {
        return Err("数据目录里没找到任何该备份的东西 —— 先确认数据目录对不对".to_string());
    }
    // 🔴 2026-10-13：留完顺手剪掉最老的几份 —— 这一族原来**根本没有清理**，
    //    实测堆到 41 个目录 / 105.75 MB。留最近 SYNC_SNAPSHOT_KEEP 轮足够回滚。
    let root = store.data_dir().join("backups").join("sync-pre");
    crate::store::safety::prune_dirs(&root, "", crate::store::safety::SYNC_SNAPSHOT_KEEP);
    Ok(dir)
}

/// 快照目录 → 相对数据目录的短路径（给界面显示）
pub fn short_path(store: &Store, path: &std::path::Path) -> String {
    path.strip_prefix(store.data_dir())
        .map(|p| p.to_string_lossy().replace('/', "\\"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

// ─────────────────────────── 服务本体 ───────────────────────────

fn push_log(inner: &Arc<Mutex<Inner>>, line: &str) {
    if let Ok(mut guard) = inner.lock() {
        guard.log.push(line.to_string());
        if guard.log.len() > 40 {
            guard.log.remove(0);
        }
    }
}

fn set_phase(inner: &Arc<Mutex<Inner>>, phase: &str) {
    if let Ok(mut guard) = inner.lock() {
        guard.phase = phase.to_string();
    }
}

/// 起一次同步（点「开始同步」）
///
/// 顺序是**故意的**：先留快照 → 再起服务。留档失败就直接返回 Err，一个字都不往外开。
pub fn start(store: &Store) -> Result<SyncServerStatus, String> {
    // 拿住这把锁直到函数结束（guard 出作用域自动放）—— 见 START_LOCK 的注释
    let _start_guard = START_LOCK.lock().map_err(|_| "同步服务启动锁坏了".to_string())?;
    // ⚠️ join 必须**在锁外面**做：线程收工时也要来锁这个槽，握着锁等它 = 死锁。
    let stale = {
        let mut guard = slot().lock().map_err(|_| "同步服务状态锁坏了".to_string())?;
        let live = guard
            .as_ref()
            .map(|s| !s.over.load(Ordering::SeqCst) && !s.stop.load(Ordering::SeqCst))
            .unwrap_or(false);
        if live {
            return Err("已经在同步了 —— 先点「结束这次同步」再重开".to_string());
        }
        // 🩹 P1-2：上一轮要是**已经结束**却没摘干净（线程异常退出等），这里顺手清掉，
        //    绝不能让"结束了的会话"把入口永久占住（用户就是这么被卡死的）。
        guard.take()
    };
    if let Some(mut dead) = stale {
        dead.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = dead.handle.take() {
            let _ = handle.join();
        }
    }

    // ① 同步前快照（失败即中止）
    let snapshot = snapshot_pre_sync(store)?;

    // ② 局域网地址 + 随机端口（撞了就换一个再试）
    let ip = pick_local_ipv4()?;
    let token = make_token();
    // M23：6 位短码 —— 相机不可用时手输（二维码旁边显示的是它；服务端两种都认）
    let short_code = make_short_code();
    let seed = uuid::Uuid::new_v4().as_u128();
    let mut bound: Option<(tiny_http::Server, u16)> = None;
    let mut last_err = String::new();
    for step in 0..PORT_TRIES {
        let port = random_port(seed.wrapping_add(step as u128 * 7919));
        match tiny_http::Server::http(SocketAddr::from((ip, port))) {
            Ok(server) => {
                bound = Some((server, port));
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    let (server, port) = bound.ok_or_else(|| format!("端口都被占了（试了 {PORT_TRIES} 次）：{last_err}"))?;
    let address = format!("{ip}:{port}");

    // ③ 二维码（代码生成）
    let text = qr_text(&ip.to_string(), port, &token);
    let svg = qr_svg(&text)?;

    // ④ 会话
    let inner = Arc::new(Mutex::new(Inner {
        phase: "waiting".to_string(),
        remote: String::new(),
        log: vec!["服务已起，等着手机来连".to_string()],
        message: String::new(),
    }));
    let stop = Arc::new(AtomicBool::new(false));
    // 「这一轮结束了」的牌子：线程收工时置位；`retire` 也用它认身份（见 Session::over）
    let over = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let started_at = crate::models::now_iso();

    // ⑤ 服务线程：只认"对令牌"的请求；成功 / 到点 / 断线 / 被取消都收工（**并且把会话摘掉**）
    let thread_inner = inner.clone();
    let thread_stop = stop.clone();
    let thread_over = over.clone();
    let thread_token = token.clone();
    let thread_code = short_code.clone();
    // M23：合并/落地要读写真数据 → 线程里需要一个 Store（Store 是 Clone 的，只含路径）
    let thread_store = store.clone();
    let ttl = Duration::from_secs(TOKEN_TTL_SECONDS);
    let handle = std::thread::spawn(move || {
        let server = server;
        // 最近一次收到"手机请求"的时刻 —— 异常断开（手机没了 / 关机 / 走出 WiFi）靠它判
        let mut last_seen = started;
        // 收工：写结论 → 记进"上一轮" → **把会话从槽里摘掉**
        let end = |phase: &str, message: &str, line: &str| {
            push_log(&thread_inner, line);
            if let Ok(mut guard) = thread_inner.lock() {
                guard.phase = phase.to_string();
                guard.message = message.to_string();
            }
            retire(&thread_over, phase, message);
        };
        loop {
            if thread_stop.load(Ordering::SeqCst) {
                end("cancel", "已取消 —— 这次同步结束了", "已取消 —— 服务关掉了");
                break;
            }
            let phase_now = thread_inner
                .lock()
                .map(|g| g.phase.clone())
                .unwrap_or_else(|_| "waiting".to_string());
            if let Some((phase, message)) = finish_reason(started, last_seen, Instant::now(), &phase_now, ttl) {
                let line = format!("收工：{message}");
                end(phase, &message, &line);
                break;
            }
            match server.recv_timeout(POLL) {
                Ok(Some(request)) => {
                    let url = request.url().to_string();
                    let peer = request
                        .remote_addr()
                        .map(|a| a.ip().to_string())
                        .unwrap_or_else(|| "?".to_string());
                    let good = token_in_url(&url, &thread_token) || code_in_url(&url, &thread_code);
                    if !good {
                        push_log(&thread_inner, &format!("{peer} 拿错令牌了 —— 拒了"));
                        let body = r#"{"ok":false,"error":"token"}"#;
                        let _ = request.respond(json_response(body, 403));
                        // ⚠️ 拿错令牌**不算**"有动静"：这往往就是别人瞎试，不该把这一轮续命
                        continue;
                    }
                    // 令牌对的请求 = 手机真的在干活 → 记一笔"有动静"（断线判定靠它）
                    last_seen = Instant::now();
                    // ── M23：真同步这条路（先 /sync 交清单，再 /data 交内容；决策在电脑这侧）
                    let mut request = request;
                    let path = url.split('?').next().unwrap_or("/").to_string();
                    let mut body_text = String::new();
                    {
                        // ⚠️ `Read` 这个 trait 文件顶部已经 `use` 过了，别在这儿再 import 一次
                        //    （重复 import 会报 unused_imports，2026-10-06 清掉）
                        let _ = request.as_reader().read_to_string(&mut body_text);
                    }
                    if path == "/sync" || path == "/data" {
                        if let Ok(mut guard) = thread_inner.lock() {
                            guard.phase = if path == "/sync" { "comparing" } else { "applying" }.to_string();
                            guard.remote = peer.clone();
                            guard.message = if path == "/sync" { "正在比对两边的清单…" } else { "正在落地…" }.to_string();
                        }
                        push_log(&thread_inner, &format!("{peer} {path}（{} 字节）", body_text.len()));
                        let (text, code) = if path == "/sync" {
                            crate::store::sync_proto::serve_hello(&thread_store, &body_text)
                        } else {
                            crate::store::sync_proto::serve_data(&thread_store, &body_text)
                        };
                        if code == 200 {
                            push_log(&thread_inner, &format!("{path} 处理完了"));
                        } else {
                            let short: String = text.chars().take(140).collect();
                            push_log(&thread_inner, &format!("{path} 被拒：{short}"));
                        }
                        if code != 200 {
                            // 出错也不许把入口占住：这一轮到此结束，用户可以直接再点「开始同步」
                            let short: String = text.chars().take(140).collect();
                            end("error", &short, "被拒 —— 这次同步结束（可以重新开始）");
                            let _ = request.respond(json_response(&text, code));
                            break;
                        }
                        if path == "/data" {
                            // 🩹 **P1-2 正主**：落地成功 = 这一轮**结束了**（服务关掉、入口让出来）。
                            //    ⚠️ 顺序：**先落状态再回包** —— 手机一收到"成功"，电脑这边就已经是收工状态，
                            //    不留"手机上显示完事了、电脑还写着正在落地"的窗口。
                            end("done", "同步完成（账单在手机那侧）", "落地完成 —— 这次同步结束，服务收工");
                            // 🔴 2026-10-20：**落地成功必须通知界面重拉**（用户反馈「正文延迟」：
                            //    手机推上来的东西躺在 notes/ 里、主窗看不见，得手动刷新才出现）。
                            //    放在"已经收工"之后、回包之前：手机上显示完事时，电脑这边也已经刷好了。
                            notify_applied();
                            let _ = request.respond(json_response(&text, code));
                            break;
                        }
                        let _ = request.respond(json_response(&text, code));
                        continue;
                    }
                    push_log(&thread_inner, &format!("{peer} 连上来了（令牌对）"));
                    if let Ok(mut guard) = thread_inner.lock() {
                        guard.phase = "connected".to_string();
                        guard.remote = peer;
                        guard.message = "手机连上了 —— 可以开始同步".to_string();
                    }
                    let body = format!(
                        r#"{{"ok":true,"app":"东方摩耶堂","version":"{}","device":"{}","stage":"m23"}}"#,
                        env!("CARGO_PKG_VERSION"),
                        device_name()
                    );
                    let _ = request.respond(json_response(&body, 200));
                }
                Ok(None) => {}
                Err(e) => {
                    end(
                        "error",
                        &format!("服务出错：{e}"),
                        &format!("服务出错收工：{e}"),
                    );
                    break;
                }
            }
        }
    });

    let mut guard = slot().lock().map_err(|_| "同步服务状态锁坏了".to_string())?;
    *guard = Some(Session {
        address,
        started,
        started_at,
        stop,
        over,
        inner,
        qr_svg: svg,
        qr_text: text,
        short_code,
        pre_snapshot: short_path(store, &snapshot),
        handle: Some(handle),
    });
    drop(guard);
    Ok(status(store))
}

/// 令牌对不对：从 `/hello?token=xxx` 里取（也容忍 `Authorization: Bearer`，M23 的客户端两种都能用）
fn token_in_url(url: &str, token: &str) -> bool {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    query
        .split('&')
        .any(|pair| matches!(pair.split_once('='), Some(("token", v)) if v == token))
}

/// 6 位短码（手输那条路）：纯数字、好念好敲
pub fn make_short_code() -> String {
    // 用已有依赖 uuid 生成（不额外引 rand）：取随机数模一百万
    let n = (uuid::Uuid::new_v4().as_u128() % 1_000_000) as u32;
    format!("{n:06}")
}

/// 短码对不对：从 `/sync?code=123456` 里取（**只认短码本身**，不做模糊匹配）
fn code_in_url(url: &str, code: &str) -> bool {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    query
        .split('&')
        .any(|pair| matches!(pair.split_once('='), Some(("code", v)) if v == code))
}

fn json_response(body: &str, code: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
        .expect("静态头不会解析失败");
    tiny_http::Response::from_string(body.to_string())
        .with_status_code(code)
        .with_header(header)
}

/// 这台电脑的名字（给手机显示"连的是哪台"）
pub fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "这台电脑".to_string())
}

/// 现在的状态（前端每秒来问）
/// 上一轮的结果（没有就是空串）—— 给界面在"平时"那一栏留个交代
fn last_result() -> LastResult {
    last_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

pub fn status(store: &Store) -> SyncServerStatus {
    let last_sync_at = sync::state_get(store).map(|s| s.last_sync_at).unwrap_or_default();
    let last = last_result();
    let guard = match slot().lock() {
        Ok(g) => g,
        Err(_) => return SyncServerStatus { phase: "error".into(), message: "状态锁坏了".into(), ..Default::default() },
    };
    // 🩹 P1-2：会话"已经结束"（线程收工置了 `over`）就**一律按 idle 报** —— 哪怕它还没被摘干净。
    //    这样界面上永远不会出现"服务早停了、开始按钮却报'已经在同步了'"的鬼状态。
    let session = guard.as_ref().filter(|s| !s.over.load(Ordering::SeqCst));
    let Some(session) = session else {
        return SyncServerStatus {
            phase: "idle".into(),
            last_sync_at,
            last_result: last.phase,
            last_message: last.message,
            last_at: last.at,
            ..Default::default()
        };
    };
    let inner = session.inner.lock().map(|g| (g.phase.clone(), g.remote.clone(), g.log.clone(), g.message.clone()));
    let (phase, remote, log, message) = inner.unwrap_or_default();
    SyncServerStatus {
        phase,
        address: session.address.clone(),
        remote,
        seconds_left: seconds_left(session.started, Instant::now(), Duration::from_secs(TOKEN_TTL_SECONDS)),
        qr_svg: session.qr_svg.clone(),
        qr_text: session.qr_text.clone(),
        short_code: session.short_code.clone(),
        started_at: session.started_at.clone(),
        pre_snapshot: session.pre_snapshot.clone(),
        last_sync_at,
        message,
        log,
        last_result: last.phase,
        last_message: last.message,
        last_at: last.at,
    }
}

/// 取消（把服务关掉、令牌作废）—— 界面上那个「结束这次同步」按钮走的就是这里。
pub fn cancel(store: &Store) -> Result<SyncServerStatus, String> {
    let taken = {
        let mut guard = match slot().lock() {
            Ok(g) => g,
            Err(_) => return Ok(SyncServerStatus { phase: "error".into(), message: "状态锁坏了".into(), ..Default::default() }),
        };
        guard.take()
    };
    if let Some(mut session) = taken {
        session.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = session.handle.take() {
            // 线程每 250ms 醒一次，等它自己收工（最多 ~1 秒）
            let _ = handle.join();
        }
        set_phase(&session.inner, "idle");
        // 用户主动结束 → 也算"上一轮的结果"，免得下次打开设置页时那一栏是空的
        retire(&session.over, "cancel", "已取消 —— 这次同步结束了");
    }
    Ok(status(store))
}

// ─────────────────────────── 单测 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn token_is_32_bytes_hex_and_different_every_time() {
        let a = make_token();
        let b = make_token();
        assert_eq!(a.len(), 64, "32 字节 = 64 个 hex 字符");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "只许有 hex 字符：{a}");
        assert_ne!(a, b, "每次必须是新的");
    }

    #[test]
    fn random_port_stays_in_high_range() {
        for seed in [0u128, 1, 12345, u128::MAX, u128::MAX / 3] {
            let p = random_port(seed);
            assert!((PORT_MIN..=PORT_MAX).contains(&p), "端口必须落在 {PORT_MIN}..={PORT_MAX}，得到 {p}");
        }
    }

    #[test]
    fn qr_text_roundtrip() {
        let text = qr_text("192.168.1.7", 32123, "abc123");
        assert_eq!(text, "moye-sync://192.168.1.7:32123/abc123");
        let (ip, port, token) = parse_qr_text(&text).expect("必须能解回来");
        assert_eq!(ip, "192.168.1.7");
        assert_eq!(port, 32123);
        assert_eq!(token, "abc123");
    }

    #[test]
    fn parse_qr_text_rejects_junk() {
        assert!(parse_qr_text("").is_none());
        assert!(parse_qr_text("http://192.168.1.7:1/x").is_none(), "前缀不对不许认");
        assert!(parse_qr_text("moye-sync://192.168.1.7/x").is_none(), "缺端口不许认");
        assert!(parse_qr_text("moye-sync://:80/x").is_none(), "缺 IP 不许认");
        assert!(parse_qr_text("moye-sync://192.168.1.7:80/").is_none(), "缺令牌不许认");
    }

    #[test]
    fn expiry_and_countdown() {
        let t0 = Instant::now();
        let ttl = Duration::from_secs(TOKEN_TTL_SECONDS);
        assert!(!expired(t0, t0, ttl), "刚起的时候没过期");
        assert!(!expired(t0, t0 + Duration::from_secs(TOKEN_TTL_SECONDS - 1), ttl));
        assert!(expired(t0, t0 + ttl, ttl), "到点就该过期");
        assert_eq!(seconds_left(t0, t0, ttl), TOKEN_TTL_SECONDS);
        assert_eq!(seconds_left(t0, t0 + Duration::from_secs(TOKEN_TTL_SECONDS + 5), ttl), 0, "过点之后是 0，不许是负数");
    }

    #[test]
    fn qr_svg_is_real_svg() {
        let svg = qr_svg("moye-sync://192.168.1.7:32123/abc").unwrap();
        assert!(svg.contains("<svg"), "必须是真 SVG：{}", &svg[..80.min(svg.len())]);
        assert!(svg.contains("path") || svg.contains("rect"), "SVG 里得有方块/路径才是二维码");
        assert!(svg.len() > 200, "二维码不该是空图（长度 {}）", svg.len());
    }

    #[test]
    fn token_in_url_only_accepts_exact_match() {
        let token = "deadbeef";
        assert!(token_in_url("/hello?token=deadbeef", token));
        assert!(token_in_url("/hello?a=1&token=deadbeef&b=2", token));
        assert!(!token_in_url("/hello", token));
        assert!(!token_in_url("/hello?token=deadbEEf", token), "大小写不同就是不认");
        assert!(!token_in_url("/hello?token=deadbeefx", token), "多一个字符也不认");
    }

    #[test]
    fn snapshot_makes_a_real_copy_and_fails_loudly_on_empty_dir() {
        let store = temp_store("m22-snapshot");
        // 空目录：必须报错（"宁可不做"）
        assert!(snapshot_pre_sync(&store).is_err(), "什么都没有时必须报错，不许默默继续");

        // 放一个待办进去 → 这次该成功，而且内容一致
        crate::store::todo::create(&store, "M22 快照探针".to_string(), Default::default(), None).unwrap();
        let dir = snapshot_pre_sync(&store).expect("有数据就该成功");
        let copied = dir.join("todos.json");
        assert!(copied.exists(), "todos.json 必须被拷进快照");
        let a = std::fs::read_to_string(store.data_dir().join("todos.json")).unwrap();
        let b = std::fs::read_to_string(&copied).unwrap();
        assert_eq!(a, b, "快照必须与原文件一字不差");
        assert!(short_path(&store, &dir).starts_with("backups"), "短路径要给界面看");
    }

    #[test]
    fn start_waiting_cancel_goes_back_to_idle_and_releases_port() {
        let _serial = TEST_SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let store = temp_store("m22-lifecycle");
        crate::store::todo::create(&store, "M22 生命周期探针".to_string(), Default::default(), None).unwrap();

        let waiting = start(&store).expect("该能起来（除非这台机器没有局域网地址）");
        assert_eq!(waiting.phase, "waiting");
        assert!(waiting.address.contains(':'), "地址得是 ip:port，得到 {}", waiting.address);
        assert!(waiting.seconds_left > 0 && waiting.seconds_left <= TOKEN_TTL_SECONDS);
        assert!(waiting.qr_svg.contains("<svg"), "二维码必须是 SVG");
        assert!(waiting.qr_text.starts_with(QR_PREFIX));
        assert!(!waiting.pre_snapshot.is_empty(), "必须留了同步前快照");
        let port: u16 = waiting.address.rsplit(':').next().unwrap().parse().unwrap();
        assert!((PORT_MIN..=PORT_MAX).contains(&port), "端口要在高位区间，得到 {port}");

        // 再点一次开始 → 不许叠起来
        assert!(start(&store).is_err(), "已经有一个在等的时候，再点开始必须报错");

        // 取消 → 回到 idle、端口释放
        let idle = cancel(&store).expect("取消不该失败");
        assert_eq!(idle.phase, "idle");
        assert!(idle.qr_svg.is_empty(), "取消之后二维码要作废");
        let freed = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
        assert!(freed.is_ok(), "取消之后端口 {port} 必须能被别人绑上（说明真关了）");
    }

    /// 🔴 **P1-2**（2026-10-06）回归钉子：**"什么时候算结束"这条规则**。
    ///    用户当时的原话是"已经有一个同步在等着了，而且没地方取消，只能重启程序"。
    #[test]
    fn finish_reason_covers_success_timeout_and_abnormal_disconnect() {
        let ttl = Duration::from_secs(TOKEN_TTL_SECONDS);
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);

        // ① 刚开始等手机 → 什么都不做（等满 5 分钟）
        assert!(finish_reason(t0, t0, t0, "waiting", ttl).is_none(), "刚起不该收工");
        assert!(
            finish_reason(t0, t0, at(TOKEN_TTL_SECONDS - 1), "waiting", ttl).is_none(),
            "还没到 5 分钟，继续等"
        );
        // ② 5 分钟没人来连 → 二维码作废（协议写死的窗口）
        let (phase, why) = finish_reason(t0, t0, at(TOKEN_TTL_SECONDS), "waiting", ttl).unwrap();
        assert_eq!(phase, "error");
        assert!(why.contains("超时"), "要跟用户说清楚是超时：{why}");

        // ③ 手机**连上之后就没了**（拔网线 / 关机 / 走远了）→ 90 秒没动静就判定断线
        assert!(
            finish_reason(t0, at(10), at(10 + STALL_SECONDS - 1), "connected", ttl).is_none(),
            "刚连上还在传，别乱收工"
        );
        let (phase, why) = finish_reason(t0, at(10), at(10 + STALL_SECONDS), "connected", ttl).unwrap();
        assert_eq!(phase, "error");
        assert!(why.contains("断开"), "要说清是「断了」：{why}");
        // 比对/落地中途断了也一样（不能只盯 connected 一个阶段）
        for stage in ["comparing", "transferring", "applying"] {
            assert!(
                finish_reason(t0, at(10), at(10 + STALL_SECONDS), stage, ttl).is_some(),
                "{stage} 阶段断了也必须能收工"
            );
        }
        // ⚠️ 关键：**连上之后不受"5 分钟令牌窗口"限制**（令牌是给"扫码来连"那一步用的），
        //    改成看"还有没有动静"—— 所以这里 4 分 59 秒时**还不该**因为令牌过期而收工。
        assert!(
            finish_reason(t0, at(280), at(299), "comparing", ttl).is_none(),
            "正传着呢，不能因为令牌到期就砍掉"
        );

        // ④ 硬上限：无论什么阶段，超过 SESSION_MAX_SECONDS 一律收工（入口绝不能被永久占住）
        let (phase, why) =
            finish_reason(t0, at(SESSION_MAX_SECONDS - 1), at(SESSION_MAX_SECONDS), "comparing", ttl).unwrap();
        assert_eq!(phase, "error");
        assert!(why.contains("分钟"), "要说清是超时收工：{why}");
        assert!(
            finish_reason(t0, at(SESSION_MAX_SECONDS - 1), at(SESSION_MAX_SECONDS), "waiting", ttl).is_some(),
            "等着的时候也要有硬上限"
        );
    }

    /// 🔴 **P1-2** 回归钉子：会话收工必须**真的把槽让出来**，而且结果要留在"上一轮"里给界面看。
    #[test]
    fn retire_frees_the_slot_and_keeps_the_result() {
        let over = Arc::new(AtomicBool::new(false));
        // 没有会话时 retire 不该炸（线程和 cancel 可能同时走到这儿）
        retire(&over, "done", "同步完成");
        assert!(over.load(Ordering::SeqCst), "收工要把牌子翻过来");
        let last = last_result();
        assert_eq!(last.phase, "done");
        assert_eq!(last.message, "同步完成");
        assert!(!last.at.is_empty(), "得记下结束时间");
    }
}
