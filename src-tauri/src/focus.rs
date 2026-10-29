//! 专注计时的「**意外中断**」判定（M13-B）。
//!
//! 用户要的是：一次番茄里**到底有没有被打断**、被打断了多久。程序自己不猜"你在不在干活"，
//! 它只看两件客观的事：
//! ① **键鼠多久没动**（超过阈值 = 疑似离开，累计秒数 + 次数）；
//! ② **锁屏 / 休眠**（用户 2026-09-26 定：**只有这两种**才自动暂停 —— 切窗口、发呆都不算）。
//!
//! 分两层写，这条是这次改动最要紧的规矩：
//! - **计账层**（[`Tracker`]）是**纯函数逻辑**：喂 [`Sample`] 进去，数字出来。**不碰任何 Win32**，
//!   所以单测能直接构造"睡了一晚 `dt=600`"这种场景（真跑一遍要等 10 分钟，还没法验）。
//! - **采样层**（`probe`）才是 Win32：读键鼠空闲秒数、读"当前输入桌面是不是锁屏"。
//!   ⚠️ **所有 Win32 调用都不许 panic**：拿不到就当 0 / false —— 探个空闲时间失败
//!   绝不能把整个应用带崩（这条比"数据准"重要）。
//!
//! 会话：同一时刻只有**一个**专注会话（用户一次只做一件事）。
//! 状态放模块内的 `static Mutex`，由 [`start`] / [`stop`] / [`snapshot`] 读写；
//! [`spawn_monitor`] 起的后台线程每秒采一次样喂进去，并往**主窗**广播 `focus-tick`。

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// 采样间隔：1 秒（前端进度条按这个粒度刷新足够）
const TICK: Duration = Duration::from_secs(1);

/// 超过这个秒数没被采样 = **这一段时间进程根本没在跑**（休眠 / 待机 / 被系统挂起）。
///
/// 为什么是 3：正常的采样抖动、系统忙一下也就几十毫秒到一两秒，
/// 真睡过去一定是几十秒几百秒的量级 —— 3 秒这个坎两边都够远。
const SLEEP_GAP_SECONDS: u64 = 3;

/// 每秒采一次样得到的输入（**刻意都是"已经算好的数"**，不含任何平台细节）
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// 距离上一次采样过了多少秒
    pub dt: u64,
    /// 键鼠已经空闲了多少秒
    pub idle: u64,
    /// 这一秒屏幕是锁着的吗
    pub locked: bool,
}

/// 计账器：把一串 [`Sample`] 变成"暂停多久 / 疑似离开多久、几次"。
///
/// ⚠️ 优先级是**睡过 > 锁屏 > 疑似离开**（见 [`Tracker::tick`]）：
/// 锁着屏的时候键鼠当然也不动，但那是"暂停"，不该同时算成"人不在"。
pub struct Tracker {
    threshold: u64,
    pause_on_lock: bool,
    paused: bool,
    pause_reason: &'static str,
    paused_seconds: u64,
    interrupted_seconds: u64,
    interrupted_times: u32,
    idle: u64,
    away: bool,
    /// 🔴 **开场那一刻人已经离开多久**（2026-10-02 加的基线，理由见 [`start`]）。
    ///
    /// 判定一律用 `idle - start_idle` —— 开场前三小时没动过键鼠，也不会一开局就算"这次被打断了"。
    /// 多个会话共用同一个 tracker 的**单测**直接传 0。
    start_idle: u64,
    /// **从开场算起的**空闲秒数（判定用）—— 就是 `idle - start_idle`。
    ///
    /// ⚠️ 为什么不复用 `idle`：那个是**给界面看的真实系统空闲**（「疑似离开 5 分 12 秒」得是真数字）。
    ///    2026-10-02 把两者混成一个字段，结果"系统空闲涨了、界面上却是 0"（M13 的 ㉕ 逮到）。
    idle_since_start: u64,
}

impl Tracker {
    /// `threshold_seconds` = 多久没动键鼠算疑似离开。
    ///
    /// 0 会被抬到 1：阈值 0 等于"一直算离开"，那不是用户能表达的意思，
    /// 多半是配置写坏了 —— 宁可按 1 秒算，也别让界面永远显示"疑似离开"。
    ///
    /// `start_idle` = **开场时系统已经空闲了多少秒**（真实会话传探头读到的那个值）。
    pub fn new(threshold_seconds: u64, pause_on_lock: bool, start_idle: u64) -> Self {
        Self {
            threshold: threshold_seconds.max(1),
            pause_on_lock,
            paused: false,
            pause_reason: "",
            paused_seconds: 0,
            interrupted_seconds: 0,
            interrupted_times: 0,
            idle: 0,
            away: false,
            start_idle,
            idle_since_start: 0,
        }
    }

    /// 喂一秒的采样。规则见模块头与下面的分步注释（验收会逐条查这几条）。
    pub fn tick(&mut self, s: Sample) {
        // ⚠️ 两个 idle 要分开（2026-10-02 踩过一次）：
        // - **判"有没有疑似离开"** 用 `idle`（= 系统空闲 − 开场基线）→ 开场前空闲 3 小时也不算这次被打断；
        // - **对外显示 / 上报** 用 `s.idle`（真实系统空闲）→ 界面上「疑似离开 N 分」得是真数字，
        //   否则用户会看到"系统明明空闲了 5 秒、界面上却是 0"（第一版就是这么错的，被 M13 逮到）。
        let idle = s.idle.saturating_sub(self.start_idle);
        self.idle = s.idle;                  // 显示用：真实系统空闲
        self.idle_since_start = idle;        // 判定用：从开场算起

        // ① 睡过 / 被挂起：这一段进程根本没跑。
        //    只记 `dt - 1`：恢复的那一秒本来就是一个正常的采样间隔，
        //    把它也算成"暂停"会让每次唤醒都白多一秒。
        if s.dt > SLEEP_GAP_SECONDS {
            self.paused = true;
            self.pause_reason = "sleep";
            self.paused_seconds += s.dt - 1;
            self.away = false;
            return;
        }

        // ② 锁屏：只在设置里开着「锁屏自动暂停」时才算暂停；
        //    关掉它就照 ③ 走（人锁了屏但程序不管，键鼠没动照样算疑似离开）。
        if s.locked && self.pause_on_lock {
            self.paused = true;
            self.pause_reason = "lock";
            self.paused_seconds += s.dt;
            self.away = false;
            return;
        }

        // ③ 没暂停，才轮到"疑似离开"。走到这里就是恢复：清掉暂停状态（规则 6）。
        self.paused = false;
        self.pause_reason = "";
        if idle >= self.threshold {
            self.interrupted_seconds += s.dt;
            // **只在跨过阈值的那一秒**记一次次数：判据是"上一秒还没到、这一秒到了"。
            // 少了这个判断，人在外面待 10 分钟会被记成 600 次"被打断"。
            if idle.saturating_sub(s.dt) < self.threshold {
                self.interrupted_times = self.interrupted_times.saturating_add(1);
            }
            self.away = true;
        } else {
            self.away = false;
        }
    }

    /// 现在是不是暂停中（锁屏 / 睡过）
    pub fn paused(&self) -> bool {
        self.paused
    }

    /// 暂停原因：`""`（没暂停）｜`"lock"`（锁屏）｜`"sleep"`（休眠 / 被挂起）
    pub fn pause_reason(&self) -> &'static str {
        self.pause_reason
    }

    /// 暂停累计秒数
    pub fn paused_seconds(&self) -> u64 {
        self.paused_seconds
    }

    /// 疑似离开累计秒数
    pub fn interrupted_seconds(&self) -> u64 {
        self.interrupted_seconds
    }

    /// 疑似离开的**次数**（跨过阈值才算一次）
    pub fn interrupted_times(&self) -> u32 {
        self.interrupted_times
    }

    /// 现在算不算"疑似离开"（暂停中一律不算）
    pub fn away_now(&self) -> bool {
        !self.paused && self.idle_since_start >= self.threshold
    }

    /// 最近一次采样时键鼠空闲了多少秒（**系统真实空闲**，界面显示用）
    pub fn idle_seconds(&self) -> u64 {
        self.idle
    }

    /// **从这次会话开始算起**的空闲秒数 —— 判定"疑似离开"用的就是它。
    ///
    /// ⚠️ 跟 [`Tracker::idle_seconds`] 的区别：那个是系统真实空闲（界面要显示"你到底多久没动键鼠"）；
    /// 这个是"这次专注里你离开了多久"（**开场前的空闲不算**）。
    /// 2026-10-02 只报了一个值，验收脚本读到"空闲 34 秒却没判成疑似离开"就误判成 bug ——
    /// 现在两个都对外报（`FocusSnapshot` 里叫 `idleSeconds` / `idleSinceStartSeconds`）。
    pub fn idle_since_start(&self) -> u64 {
        self.idle_since_start
    }
}

// ─────────────────────────── 采样层（Windows） ───────────────────────────

/// 平台探测：**只读两个事实**（键鼠空闲秒数 / 是不是锁着屏）。
///
/// ⚠️ 这里的每个函数都必须"失败也不 panic"：拿不到就返回 0 / false。
#[cfg(windows)]
mod probe {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_SWITCHDESKTOP,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    /// 键鼠空闲秒数。
    ///
    /// ⚠️ `GetTickCount()` 是**32 位毫秒**、约 49.7 天回绕一次，
    /// 所以相减**必须** `wrapping_sub` —— 用普通减法会在回绕那一刻得到一个天文数字，
    /// 那一秒会被当成"睡过了"记进暂停里。
    pub fn idle_seconds() -> u64 {
        unsafe {
            let mut info = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if GetLastInputInfo(&mut info) == 0 {
                // 调不通就当"刚动过"：报假的中断比漏报更烦人
                return 0;
            }
            GetTickCount().wrapping_sub(info.dwTime) as u64 / 1000
        }
    }

    /// 现在锁屏了吗？
    ///
    /// 判据：能不能打开**当前输入桌面**。锁屏时它切到了 Winlogon 桌面，
    /// 普通权限的进程打不开 → `OpenInputDesktop` 返回 0。
    /// ⚠️ 打开成功**必须** `CloseDesktop` 关掉：这是内核句柄，每秒泄漏一个很快就完蛋。
    pub fn locked() -> bool {
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if desktop.is_null() {
                return true;
            }
            CloseDesktop(desktop);
            false
        }
    }
}

/// 非 Windows 的兜底：没有这两个系统调用可问，就永远"刚动过、没锁屏"。
///
/// 有它 `cargo check` 在任何平台都能过（本机是 Windows，这层只是保险）；
/// 业务上等于"不判中断、不自动暂停"，比瞎猜一个数字强。
#[cfg(not(windows))]
mod probe {
    pub fn idle_seconds() -> u64 {
        0
    }

    pub fn locked() -> bool {
        false
    }
}

// ─────────────────────────── 会话 ───────────────────────────

/// 给事件 / 命令用的快照（字段一律 `camelCase`，与前端 TS 类型一一对应）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSnapshot {
    pub active: bool,
    pub todo_id: String,
    pub paused: bool,
    /// `""`（没暂停）｜`"lock"`（锁屏）｜`"sleep"`（休眠 / 被挂起）
    pub pause_reason: String,
    pub paused_seconds: u64,
    pub interrupted_seconds: u64,
    pub interrupted_times: u32,
    pub idle_seconds: u64,
    /// ⚠️ 2026-10-02 新增：**从这次会话开始算起**的空闲秒数（判定"疑似离开"用的那个）。
    /// 跟 `idle_seconds`（系统真实空闲）差一个"开场基线"——验收脚本要分别核对两者。
    pub idle_since_start_seconds: u64,
    pub away_now: bool,
}

/// 一次专注会话（同一时刻最多一个）
struct Session {
    todo_id: String,
    tracker: Tracker,
}

/// 全局会话状态。用 `OnceLock` 而不是 `lazy_static`：标准库够了，不引新依赖。
fn session() -> &'static Mutex<Option<Session>> {
    static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

/// **最近一次结算**（[`stop`]）留下的那份快照。
///
/// 🔴 2026-10-05 加：修"合盖睡一觉之后，番茄被记成 4 秒、暂停 0"那个 bug（v1.14.0）。
///
/// 结算的调用顺序是"前端先 `focus_monitor_stop()` 拿数字、再 `todo_add_pomodoro` 记账"，
/// 所以记账那一刻**会话已经没了** —— 这时候 `snapshot()` 只能读到空快照（全 0）。
/// 以前记账命令的参数缺省就是 0，于是**只要前端手里那份数字丢了（窗口被挂起/重建、进程重启），
/// 后端明明算对过的暂停秒数就被写成 0**。
///
/// 留一份"最后一次结算"在这里，记账时就能把该有的数字补回来 —— 这不是猜，
/// 而是把**同一场专注**已经算出来的事实捡回来。
fn last_settled() -> &'static Mutex<Option<FocusSnapshot>> {
    static LAST: OnceLock<Mutex<Option<FocusSnapshot>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// 把一份刚结算完的快照记成"最后一次"（[`stop`] 里调）
fn remember_settled(done: &FocusSnapshot) {
    match last_settled().lock() {
        Ok(mut guard) => *guard = Some(done.clone()),
        // ⚠️ 锁坏了只是"少了一份兜底"，绝不能让结算本身失败
        Err(e) => eprintln!("[东方摩耶堂] 专注结算记录锁异常（这次没留兜底）：{e}"),
    }
}

/// 读最近一次结算的快照（没结算过 / 锁坏了 = `None`）
pub fn settled_snapshot() -> Option<FocusSnapshot> {
    last_settled().lock().ok().and_then(|guard| guard.clone())
}

/// 结算时"暂停 / 疑似离开"这几个数字该取谁 —— **纯函数**，好测、不碰全局状态。
///
/// 规则只有一条：**只认同一个待办的那几份快照，按字段取最大值。**
///
/// 为什么是"取最大"而不是"相加/取第一个"：
/// - 候选们（实时会话的、最近一次结算的、前端手里那份）说的是**同一个事实** ——
///   相加会把 599 秒算成 1198 秒；
/// - 取 0 / 缺省才会把**已经发生过的暂停**抹掉（v1.14.0 修的就是这个）。
///
/// 返回 `(暂停秒数, 疑似离开秒数, 疑似离开次数)`。
pub fn best_effort(todo_id: &str, snaps: &[Option<FocusSnapshot>]) -> (u64, u64, u32) {
    let mut paused = 0u64;
    let mut interrupted = 0u64;
    let mut times = 0u32;
    for one in snaps.iter().flatten() {
        // ⚠️ 待办对不上就不用：那是**另一场**专注的数字，混进来就是张冠李戴
        if one.todo_id != todo_id {
            continue;
        }
        paused = paused.max(one.paused_seconds);
        interrupted = interrupted.max(one.interrupted_seconds);
        times = times.max(one.interrupted_times);
    }
    (paused, interrupted, times)
}

/// 开一次专注会话（重置计账）。`todo_id` 是这笔番茄记在谁头上。
///
/// ⚠️ 已经开着会话时**直接换掉**：前端重复点"开始"就该从头算，不是叠加。
///
/// 🔴 **2026-10-05（v1.14.1）例外：同一条待办重复 start = "把那一场接回来"，绝不清零。**
/// 用户实测的 bug：合盖睡一觉回来，那一场番茄凭空消失。修法是前端把会话存下来、
/// 重载后接回去；而"接回去"这件事在**进程重启**那条路上必然要再调一次 `start` ——
/// 若照旧新建一场，后端刚攒下的"睡了 300 秒"当场清零，等于把 bug 从左边挪到右边。
/// 所以：**todo_id 一样就只更新设置（阈值 / 锁屏暂停），计账器原样留着**。
///
/// 🔴 **2026-10-02 修的一个真缺口**：这里要把**"开场那一刻人已经离开多久"当成基线**记下来
/// （`start_idle`）。不记的话，只要用户是在"早就没动键鼠"的状态下点开始
/// （真用起来很常见：用键盘敲完就伸手点鼠标、或者刚离开座位回来顺手点一下），
/// 第一秒采到的 `idle` 就 ≥ 阈值 → **一开局就被判成"疑似离开"**，
/// 番茄还没开始走就弹结算卡（表现：小窗上的「结束」被结算卡顶掉，点不掉）。
/// 记了基线之后，`idle` 一律按"从开场算起"计，开场前三小时没动过也不算这次被打断。
pub fn start(todo_id: String, threshold: u64, pause_on_lock: bool) {
    let mut guard = match session().lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[东方摩耶堂] 专注会话状态锁异常（这次开始没生效）：{e}");
            return;
        }
    };
    let current = guard.as_ref().map(|session| session.todo_id.as_str());
    if reuses_session(current, &todo_id) {
        // 接回来：只把设置同步过去，**计账器一个字节都不动**
        if let Some(existing) = guard.as_mut() {
            existing.tracker.threshold = threshold;
            existing.tracker.pause_on_lock = pause_on_lock;
        }
        return;
    }
    *guard = Some(Session {
        todo_id,
        tracker: Tracker::new(threshold, pause_on_lock, probe::idle_seconds()),
    });
}

/// 这次 `start` 该不该**沿用**已有会话（而不是新开一场）？
///
/// 判据只有一条：**还是同一条待办**。换了待办就是新的一场（旧数字一律不带过来）。
/// 抽成纯函数是为了能直接写单测 —— 这段判断是"会话会不会被静默清零"的闸门（v1.14.1）。
fn reuses_session(current: Option<&str>, incoming: &str) -> bool {
    matches!(current, Some(id) if id == incoming)
}

/// 结束会话并返回**最终快照**（内部会话清掉，[`snapshot`] 随即变回空）。
///
/// 返回的这份带 `active = false`（会话确实已经结束了），但 `todoId` 与各项计数
/// **保留最后的值** —— 前端就是拿它去 `todo_add_pomodoro` 记账的。
pub fn stop() -> FocusSnapshot {
    let mut guard = match session().lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[东方摩耶堂] 专注会话状态锁异常（停不下来）：{e}");
            return empty_snapshot();
        }
    };
    match guard.take() {
        Some(session) => {
            let mut done = snapshot_of(&session.todo_id, &session.tracker);
            done.active = false;
            // 2026-10-05：留一份给 `todo_add_pomodoro` 兜底（见 `last_settled` 的注释）
            remember_settled(&done);
            done
        }
        None => empty_snapshot(),
    }
}

/// 只读当前状态：没会话时 `active=false`、`todoId=""`、各项全 0
pub fn snapshot() -> FocusSnapshot {
    let guard = match session().lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[东方摩耶堂] 专注会话状态锁异常（读到空状态）：{e}");
            return empty_snapshot();
        }
    };
    match guard.as_ref() {
        Some(session) => snapshot_of(&session.todo_id, &session.tracker),
        None => empty_snapshot(),
    }
}

/// 没会话时的空快照
fn empty_snapshot() -> FocusSnapshot {
    FocusSnapshot {
        active: false,
        todo_id: String::new(),
        paused: false,
        pause_reason: String::new(),
        paused_seconds: 0,
        interrupted_seconds: 0,
        interrupted_times: 0,
        idle_seconds: 0,
        idle_since_start_seconds: 0,
        away_now: false,
    }
}

/// 把计账器读成一份快照（会话在跑时 `active` 恒为 true）
fn snapshot_of(todo_id: &str, tracker: &Tracker) -> FocusSnapshot {
    FocusSnapshot {
        active: true,
        todo_id: todo_id.to_string(),
        paused: tracker.paused(),
        pause_reason: tracker.pause_reason().to_string(),
        paused_seconds: tracker.paused_seconds(),
        interrupted_seconds: tracker.interrupted_seconds(),
        interrupted_times: tracker.interrupted_times(),
        idle_seconds: tracker.idle_seconds(),
        idle_since_start_seconds: tracker.idle_since_start(),
        away_now: tracker.away_now(),
    }
}

// ─────────────────────────── 后台采样线程 ───────────────────────────

/// 起后台线程：**每 1 秒**采一次样喂给计账器，并且**每一 tick 都往主窗广播**
/// `focus-tick`（前端小窗/主窗据此更新"疑似离开 / 暂停中"）。
///
/// 规则：
/// - 没有会话时**照旧每秒醒一下**（好让"睡过了多久"在下次开始时是连续的），
///   但**不发事件** —— 一秒一条空事件会把前端刷爆；
/// - 采样 / 广播出问题只留痕，**绝不让线程死掉**（跟 `scheduler::spawn` 一个道理）。
pub fn spawn_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = Instant::now();
        // 不足 1 秒的零头留到下一秒，别把时间"吃"掉（睡 999ms 会被算成 0 秒）
        let mut carry_ms: u64 = 0;
        let mut warned = false;

        loop {
            std::thread::sleep(TICK);
            let now = Instant::now();
            carry_ms += now.duration_since(last).as_millis() as u64;
            last = now;
            let dt = carry_ms / 1000;
            carry_ms -= dt * 1000;
            if dt == 0 {
                continue;
            }

            let mut guard = match session().lock() {
                Ok(guard) => guard,
                Err(e) => {
                    eprintln!("[东方摩耶堂] 专注会话状态锁异常（这一秒跳过）：{e}");
                    continue;
                }
            };
            let snapshot = match guard.as_mut() {
                Some(session) => {
                    session.tracker.tick(Sample {
                        dt,
                        idle: probe::idle_seconds(),
                        locked: probe::locked(),
                    });
                    snapshot_of(&session.todo_id, &session.tracker)
                }
                None => continue,
            };
            drop(guard);

            if let Err(e) = app.emit_to("main", "focus-tick", &snapshot) {
                // 主窗还没建好 / 刚被销毁时这里会失败。只抱怨一次：
                // 否则每秒往日志里灌一行，真出问题反而看不见。
                if !warned {
                    eprintln!("[东方摩耶堂] 广播 focus-tick 失败（后面不再重复报）：{e}");
                    warned = true;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一秒采样（`locked` 默认 false，省得每个用例都写一遍）
    fn sample(dt: u64, idle: u64, locked: bool) -> Sample {
        Sample { dt, idle, locked }
    }

    /// 🔴 2026-10-02（B 批验收逮到的真缺口）：**开场时人已经离开很久 → 不许一开局就算被打断**。
    ///
    /// 真用起来很常见：用键盘敲完伸手点鼠标、或刚从外面回来顺手点「开始」——
    /// 那一刻系统空闲可能早就几十分钟。没有"开场基线"的话，第一秒 `idle` ≥ 阈值，
    /// 番茄还没走就弹结算卡（表现：小窗上的「结束」被结算卡顶掉，点不掉）。
    #[test]
    fn 开场时就空闲很久_也不算这次被打断() {
        // 开场那一刻系统已经空闲 3600 秒
        let mut tracker = Tracker::new(90, true, 3600);

        // 第一秒：系统还是空闲 3600 —— **本次离开时长是 0**
        tracker.tick(sample(1, 3600, false));
        assert_eq!(tracker.interrupted_seconds(), 0, "开场前的空闲不算这一次");
        assert_eq!(tracker.interrupted_times(), 0);
        assert!(!tracker.away_now(), "刚开场不该显示「疑似离开」");
        // ⚠️ 但**对外报的空闲秒数仍是真实的**（界面上要显示"你到底多久没动键鼠"）：
        //    这条是"判定用基线、显示用真实"分开之后的规矩（第一版把显示也改了，被 M13 逮到）。
        assert_eq!(tracker.idle_seconds(), 3600, "显示的仍是真实系统空闲");

        // 静静待到"本次"超过阈值 90 秒 → 这才该记一次
        // ⚠️ 数学要对上：判据是 `idle - dt < 阈值`（上一秒还没到）。
        //    这里 idle = 3690 - 3600 = 90，dt = 1 → 89 < 90 成立 → **这一秒才算跨过阈值**。
        tracker.tick(sample(1, 3690, false));
        assert_eq!(tracker.interrupted_times(), 1, "从开场算起刚好跨过阈值的那一秒记一次");
        assert!(tracker.away_now());
    }

    #[test]
    fn 没到阈值什么都不加() {
        let mut tracker = Tracker::new(90, true, 0);
        tracker.tick(sample(1, 0, false));
        tracker.tick(sample(1, 89, false));

        assert_eq!(tracker.interrupted_seconds(), 0, "没到阈值不该累计秒数");
        assert_eq!(tracker.interrupted_times(), 0, "没到阈值不该计数");
        assert!(!tracker.away_now(), "阈值没到就不算疑似离开");
        assert!(!tracker.paused(), "键鼠没动不等于暂停");
        assert_eq!(tracker.paused_seconds(), 0);
        assert_eq!(tracker.idle_seconds(), 89, "空闲秒数照读");
    }

    #[test]
    fn 跨过阈值那一秒才加一次_持续离开不再重复计数() {
        let mut tracker = Tracker::new(90, true, 0);
        tracker.tick(sample(1, 90, false));
        assert_eq!(tracker.interrupted_times(), 1, "跨过阈值这一秒要记一次");
        assert_eq!(tracker.interrupted_seconds(), 1);

        // 之后每一秒都还在"离开"，但次数**只能**是 1
        for _ in 0..5 {
            tracker.tick(sample(1, 96, false));
        }
        assert_eq!(
            tracker.interrupted_times(),
            1,
            "人一直在外面，那是一次离开，不是每秒一次"
        );
        assert_eq!(tracker.interrupted_seconds(), 6, "秒数照常累计");
        assert!(tracker.away_now());
    }

    #[test]
    fn 阈值边界_89到90正好加一次() {
        let mut tracker = Tracker::new(90, true, 0);
        tracker.tick(sample(1, 89, false));
        assert_eq!(tracker.interrupted_times(), 0, "89 秒还没到");

        tracker.tick(sample(1, 90, false));
        assert_eq!(tracker.interrupted_times(), 1, "90 秒正好跨过阈值");

        tracker.tick(sample(1, 91, false));
        assert_eq!(tracker.interrupted_times(), 1, "91 秒不该再来一次");
    }

    #[test]
    fn 锁屏算暂停_暂停期间再久也不算疑似离开() {
        let mut tracker = Tracker::new(90, true, 0);
        tracker.tick(sample(1, 0, true));
        assert!(tracker.paused(), "锁屏该暂停");
        assert_eq!(tracker.pause_reason(), "lock");
        assert_eq!(tracker.paused_seconds(), 1);

        tracker.tick(sample(1, 300, true));
        assert_eq!(tracker.paused_seconds(), 2, "锁屏期间每秒都算暂停");
        assert_eq!(tracker.interrupted_seconds(), 0, "暂停期间不算疑似离开");
        assert_eq!(tracker.interrupted_times(), 0);
        assert!(!tracker.away_now(), "暂停中一律不算离开");
    }

    #[test]
    fn 关掉锁屏自动暂停时锁屏不算暂停() {
        let mut tracker = Tracker::new(90, false, 0);
        // 先喂一秒"还没到阈值"，好让下一秒真的是**跨过**阈值那一秒
        tracker.tick(sample(1, 89, false));
        tracker.tick(sample(1, 90, true));

        assert!(!tracker.paused(), "设置里关掉了，锁屏就不该暂停");
        assert_eq!(tracker.pause_reason(), "");
        assert_eq!(tracker.paused_seconds(), 0);
        // 不暂停 → 键鼠没动照常按"疑似离开"记
        assert_eq!(tracker.interrupted_seconds(), 1);
        assert_eq!(tracker.interrupted_times(), 1);
        assert!(tracker.away_now());
    }

    #[test]
    fn 睡过一整晚_记成暂停且不算疑似离开() {
        let mut tracker = Tracker::new(90, true, 0);
        tracker.tick(sample(600, 600, true));

        assert!(tracker.paused(), "睡过去该算暂停");
        assert_eq!(tracker.pause_reason(), "sleep");
        assert_eq!(tracker.paused_seconds(), 599, "dt-1：恢复那一秒不算");
        assert_eq!(tracker.interrupted_seconds(), 0, "睡过去不算疑似离开");
        assert_eq!(tracker.interrupted_times(), 0);
    }

    #[test]
    fn 解锁后恢复正常_阈值到了照样累计() {
        let mut tracker = Tracker::new(90, true, 0);
        tracker.tick(sample(1, 89, true));
        assert!(tracker.paused(), "锁屏时该暂停");
        assert_eq!(tracker.interrupted_times(), 0, "暂停期间不算疑似离开");

        tracker.tick(sample(1, 90, false));
        assert!(!tracker.paused(), "解锁了就该退出暂停");
        assert_eq!(tracker.pause_reason(), "");
        assert_eq!(tracker.interrupted_seconds(), 1, "解锁后键鼠没动，照常算离开");
        assert_eq!(tracker.interrupted_times(), 1);
        assert!(tracker.away_now());
    }

    #[test]
    fn 会话开始与结束_没会话时是空快照() {
        // ⚠️ 这个用例会动全局会话状态（模块内唯一一个），别再加第二个来抢它
        let _ = stop();

        let idle = snapshot();
        assert!(!idle.active, "没开会话时 active 必须是 false");
        assert_eq!(idle.todo_id, "");
        assert_eq!(idle.interrupted_seconds, 0);

        start("todo-1".into(), 90, true);
        let running = snapshot();
        assert!(running.active);
        assert_eq!(running.todo_id, "todo-1");
        assert_eq!(running.pause_reason, "");

        let done = stop();
        assert!(!done.active, "停止之后这一份就是已结束");
        assert_eq!(done.todo_id, "todo-1", "最后那份快照要留住 todoId");
        assert!(!snapshot().active, "停完就没有会话了");

        // 🔴 2026-10-05（v1.14.0）：结算完必须**留一份**"最后一次"给记账兜底 ——
        // 记账发生在 stop 之后，那一刻 snapshot() 已是空快照，没有这份兜底就只能写 0。
        let kept = settled_snapshot().expect("结算过就该留下最后一份");
        assert_eq!(kept.todo_id, "todo-1");
        assert!(!kept.active, "留着的是'已结束'那份");
    }

    /// 🔴 2026-10-05（v1.14.0）：**睡过一整晚 → 暂停秒数不为 0 → 记账该拿到它**。
    ///
    /// 这条串起整条链：采样（睡过）→ 计账（`Tracker`）→ 快照（`snapshot_of`）→
    /// 挑选（[`best_effort`]）—— 就是用户那次"合盖之后番茄被记成 4 秒、暂停 0"要保住的东西。
    #[test]
    fn 睡过之后_结算该带上暂停秒数() {
        let mut tracker = Tracker::new(90, true, 0);
        // 一秒正常跑
        tracker.tick(sample(1, 0, false));
        // 合盖睡了一觉：进程被挂起 600 秒（恢复那秒不算，见 `SLEEP_GAP_SECONDS`）
        tracker.tick(sample(600, 600, true));
        assert!(tracker.paused());
        assert_eq!(tracker.pause_reason(), "sleep");
        assert_eq!(tracker.paused_seconds(), 599);

        // 结算时那份快照得原样带着它
        let done = snapshot_of("todo-睡", &tracker);
        assert_eq!(done.paused_seconds, 599, "快照必须带上睡眠那段");

        // 记账那一刻：实时会话已经没了（空快照）+ 最近一次结算那份 = 该取 599，绝不是 0
        let empty = empty_snapshot();
        let (paused, interrupted, times) = best_effort("todo-睡", &[Some(empty), Some(done)]);
        assert_eq!(paused, 599, "别把已经睡过去的那段抹成 0");
        assert_eq!(interrupted, 0);
        assert_eq!(times, 0);
    }

    /// 挑选器：**只认同一个待办**、且**取最大**（同一事实的几个快照不能相加）。
    #[test]
    fn 挑选暂停秒数_只认同待办且取最大() {
        let mut a = empty_snapshot();
        a.todo_id = "todo-A".into();
        a.paused_seconds = 120;
        a.interrupted_seconds = 5;
        a.interrupted_times = 1;

        let mut a2 = empty_snapshot();
        a2.todo_id = "todo-A".into();
        a2.paused_seconds = 300;

        let mut b = empty_snapshot();
        b.todo_id = "todo-B".into();
        b.paused_seconds = 9999; // 别的待办的数字，一律不许串进来

        let (paused, interrupted, times) = best_effort("todo-A", &[Some(a), Some(a2), Some(b), None]);
        assert_eq!(paused, 300, "同一待办取最大，不是相加（120+300=420 是错的）");
        assert_eq!(interrupted, 5, "这一项只有第一份有，照数带出来");
        assert_eq!(times, 1);
    }

    /// 挑选器：一份都没有时是 0（不 panic、不瞎编）
    #[test]
    fn 挑选暂停秒数_什么都没有就是零() {
        let (paused, interrupted, times) = best_effort("todo-X", &[None, None]);
        assert_eq!((paused, interrupted, times), (0, 0, 0));
    }

    /// 🔴 v1.14.1：「接回来」的闸门 —— 同一条待办重复 start **必须沿用**已有会话。
    ///
    /// 用户实测的 bug（合盖睡一觉那一场凭空消失）修法里，前端重载后会再调一次
    /// `focus_monitor_start`；要是这里判成"新开一场"，后端刚攒的"睡了 300 秒"当场清零，
    /// 等于把 bug 从左边挪到右边。所以这三条断言就是那道闸门。
    #[test]
    fn 同一条待办重复开始算接回来_不许清零() {
        assert!(reuses_session(Some("todo-A"), "todo-A"), "同一条 = 接回来，沿用会话");
    }

    /// 换了待办就是新的一场（旧数字一律不带过来）
    #[test]
    fn 换了待办算新开一场() {
        assert!(!reuses_session(Some("todo-A"), "todo-B"));
    }

    /// 本来就没有会话 → 当然是新开一场
    #[test]
    fn 没有会话时开始就是新的一场() {
        assert!(!reuses_session(None, "todo-A"));
    }
}
