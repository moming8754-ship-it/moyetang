//! 同步协议（M23 / v2.13.0）：电脑端**决策**、手机端**照办**，两端共用同一份合并引擎与落地代码。
//!
//! # 为什么决策只放一处
//! 冲突怎么判、删了又改怎么办 —— 这些规则要是两端各写一遍，迟早对不上。
//! 所以第一版的做法是：**电脑（服务端）拿两边的清单算一次计划**，把"你该采纳哪些、该删哪些、该给我哪些"
//! 一次性告诉手机；手机只负责按清单落地 + 把它那份内容回传。规则仍然只有一份（`sync_merge`），
//! 落地代码也只有一份（`sync_apply`）—— 两端编译同一份。
//!
//! # 两次往返、只传有差异的（协议 §3.1 第 4 步）
//! 1. `POST /sync`：手机把**清单**（只带 id/种类/时间 + 墓碑，**不带内容**）发过来 →
//!    电脑算计划 → 回「我这边的清单」+「我要你哪些 id 的内容」（`want`）；
//! 2. `POST /data`：手机把 `want` 那些 id 的**内容**发过来 →
//!    电脑落地自己这侧 → 回「手机该采纳的记录 + 该落地的删除 + 冲突清单 + 账单」。
//! 手机拿到后调 [`crate::store::sync_apply::apply`] 落地自己那侧，同步就完成了。
//!
//! # 账单（协议 §3.1 第 6 步）
//! [`Bill`] 里的数字就是界面上那四个：**补过来 / 传过去 / 冲突 / 删掉** ——
//! 手机侧的账单由手机自己数（它知道自己落地了什么），电脑侧的账单由电脑数，两边都要给用户看。

use serde::{Deserialize, Serialize};

use crate::store::assets::{self, AssetMeta};
use crate::store::sync::{self, Grave};
use crate::store::sync_apply::{self, Collected};
use crate::store::sync_merge::{self as merge, Conflict, Entry, GraveMeta, Plan, Rec};
use crate::store::Store;

/// 手机发来的第一包：**只有清单，没有内容**
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub device: String,
    pub protocol: u32,
    pub entries: Vec<Entry>,
    pub graves: Vec<GraveMeta>,
    /// M26：我这边 `assets/` 的清单（**只有名字 + 字节数，没有内容**）
    ///
    /// ⚠️ `#[serde(default)]`：老版本 App 发来的包里没这个字段 → 当成"对方没有图"，
    /// **不能因此报错**（协议附录四 §4.1）。
    #[serde(default)]
    pub assets: Vec<AssetMeta>,
}

/// 一张图的**字节**（M26）—— 走 base64 塞在 JSON 里
///
/// 为什么不单开一个二进制接口：和现成的"粘贴图片写盘"（`asset_write_image`）同一条路，
/// 两端共用同一段代码，少一套要维护的东西；代价只是体积 +33%，局域网里可以忽略。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBlob {
    pub name: String,
    pub data_base64: String,
}

impl AssetBlob {
    pub fn from_bytes(name: &str, bytes: &[u8]) -> Self {
        use base64::Engine as _;
        Self {
            name: name.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    /// 解出字节（顺带容错 `data:image/png;base64,` 这种前缀）
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        let raw = self.data_base64.trim();
        let payload = raw.split_once(',').map(|(_, tail)| tail).unwrap_or(raw);
        base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|e| format!("{}：图片解码失败：{e}", self.name))
    }
}

/// 给手机的回包（第一包）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloReply {
    pub ok: bool,
    pub device: String,
    pub protocol: u32,
    pub entries: Vec<Entry>,
    pub graves: Vec<GraveMeta>,
    /// 我要你这些 id 的**内容**（第二包发过来）
    pub want: Vec<String>,
    /// 你（手机）没有、我这边有的东西一共有多少（给人看的进度）
    pub mine_total: usize,
    /// M26：我要你这些**图**（第二包传上来）
    #[serde(default)]
    pub want_assets: Vec<String>,
    /// M26：我准备给你的图（第二包带下去，**真的给哪些以第二包为准**）
    #[serde(default)]
    pub assets_to_send: Vec<String>,
    pub message: String,
}

/// 手机发来的第二包：`want` 那些 id 的内容
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataIn {
    pub device: String,
    pub records: Vec<Rec>,
    /// M26：电脑点名的那些图的字节
    #[serde(default)]
    pub assets: Vec<AssetBlob>,
}

/// 账单（用户最关心那四个数字）
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    /// 补过来（我采纳了对方多少条）
    pub adopted: usize,
    /// 传过去（对方采纳了我多少条）
    pub sent: usize,
    /// 冲突（两份都留）
    pub conflicts: usize,
    /// 删掉
    pub deleted: usize,
    /// 「只进不出」的族里被跳过的条数（两边都有 → 一律不动）
    pub skipped: usize,
    /// 冲突副本的标题（给人看"是哪几条"）
    pub copies: Vec<String>,
    /// M26：图片补过来几张（我采纳了对方几张图）
    #[serde(default)]
    pub assets_adopted: usize,
    /// M26：图片传过去几张
    #[serde(default)]
    pub assets_sent: usize,
    /// M26：这轮预算装不下、**下次接着传**的张数
    #[serde(default)]
    pub assets_deferred: usize,
    /// M26：同名但内容不一样的图（**两边都留着自己那张**，要点名告诉用户）
    #[serde(default)]
    pub assets_clash: Vec<String>,
}

#[allow(dead_code)] // 账单口径（界面与测试用同一个算法）
impl Bill {
    pub fn from_parts(adopted: usize, sent: usize, conflicts: usize, deleted: usize, skipped: usize, copies: Vec<String>) -> Self {
        Bill { adopted, sent, conflicts, deleted, skipped, copies, ..Default::default() }
    }
    /// M26：把图片那几个数字填上（记录那部分照旧走 [`Bill::from_parts`]）
    pub fn with_assets(
        mut self,
        adopted: usize,
        sent: usize,
        deferred: usize,
        clash: Vec<String>,
    ) -> Self {
        self.assets_adopted = adopted;
        self.assets_sent = sent;
        self.assets_deferred = deferred;
        self.assets_clash = clash;
        self
    }
    /// 这次一共动了多少项（**图片算不算**：算，不然"只传了图"会显示成 0 项）
    pub fn moved(&self) -> usize {
        self.adopted + self.sent + self.conflicts + self.deleted + self.assets_adopted + self.assets_sent
    }
}

/// 给手机的回包（第二包）：**手机该落地什么**都在这里了
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataReply {
    pub ok: bool,
    /// 手机该采纳的记录（含冲突副本要用的那一份）
    pub records: Vec<Rec>,
    /// 手机该落地的删除
    pub deletes: Vec<GraveMeta>,
    /// 冲突清单（手机上要显示"两份都留"）
    pub conflicts: Vec<Conflict>,
    /// M26：给手机的图片字节（**只增不删**：手机那边只会多出文件，不会被删）
    #[serde(default)]
    pub assets: Vec<AssetBlob>,
    /// 电脑这侧的账单
    pub bill: Bill,
    pub message: String,
}

/// 解析失败/协议不符时的统一回执
fn bad(message: &str) -> (String, u16) {
    let body = serde_json::json!({ "ok": false, "error": message }).to_string();
    (body, 400)
}

fn ok_json<T: Serialize>(value: &T) -> Result<(String, u16), String> {
    let body = serde_json::to_string(value).map_err(|e| e.to_string())?;
    Ok((body, 200))
}

/// 从记录里取一个"给人看的标题"（冲突副本要用）
fn title_of(records: &[Rec], id: &str) -> String {
    for one in records {
        if one.id == id {
            for key in ["title", "text"] {
                if let Some(v) = one.json.get(key).and_then(|x| x.as_str()) {
                    if !v.trim().is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
    }
    id.to_string()
}

/// 把清单型记录转成 `Rec`（内容留空）—— 计划阶段只用到 kind/id/updatedAt
///
/// ⚠️ 给"只想比时间不想传正文"的路径备着（M23 的服务端走的是带正文那条）；测试在覆盖它。
#[allow(dead_code)]
fn thin(entries: &[Entry]) -> Vec<Rec> {
    entries
        .iter()
        .map(|one| Rec {
            kind: one.kind.clone(),
            id: one.id.clone(),
            updated_at: one.updated_at.clone(),
            json: serde_json::Value::Null,
        })
        .collect()
}

/// 电脑端：处理第一包（算计划 + 回清单 + 要哪些内容）
pub fn serve_hello(store: &Store, body: &str) -> (String, u16) {
    let hello: Hello = match serde_json::from_str(body) {
        Ok(one) => one,
        Err(e) => return bad(&format!("第一包解析失败：{e}")),
    };
    if hello.protocol != sync::PROTOCOL_VERSION {
        return bad(&format!(
            "协议版本不一致：手机是 {}、电脑是 {}（升级后重试）",
            hello.protocol,
            sync::PROTOCOL_VERSION
        ));
    }
    let mine: Collected = match sync_apply::collect(store) {
        Ok(one) => one,
        Err(e) => return bad(&format!("电脑这边读数据失败：{e}")),
    };
    let my_manifest = merge::manifest_of(&sync_server_device(), &mine.records, &mine.graves, sync::PROTOCOL_VERSION);

    // 「上次同步时间」：两边都没在这之后改过的东西，这条就什么都不用做（否则每次同步都会生冲突副本）
    let since_raw = sync::state_get(store).map(|s| s.last_sync_at).unwrap_or_default();
    let since = if since_raw.trim().is_empty() { None } else { Some(since_raw.as_str()) };
    let plan = merge::plan_with(
        &my_manifest.entries,
        &hello.entries,
        &my_manifest.graves,
        &hello.graves,
        since,
        |kind, id| title_of(&mine.records, id).or_kind(kind),
    );

    // 我要的内容 = 我该采纳的 + 冲突里需要对方那份内容的
    let mut want: Vec<String> = plan.take_theirs.clone();
    for one in &plan.conflicts {
        want.push(one.id.clone());
    }
    // ── 树 B 补（2026-10-07）：**我赢的树笔记，也要把对方那份的内容拉上来**。
    //
    // 树笔记合的是"按节点 id 的并集"，所以"谁赢"只决定标题/正文归谁 —— 节点得两边并起来。
    // 不拉的话：对方新加的节点永远过不来（它那份内容只有我输了的时候才上来），
    // 再同步一趟又被 `since` 闸门判成"两边都没动过" → 那笔改动石沉大海（"两端都能改树"是假的）。
    // 拉上来之后由 `sync_apply::apply` 的第 1b 步并进本地那棵。
    //
    // ⚠️ 只加"**两边都有**的树笔记"这一种：对方没有的东西拉不到（白写一个 id）；
    //    别的 kind、别的记录一律不加 —— 回传行为一个字节都不动。
    for id in &plan.send_mine {
        let both_have = hello
            .entries
            .iter()
            .any(|one| one.kind == merge::KIND_NOTE && &one.id == id);
        if both_have && sync_apply::local_is_tree_note(store, id) && !want.iter().any(|one| one == id) {
            want.push(id.clone());
        }
    }

    // M26：图片这一趟怎么走（纯规则，见 `sync_merge::plan_assets`）
    //   ⚠️ 这里算出来的 `send` 只是**预告**（给界面显示进度用）；真正带哪些以第二包为准，
    //      因为第二包里电脑刚收了手机传上来的图，清单会变。
    let asset_plan = match assets::list(store) {
        Ok(my_assets) => merge::plan_assets(&my_assets, &hello.assets),
        Err(e) => return bad(&format!("电脑这边读图片清单失败：{e}")),
    };

    if let Ok(mut guard) = pending().lock() {
        *guard = Some(Pending {
            device: hello.device.clone(),
            entries: hello.entries.clone(),
            graves: hello.graves.clone(),
            assets: hello.assets.clone(),
        });
    }

    let reply = HelloReply {
        ok: true,
        device: my_manifest.device.clone(),
        protocol: sync::PROTOCOL_VERSION,
        entries: my_manifest.entries.clone(),
        graves: my_manifest.graves.clone(),
        want,
        mine_total: mine.records.len(),
        want_assets: asset_plan.want.clone(),
        assets_to_send: asset_plan.send.clone(),
        message: format!(
            "收到手机清单：它 {} 条 / 电脑 {} 条；要拉 {} 条内容；图片：要拉 {} 张 / 要送 {} 张",
            hello.entries.len(),
            mine.records.len(),
            plan.take_theirs.len() + plan.conflicts.len(),
            asset_plan.want.len(),
            asset_plan.send.len()
        ),
    };
    match ok_json(&reply) {
        Ok(one) => one,
        Err(e) => bad(&e),
    }
}

/// 小工具：标题兜底
trait OrKind {
    fn or_kind(self, kind: &str) -> String;
}
impl OrKind for String {
    fn or_kind(self, kind: &str) -> String {
        if self.trim().is_empty() {
            format!("（{kind}）")
        } else {
            self
        }
    }
}

/// 电脑端：处理第二包（落地自己这侧 + 告诉手机该干什么）
pub fn serve_data(store: &Store, body: &str) -> (String, u16) {
    let input: DataIn = match serde_json::from_str(body) {
        Ok(one) => one,
        Err(e) => return bad(&format!("第二包解析失败：{e}")),
    };

    // 先锁再克隆（`pending()` 返回的是那个全局槽）
    let pend = match pending().lock() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let Some(pend) = pend else {
        return bad("没有第一包（清单）就先发内容了 —— 顺序不对，请从头再同步一次");
    };

    let mine: Collected = match sync_apply::collect(store) {
        Ok(one) => one,
        Err(e) => return bad(&format!("电脑这边读数据失败：{e}")),
    };
    let my_manifest = merge::manifest_of(&sync_server_device(), &mine.records, &mine.graves, sync::PROTOCOL_VERSION);
    // 「上次同步时间」：两边都没在这之后改过的东西，这条就什么都不用做（否则每次同步都会生冲突副本）
    let since_raw = sync::state_get(store).map(|s| s.last_sync_at).unwrap_or_default();
    let since = if since_raw.trim().is_empty() { None } else { Some(since_raw.as_str()) };
    let plan = merge::plan_with(
        &my_manifest.entries,
        &pend.entries,
        &my_manifest.graves,
        &pend.graves,
        since,
        |_kind, id| title_of(&mine.records, id),
    );

    // 手机发来的内容（它只发我要的那些）
    let theirs: Vec<Rec> = input.records.clone();
    let theirs_graves: Vec<Grave> = pend
        .graves
        .iter()
        .map(|g| Grave {
            id: g.id.clone(),
            kind: g.kind.clone(),
            deleted_at: g.deleted_at.clone(),
        })
        .collect();
    // ── 电脑这侧落地（要么全成、要么回滚）
    let report = match sync_apply::apply(store, &plan, &theirs, &theirs_graves) {
        Ok(one) => one,
        Err(e) => return bad(&format!("电脑这边落地失败（已回滚，数据没变）：{e}")),
    };

    // ── M26：收下手机传上来的图（**只增不改**，晚于记录落地 —— 图片是"附加品"，
    //    记录那边已经按"要么全成要么回滚"处理完了，一张坏图不该毁掉整趟同步）
    let assets_adopted;
    let mut asset_notes: Vec<String> = Vec::new();
    {
        let mut saved = 0usize;
        for blob in &input.assets {
            let bytes = match blob.to_bytes() {
                Ok(one) => one,
                Err(e) => {
                    asset_notes.push(e);
                    continue;
                }
            };
            match assets::save_incoming(store, &blob.name, &bytes) {
                Ok(assets::Incoming::Saved) => saved += 1,
                Ok(assets::Incoming::Skipped) => {}
                Ok(assets::Incoming::Clash) => asset_notes.push(format!(
                    "{}：本地已有一张同名的、内容不一样 —— **保留本地那张**（没覆盖）",
                    blob.name
                )),
                Err(e) => asset_notes.push(e),
            }
        }
        assets_adopted = saved;
    }

    let _ = sync::mark_synced(store, &crate::models::now_iso());
    if let Ok(mut guard) = pending().lock() {
        *guard = None;
    }

    // ── 手机该拿走的东西：我这边比它新的（send_mine）+ 它要的副本 + 我该让它删的
    let send_ids: Vec<&String> = plan.send_mine.iter().collect();
    let all_mine = sync_apply::collect(store).map(|c| c.records).unwrap_or_default();

    // ── 树 B 补（2026-10-07）：**这一趟并出来的树笔记，也必须回给手机**（缺陷的那一半）。
    //
    // 我采纳了对方的树笔记（`take_theirs`）时，`apply` 里已经按节点 id 并过一次：我这边因此
    // **多出了对方没有的节点**（就是我这侧原来那些）。可回给手机的 `records` 只装 `send_mine`
    // + 冲突里的 → 这个"合并结果"根本不在里面 → 手机永远拿不到"我这边赢的那条 record"里
    // 没有的节点；再同步一趟又被 `since` 闸门判成"两边都没动过" → 改动石沉大海。
    // 所以：只要并出来的这份跟"**这一趟赢的那条 record 本身**"真的不一样，就夹带回去一份
    // （手机侧走同一套 `apply` → 它也会 `merge_tree_note` → 两边收敛）。
    //
    // ⚠️ 一样的**不带**（不白烧流量、账单不虚涨）；别的 kind 一个字节都不动。
    // ⚠️ 比 `root` 就够：`write_record` 写树笔记时其余字段是照抄对方那份的，逐节点合并唯一能改的就是 `root`。
    let mut merged_tree_ids: Vec<String> = Vec::new();
    for id in &plan.take_theirs {
        let Some(incoming) = theirs.iter().find(|one| &one.id == id) else {
            continue; // 没给内容（`apply` 那边已经按"中断并回滚"处理过了）
        };
        if incoming.kind != merge::KIND_NOTE {
            continue;
        }
        let Some(now) = all_mine.iter().find(|one| &one.id == id) else {
            continue; // 落地之后盘上没有这条 → 没东西可回传
        };
        if now.json.get("root") != incoming.json.get("root") {
            merged_tree_ids.push(id.clone());
        }
    }

    let mut records: Vec<Rec> = all_mine
        .iter()
        .filter(|one| {
            send_ids.iter().any(|id| **id == one.id)
                || plan.conflicts.iter().any(|c| c.id == one.id)
                || merged_tree_ids.iter().any(|id| *id == one.id)
        })
        .cloned()
        .collect();
    // 冲突副本（电脑这侧生成的那些）也要给手机 —— 它得知道"多了一份副本"
    for copy in &report.copies {
        let _ = copy; // 副本已经在电脑这边落盘了；手机那侧由它自己按冲突清单生成（同一套 apply）
    }

    // ── M26：该给手机带下去的图
    //    ⚠️ 必须**收完手机传上来的之后**再算：它刚给我的那些我这边已经有了，
    //       要是拿第一包的清单算，就会把同一张图原样发回去（白烧流量）。
    let my_assets_now = assets::list(store).unwrap_or_default();
    let out_plan = merge::plan_assets(&my_assets_now, &pend.assets);
    let mut out_assets: Vec<AssetBlob> = Vec::new();
    for name in &out_plan.send {
        match assets::read(store, name) {
            Ok(bytes) => out_assets.push(AssetBlob::from_bytes(name, &bytes)),
            Err(e) => asset_notes.push(e),
        }
    }

    let bill = Bill::from_parts(
        report.adopted,
        plan.send_mine.len(),
        plan.conflicts.len(),
        report.deleted,
        plan.skipped_only_in.len(),
        report.copies.clone(),
    )
    .with_assets(assets_adopted, out_assets.len(), out_plan.deferred, out_plan.clash.clone());

    let mut message = format!(
        "电脑这侧：采纳 {} / 对方采纳 {} / 冲突 {} / 删除 {} / 图片：收下 {} 张、送出 {} 张",
        report.adopted,
        plan.send_mine.len(),
        plan.conflicts.len(),
        report.deleted,
        assets_adopted,
        out_assets.len()
    );
    if out_plan.deferred > 0 {
        message.push_str(&format!("（还有 {} 张下次接着传）", out_plan.deferred));
    }
    for note in &asset_notes {
        message.push_str(&format!("｜图片提示：{note}"));
    }

    let reply = DataReply {
        ok: true,
        records: {
            records.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.id.cmp(&b.id)));
            records
        },
        deletes: plan.send_graves.clone(),
        conflicts: plan.conflicts.clone(),
        assets: out_assets,
        bill,
        message,
    };
    let _ = store; // 保留参数语义（将来加"逐项日志"要用）
    match ok_json(&reply) {
        Ok(one) => one,
        Err(e) => bad(&e),
    }
}

/// 这台电脑的名字（与 `sync_server::device_name` 同一个来源，避免两处不一致）
fn sync_server_device() -> String {
    crate::store::sync_server::device_name()
}

/// 两包之间要记住"手机那边说了什么"
#[derive(Clone, Debug)]
struct Pending {
    #[allow(dead_code)] // 记着"手机自报的名字"，回包与诊断要用；目前只在写、还没读
    device: String,
    entries: Vec<Entry>,
    graves: Vec<GraveMeta>,
    /// M26：手机报上来的图片清单（第二包要拿它算"该给手机带哪些图"）
    assets: Vec<AssetMeta>,
}

use std::sync::{Mutex, OnceLock};
fn pending() -> &'static Mutex<Option<Pending>> {
    static SLOT: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

// ───────────────────────────── 客户端（手机端用；电脑端也能用它做端到端测试）─────────────────────────────

/// 一次同步的结果（给手机界面显示）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientOutcome {
    pub ok: bool,
    pub device: String,
    /// 手机上该显示的账单（"我采纳了多少、给了多少…"）
    pub bill: Bill,
    pub message: String,
    /// 我采纳了对方多少条（手机视角）
    pub adopted: usize,
    pub sent: usize,
}

/// 手机端（或端到端测试里的"手机侧"）：跟 `base`（如 `http://192.168.1.5:32123`）同步一次
///
/// `token` 既可以是二维码里那串长令牌，也可以是**6 位短码**（手输那条路）。
pub fn run_client(store: &Store, base: &str, cred: &Cred) -> Result<ClientOutcome, String> {
    let mine = sync_apply::collect(store)?;
    let hello = Hello {
        device: crate::store::sync_server::device_name(),
        protocol: sync::PROTOCOL_VERSION,
        entries: merge::manifest_of("me", &mine.records, &mine.graves, sync::PROTOCOL_VERSION).entries,
        graves: mine.graves.iter().map(GraveMeta::from).collect(),
        // M26：把我这边的图片清单报给电脑（**只有名字 + 字节数**）
        assets: assets::list(store)?,
    };
    let hello_body = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
    let url1 = format!("{base}/sync?{}", cred.query());
    let text1 = http_post(&url1, &hello_body)?;
    let reply1: HelloReply = serde_json::from_str(&text1).map_err(|e| format!("第一包回执解析失败：{e}｜原文：{}", &text1[..text1.len().min(200)]))?;
    if !reply1.ok {
        return Err(format!("电脑拒绝了这次同步：{}", reply1.message));
    }

    // 把电脑要的 id 的内容捞出来发过去
    let want = sync_apply::records_for(store, &reply1.want)?;
    // M26：电脑点名的图也读出来（读不出来的**跳过**，不因为一张图把整趟同步搞崩）
    let mut out_blobs: Vec<AssetBlob> = Vec::new();
    let mut asset_notes: Vec<String> = Vec::new();
    for name in &reply1.want_assets {
        match assets::read(store, name) {
            Ok(bytes) => out_blobs.push(AssetBlob::from_bytes(name, &bytes)),
            Err(e) => asset_notes.push(e),
        }
    }
    let data = DataIn {
        device: hello.device.clone(),
        records: want,
        assets: out_blobs,
    };
    let data_body = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    let url2 = format!("{base}/data?{}", cred.query());
    let text2 = http_post(&url2, &data_body)?;
    let reply2: DataReply = serde_json::from_str(&text2).map_err(|e| format!("第二包回执解析失败：{e}｜原文：{}", &text2[..text2.len().min(200)]))?;
    if !reply2.ok {
        return Err(format!("电脑处理失败：{}", reply2.message));
    }

    // 手机这侧落地：按电脑给的清单走**同一套** apply
    let theirs_graves: Vec<Grave> = reply2
        .deletes
        .iter()
        .map(|g| Grave { id: g.id.clone(), kind: g.kind.clone(), deleted_at: g.deleted_at.clone() })
        .collect();
    let plan = Plan {
        take_theirs: reply2.records.iter().map(|one| one.id.clone()).collect(),
        send_mine: vec![],
        conflicts: reply2.conflicts.clone(),
        apply_graves: reply2.deletes.clone(),
        send_graves: vec![],
        skipped_only_in: vec![],
    };
    let report = sync_apply::apply(store, &plan, &reply2.records, &theirs_graves)?;

    // ── M26：把电脑带下来的图落盘（**只增不改**：本地已有同名的绝不覆盖）
    let mut images_adopted = 0usize;
    for blob in &reply2.assets {
        let bytes = match blob.to_bytes() {
            Ok(one) => one,
            Err(e) => {
                asset_notes.push(e);
                continue;
            }
        };
        match assets::save_incoming(store, &blob.name, &bytes) {
            Ok(assets::Incoming::Saved) => images_adopted += 1,
            Ok(assets::Incoming::Skipped) => {}
            Ok(assets::Incoming::Clash) => asset_notes.push(format!(
                "{}：本地已有一张同名的、内容不一样 —— 保留了本地那张",
                blob.name
            )),
            Err(e) => asset_notes.push(e),
        }
    }

    let _ = sync::mark_synced(store, &crate::models::now_iso());

    Ok(ClientOutcome {
        ok: true,
        device: reply1.device.clone(),
        bill: Bill {
            adopted: report.adopted,
            // 🔴 P1-1（2026-10-06 修）：这里原来是 `reply2.bill.sent` —— **口径写反了**。
            //   电脑端账单里的 `sent` 是"**手机采纳了多少**"（方向与手机自己的 `adopted` 相同），
            //   手机要的"传过去"是"**电脑采纳了我多少**"= 电脑端的 `adopted`。
            //   写反的后果（用户实测）：手机把东西传上去了、但这一趟什么都没采纳 →
            //   两个方向都读成 0 → 界面上**四个数字全是 0**，看着像"什么都没同步"。
            sent: reply2.bill.adopted,
            conflicts: reply2.conflicts.len(),
            deleted: report.deleted,
            skipped: reply1.entries.len().min(0),
            copies: report.copies.clone(),
            // M26 图片（同一套口径）：手机"补过来" = 这一趟落盘的图张数；
            //   手机"传过去" = **电脑收下了几张** = 电脑端账单的 `assetsAdopted`。
            assets_adopted: images_adopted,
            assets_sent: reply2.bill.assets_adopted,
            assets_deferred: reply2.bill.assets_deferred,
            assets_clash: reply2.bill.assets_clash.clone(),
        },
        message: {
            let mut text = format!(
                "连上「{}」：补过来 {} 条 / 传过去 {} 条 / 冲突 {} / 删掉 {}｜图片：补过来 {} 张 / 传过去 {} 张",
                reply1.device,
                report.adopted,
                reply2.bill.adopted,
                reply2.conflicts.len(),
                report.deleted,
                images_adopted,
                reply2.bill.assets_adopted
            );
            if reply2.bill.assets_deferred > 0 {
                text.push_str(&format!("（还有 {} 张下次接着传）", reply2.bill.assets_deferred));
            }
            if !reply2.bill.assets_clash.is_empty() {
                text.push_str(&format!(
                    "｜有 {} 张图两边同名但内容不一样（{}）—— 两边都留着了，没覆盖",
                    reply2.bill.assets_clash.len(),
                    reply2.bill.assets_clash.join("、")
                ));
            }
            for note in &asset_notes {
                text.push_str(&format!("｜图片提示：{note}"));
            }
            text
        },
        adopted: report.adopted,
        sent: reply2.bill.sent,
    })
}

/// 手输短码那条路：从 `moye-sync://IP:端口/令牌` 里解出 base 与令牌，也支持直接给 `IP:端口` + 6 位短码
/// 连电脑用的**凭据**：两种服务端都认，但**查询参数的名字不一样**。
///
/// 🔴 2026-10-06 修的真 bug：以前 `parse_manual` 把 6 位短码**当成令牌**返回，
/// 客户端于是拼出 `?token=123456`；而服务端只认 `?token=<64 位 hex>` 或 `?code=<6 位>`
/// → **手输短码那条路必然 403**（本机自测一跑就抓到）。所以这里把"凭据种类"显式建出来。
#[derive(Clone, Debug, PartialEq)]
pub enum Cred {
    /// 二维码里那串 64 位十六进制令牌
    Token(String),
    /// 6 位短码（相机不好使时手机手输的那条路）
    Code(String),
}

impl Cred {
    /// 拼进 URL 的查询串（**参数名不同，别混**）
    pub fn query(&self) -> String {
        match self {
            Cred::Token(t) => format!("token={t}"),
            Cred::Code(c) => format!("code={c}"),
        }
    }
}

pub fn parse_manual(input: &str, code: Option<&str>) -> Result<(String, Cred), String> {
    let text = input.trim();
    if let Some((ip, port, token)) = crate::store::sync_server::parse_qr_text(text) {
        return Ok((format!("http://{ip}:{port}"), Cred::Token(token)));
    }
    // `192.168.1.5:32123`（要求带端口：随便挑一个默认端口只会误导人）
    if let Some((host, port)) = text.split_once(':') {
        let port: u16 = port.trim().parse().map_err(|_| "端口看起来不对".to_string())?;
        let short = code.unwrap_or("").trim().to_string();
        if short.is_empty() {
            return Err("还要填 6 位短码（电脑那边的二维码旁边写着）".to_string());
        }
        return Ok((format!("http://{}:{}", host.trim(), port), Cred::Code(short)));
    }
    Err("这一段看起来不像地址：要么扫二维码，要么填「电脑IP:端口」+ 6 位短码".to_string())
}

/// 极简 HTTP POST（阻塞式；只用于同步这一条路，不引入额外运行时）
fn http_post(url: &str, body: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    match agent.post(url).set("Content-Type", "application/json").send_string(body) {
        Ok(resp) => resp.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(format!("电脑回了 {code}：{}", text.chars().take(200).collect::<String>()))
        }
        Err(e) => Err(format!("连不上电脑（同一个 WiFi 吗？）：{e}")),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn parse_manual_accepts_qr_text() {
        let (base, cred) = parse_manual("moye-sync://192.168.1.5:32123/abcdef", None).unwrap();
        assert_eq!(base, "http://192.168.1.5:32123");
        assert_eq!(cred, Cred::Token("abcdef".into()));
    }

    #[test]
    fn parse_manual_accepts_ip_port_plus_code() {
        let (base, cred) = parse_manual("192.168.1.5:32123", Some("123456")).unwrap();
        assert_eq!(base, "http://192.168.1.5:32123");
        assert_eq!(cred, Cred::Code("123456".into()));
    }

    #[test]
    fn short_code_goes_into_code_param_not_token() {
        // 🔴 这条**钉住 2026-10-06 修的那个真 bug**：短码必须走 `code=`，绝不能走 `token=`
        //    （走错了服务端一律 403 —— 手输短码那条路整个废掉，而且只在"手输"时才暴露）
        let (_, cred) = parse_manual("192.168.1.5:32123", Some("123456")).unwrap();
        assert_eq!(cred.query(), "code=123456");
        let (_, from_qr) = parse_manual("moye-sync://192.168.1.5:32123/deadbeef", None).unwrap();
        assert_eq!(from_qr.query(), "token=deadbeef");
    }

    #[test]
    fn parse_manual_rejects_garbage() {
        assert!(parse_manual("随便写的", None).is_err());
        assert!(parse_manual("192.168.1.5:99999", Some("123456")).is_err());
        assert!(parse_manual("192.168.1.5:32123", None).is_err(), "没短码应当报错（提示去二维码旁边看）");
    }

    #[test]
    fn hello_rejects_wrong_protocol() {
        let store = temp_store("m23-proto-badver");
        let hello = Hello {
            device: "phone".into(),
            protocol: 999,
            entries: vec![],
            graves: vec![],
            assets: vec![],
        };
        let (body, code) = serve_hello(&store, &serde_json::to_string(&hello).unwrap());
        assert_eq!(code, 400);
        assert!(body.contains("协议版本不一致"));
    }

    #[test]
    fn hello_rejects_broken_json() {
        let store = temp_store("m23-proto-badjson");
        let (body, code) = serve_hello(&store, "{这不是 json");
        assert_eq!(code, 400);
        assert!(body.contains("解析失败"));
    }

    #[test]
    fn data_without_hello_is_refused() {
        let store = temp_store("m23-proto-nohi");
        let data = DataIn { device: "phone".into(), records: vec![], assets: vec![] };
        let (body, code) = serve_data(&store, &serde_json::to_string(&data).unwrap());
        assert_eq!(code, 400);
        assert!(body.contains("没有第一包"), "顺序错了要明确拒绝：{body}");
    }

    #[test]
    fn hello_replies_with_manifest_and_want_list() {
        let store = temp_store("m23-proto-hello");
        let hello = Hello {
            device: "phone".into(),
            protocol: sync::PROTOCOL_VERSION,
            entries: vec![Entry {
                kind: merge::KIND_TODO.into(),
                id: "t-from-phone".into(),
                updated_at: "2026-10-06T10:00:00+08:00".into(),
            }],
            graves: vec![],
            assets: vec![],
        };
        let (body, code) = serve_hello(&store, &serde_json::to_string(&hello).unwrap());
        assert_eq!(code, 200);
        let reply: HelloReply = serde_json::from_str(&body).unwrap();
        assert!(reply.ok);
        assert!(reply.want.contains(&"t-from-phone".to_string()), "电脑该要这条的内容");
        assert_eq!(reply.protocol, sync::PROTOCOL_VERSION);
    }

    #[test]
    fn bill_counts_moves() {
        let bill = Bill::from_parts(2, 1, 1, 3, 0, vec!["x（冲突副本）".into()]);
        assert_eq!(bill.moved(), 7);
        assert_eq!(bill.copies.len(), 1);
    }
}
