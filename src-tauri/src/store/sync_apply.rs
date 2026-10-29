//! 同步的**读写层**（M23 / v2.13.0）：把数据收成"记录清单"、把合并计划**要么全成要么回滚**地落盘。
//!
//! 与 [`super::sync_merge`] 的分工：那边是**纯规则**（几十条单测钉死），这边负责**碰磁盘**。
//!
//! # 三道保险（协议 §3.6）在这里落地
//! 1. **同步前快照**：`sync_server::snapshot_pre_sync`（服务端开同步时做）+ 客户端侧 [`local_snapshot`]；
//! 2. **要么全成、要么不算**：[`apply`] 先把要动的每个文件**逐个备份**，任何一步失败 → **全部还原**并回报错误；
//! 3. **冲突必留副本**：`same_moment` / `deleted_but_modified` 两种冲突都生成「（冲突副本）」。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::models::{now_iso, Todo, TreeNode};
use crate::store::sync::{self, Grave};
use crate::store::sync_merge::{self as merge, Conflict, Plan, Rec, COPY_SUFFIX};
use crate::store::{atomic, Store};

/// 收集结果
#[derive(Clone, Debug, Default)]
pub struct Collected {
    pub records: Vec<Rec>,
    pub graves: Vec<Grave>,
}

fn rec(kind: &str, id: &str, updated_at: &str, json: Value) -> Rec {
    Rec {
        kind: kind.to_string(),
        id: id.to_string(),
        updated_at: updated_at.to_string(),
        json,
    }
}

fn todo_stamp(one: &Todo) -> String {
    if !one.updated_at.is_empty() {
        one.updated_at.clone()
    } else if !one.created_at.is_empty() {
        one.created_at.clone() // 老数据兜底（协议 §3.5）
    } else {
        now_iso()
    }
}

/// 把一个数据目录收成"可同步的记录 + 墓碑"
pub fn collect(store: &Store) -> Result<Collected, String> {
    let mut records: Vec<Rec> = Vec::new();

    // ── 待办（互传）
    for one in crate::store::todo::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        records.push(rec(merge::KIND_TODO, &one.id, &todo_stamp(&one), json));
    }
    // ── 笔记（一条一个文件；互传）
    for one in crate::store::note::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        records.push(rec(merge::KIND_NOTE, &one.id, &one.updated_at, json));
    }
    // ── 每日报告（一天一个文件；互传）
    // ⚠️ `dailies` 模块**没有** list_all（它按日期一个文件读写）→ 这里自己扫目录（只扫 *.json）。
    let daily_dir = crate::store::dailies::dir(store);
    if let Ok(entries) = std::fs::read_dir(&daily_dir) {
        let mut dates: Vec<String> = entries
            .flatten()
            .filter_map(|one| one.file_name().to_string_lossy().strip_suffix(".json").map(|s| s.to_string()))
            .collect();
        dates.sort();
        for date in dates {
            let one = crate::store::dailies::load(store, &date)?;
            let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
            let at = if one.updated_at.is_empty() { now_iso() } else { one.updated_at.clone() };
            records.push(rec(merge::KIND_DAILY, &one.date, &at, json));
        }
    }
    // ── 批注（只增不改 → 按生成时间；互传）
    for one in crate::store::annotations::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        records.push(rec(merge::KIND_ANNOTATION, &one.id, &one.created_at, json));
    }
    // ── 提醒（挂在待办上；互传，按 id 取"新的那份"）
    for one in crate::store::reminder::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        let at = one.snoozed_until.clone().unwrap_or_else(|| one.fire_at.clone());
        records.push(rec(merge::KIND_REMINDER, &one.id, &at, json));
    }
    // ── 只进不出的族
    for one in crate::store::info::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        let at = if one.updated_at.trim().is_empty() { &one.created_at } else { &one.updated_at };
        records.push(rec(merge::KIND_INFO, &one.id, at, json));
    }
    for one in crate::store::awards::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        // 🔴 2026-10-21：奖状能跨端更新了 —— 记录的"时间"用 `updated_at`；
        //    老数据没有它（空串）→ 退回 `created_at`，否则会被当成"没有时间"永远排最后。
        let at = if one.updated_at.trim().is_empty() {
            one.created_at.clone()
        } else {
            one.updated_at.clone()
        };
        records.push(rec(merge::KIND_AWARD, &one.id, &at, json));
    }
    for one in crate::store::mottos::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        let at = if one.updated_at.trim().is_empty() { &one.created_at } else { &one.updated_at };
        records.push(rec(merge::KIND_MOTTO, &one.id, at, json));
    }
    for one in crate::store::archive::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        let at = if one.updated_at.trim().is_empty() { &one.archived_at } else { &one.updated_at };
        records.push(rec(merge::KIND_ARCHIVE, &one.id, at, json));
    }
    for one in crate::store::countdown::list(store)? {
        let json = serde_json::to_value(&one).map_err(|e| e.to_string())?;
        let at = if one.updated_at.trim().is_empty() {
            if one.date.trim().is_empty() { now_iso() } else { one.date.clone() }
        } else {
            one.updated_at.clone()
        };
        records.push(rec(merge::KIND_COUNTDOWN, &one.id, &at, json));
    }

    Ok(Collected {
        records,
        graves: sync::list(store)?,
    })
}

/// 按 id 取记录内容（对方来拉时用；**只给清单里出现过的 id**，避免被塞任意 id 乱取）
pub fn records_for(store: &Store, want: &[String]) -> Result<Vec<Rec>, String> {
    let all = collect(store)?;
    let mut out = Vec::new();
    for one in all.records {
        if want.iter().any(|id| *id == one.id) {
            out.push(one);
        }
    }
    Ok(out)
}

/// 本地快照（客户端侧）—— 同步前把要动的文件整份留档；留档失败就**中止同步**
fn local_snapshot(store: &Store) -> Result<PathBuf, String> {
    let dir = store
        .data_dir()
        .join("backups")
        .join(format!("sync-pre-{}", chrono::Local::now().format("%Y-%m-%d-%H%M%S")));
    std::fs::create_dir_all(&dir).map_err(|e| format!("建快照目录失败：{e}"))?;
    for entry in crate::store::DATA_ENTRIES {
        let from = store.data_dir().join(entry);
        if !from.exists() {
            continue;
        }
        let to = dir.join(entry);
        crate::store::copy_recursive(&from, &to).map_err(|e| format!("快照失败（宁可不做也不冒险）：{e}"))?;
    }
    // 🔴 2026-10-13：这一族（`backups/sync-pre-<时间戳>/`）原来也**没有清理** ——
    //    跟 `sync_server` 那族一起把 `backups/` 撑到了 100 MB 以上。留最近几轮就够。
    crate::store::safety::prune_dirs(
        &store.data_dir().join("backups"),
        "sync-pre-",
        crate::store::safety::SYNC_SNAPSHOT_KEEP,
    );
    Ok(dir)
}

/// 应用结果（给"账单"用）
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// 采纳了对方多少条
    pub adopted: usize,
    /// 落地了多少条删除
    pub deleted: usize,
    /// 生成了几份冲突副本（标题）
    pub copies: Vec<String>,
    /// 快照目录（"打开同步前快照"用）
    pub snapshot: String,
}

/// **树 B**（2026-10-07）：树笔记的 `root` 落盘前**逐节点合并**。
///
/// 返回 `Some((要写进去的 json, 这一趟留下的节点冲突))`；`None` = 不走这条路（调用方照旧整条写）。
///
/// # 为什么要把原来那条粗规则换掉（真事故）
/// 原来这里是 `keep_local_tree_when_richer`：只有当对方那份**节点更少**时才保住本地的 `root`，
/// 其余情况"谁的时间新整棵赢"。可"两端都能改树"（电脑画布 + 手机文本页）是这个 App 的常态，
/// 只要对方手上那份 `root` 是**上次同步时的旧副本**，另一端后加的节点就会被整片抹掉
/// （用户真机验收报的"树在、内容没了"）。现在改成按节点 id 求并集，规则全在
/// [`merge::merge_trees`] 里（纯逻辑、单测钉死），这里只负责读盘/落盘。
///
/// ⚠️ **只对树笔记生效**：对方那份不是树笔记（doc / 坏数据），或本地那份不是树笔记 → 返回 `None`，
/// 别的 kind 的合并行为一个字节都不动。
pub(crate) fn merge_tree_note(
    store: &Store,
    id: &str,
    incoming: &Value,
) -> Result<Option<(Value, Vec<merge::TreeConflict>)>, String> {
    if incoming.get("kind").and_then(|v| v.as_str()) != Some("tree") {
        return Ok(None);
    }
    // 对方的根读不出来（坏文件 / 老文件）→ 当成"对方那边没有树"：合并结果就是**本地那棵**。
    // ⚠️ 这里**绝不能**退回"整条写"：那会把本地好好的树写成对方那个 `null`，正是 P0-1 那条红线的反面。
    let theirs_root: Option<TreeNode> = incoming
        .get("root")
        .and_then(|root| serde_json::from_value::<TreeNode>(root.clone()).ok());

    let path = crate::store::note::note_path(store, id);
    let local: Option<Value> = match atomic::read_to_string(&path).map_err(|e| e.to_string())? {
        Some(text) => serde_json::from_str(&text).ok(),
        None => None,
    };
    let mine_root: Option<TreeNode> = match &local {
        // 本地没有这份文件（对方新传过来的笔记）→ 直接采纳对方的根
        None => None,
        Some(found) => {
            if found.get("kind").and_then(|v| v.as_str()) != Some("tree") {
                // 本地那份不是树笔记（id 撞了/换过种类）→ 不拿两种东西去合，照旧整条写
                return Ok(None);
            }
            found
                .get("root")
                .and_then(|root| serde_json::from_value::<TreeNode>(root.clone()).ok())
        }
    };

    // 墓碑：本地 `sync/graves.json` 里那一族（`treenode`）= "哪些节点已经被删了、不许复活"。
    // ⚠️ 对方报上来的节点墓碑，`apply` 会在采纳记录**之前**先落地（见那里的第 0 步），
    //    否则这一趟合并会把对方已经删掉的节点当成"本地有、对方没有"给留下来。
    let graves: Vec<merge::GraveMeta> = sync::list(store)?.iter().map(merge::GraveMeta::from).collect();
    let merged = merge::merge_trees(mine_root.as_ref(), theirs_root.as_ref(), &graves);

    // 落盘底稿用**对方那份**（标题/正文/时间戳照旧按"这一趟是谁赢"走，与原来一致），
    // 只把 `root` 换成逐节点合并的结果。
    let mut out = incoming.clone();
    if let Some(root) = merged.root {
        out["root"] = serde_json::to_value(&root).map_err(|e| e.to_string())?;
    }
    Ok(Some((out, merged.conflicts)))
}

/// **树 B 补（2026-10-07）**：这一趟**我赢**的树笔记，也要把对方那份的节点并进来。
///
/// # 为什么非要有它（真缺陷："内容只往一个方向流"）
/// 树笔记的合并口径是**按节点 id 求并集**（[`merge::merge_trees`]），可这一趟的内容却只有
/// "我该采纳的"（`plan.take_theirs`）会上来 —— 对方那份树**只有在我输了的时候**才传给我。
/// 于是"我这侧赢"的那些趟里，对方新加的节点永远过不来；再同步一趟又被 `since` 闸门判成
/// "两边都没动过" → **那笔改动石沉大海**。"两端都能改树"于是名不副实：只有同一分钟内两边都改
/// （判成 `same_moment` 冲突）才会双向交换。
///
/// 所以：**我方赢的树笔记也要并一次**（对方那份的**内容**由 `serve_hello` 加进 `want` 一起拉上来）。
///
/// # 与 [`merge_tree_note`]（对方那份赢、整条落盘）的关键区别 —— 别混
/// - 底稿用**本地那份**：这一趟是我赢，标题 / 正文 / `updatedAt` 都归我，**一个字都不许被对方那份盖掉**
///   （`merge_tree_note` 是反过来的：赢了的那份是对方，底稿才用对方那份）；
/// - 只把 `root` 换成并集结果，而且**并出来跟本地一模一样就一个字节都不写**
///   （红线：不白烧流量、账单不虚涨）；
/// - 🔴 **绝不**把 `updatedAt` 推成"现在"：两端都推 → 下一趟互相判成"都改过" →
///   冲突副本滚雪球（上一轮就是踩着这个坑过来的）。
///
/// 返回 `true` = 真的并出了差异、已经落盘（调用方不用再管，`serve_data` 回包是落地后重新
/// `collect` 的，并出来的结果自然就在回包里）。
fn merge_their_tree_nodes(store: &Store, id: &str, incoming: &Value) -> Result<bool, String> {
    // 对方那份不是树笔记 → 没有"节点"可并（别的 kind 照旧整条写，这里不插手）
    if incoming.get("kind").and_then(|v| v.as_str()) != Some("tree") {
        return Ok(false);
    }
    let path = crate::store::note::note_path(store, id);
    let Some(text) = atomic::read_to_string(&path).map_err(|e| e.to_string())? else {
        return Ok(false); // 本地没有这篇 → 对方没有"能并进来的东西"（这条不该被走到）
    };
    let Ok(local) = serde_json::from_str::<Value>(&text) else {
        return Ok(false); // 本地那份是坏文件：**不猜、不动**（宁可这趟不并，也不许把好数据写坏）
    };
    if local.get("kind").and_then(|v| v.as_str()) != Some("tree") {
        return Ok(false); // 本地那份不是树笔记（id 撞了/换过种类）→ 不拿两种东西去合
    }
    let mine_root: Option<TreeNode> = local.get("root").and_then(|one| serde_json::from_value(one.clone()).ok());
    let theirs_root: Option<TreeNode> = incoming.get("root").and_then(|one| serde_json::from_value(one.clone()).ok());
    if theirs_root.is_none() {
        // 对方那份缺根（坏文件 / 老文件）→ 一个节点都并不进来。
        // ⚠️ 这里也**绝不能**退回"整条写"：那正是 P0-1 那条红线的反面（拿对方的空树盖掉本地）
        return Ok(false);
    }

    let graves: Vec<merge::GraveMeta> = sync::list(store)?.iter().map(merge::GraveMeta::from).collect();
    let merged = merge::merge_trees(mine_root.as_ref(), theirs_root.as_ref(), &graves);
    let Some(root) = merged.root else {
        return Ok(false); // 连根都没有（本地的根被墓碑盖住了）→ 一个字节都别动
    };

    // ⚠️ 比较必须在**同一套序列化**上做：本地那份是从盘上读出来的 json，先过一遍 `TreeNode` 再比，
    //    免得"键序 / 缺省字段"这种纯格式差异被当成"并出了新东西"（那就会白写盘 + 白回传）。
    let before = mine_root
        .as_ref()
        .map(|one| serde_json::to_value(one).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    let after = serde_json::to_value(&root).map_err(|e| e.to_string())?;
    if before == after {
        return Ok(false); // 一个节点都没多、也没变 → 不写盘、不回传（红线：只在真并出差异时才动）
    }

    let mut out = local.clone();
    out["root"] = after;
    atomic::atomic_write_json(&path, &out)?;
    Ok(true)
}

/// 本地这篇笔记是不是**树笔记**（按盘上的 `kind` 判断；文件不在 → `false`）
///
/// `pub(crate)`：`sync_proto::serve_hello` 也要用它（"该不该把对方那份树拉上来并一次"）。
/// 判"是不是树笔记"只留这一个口径 —— 两处各写一遍迟早对不上。
pub(crate) fn local_is_tree_note(store: &Store, id: &str) -> bool {
    let path = crate::store::note::note_path(store, id);
    match atomic::read_to_string(&path) {
        Ok(Some(text)) => serde_json::from_str::<Value>(&text)
            .map(|found| found.get("kind").and_then(|v| v.as_str()) == Some("tree"))
            .unwrap_or(false),
        _ => false,
    }
}

/// 树节点墓碑的落地：把墓碑点名的节点（**连同它的整枝**）从**每一篇**树笔记里摘掉。
///
/// 为什么是"扫所有笔记"：墓碑按协议**不存内容**（也就不存"这个节点在哪篇笔记里"），
/// 手里只有节点 id，只能按 id 找一遍；节点 id 是 uuid、笔记是个人量级，这一遍很便宜。
///
/// 🔴 根节点永远不摘：摘了整棵树就没了（`tree::remove_branch` 也是这么挡的，这里是第二道）。
fn delete_tree_node(store: &Store, node_id: &str) -> Result<bool, String> {
    let mut hit = false;
    for one in crate::store::note::list(store)? {
        if one.kind != crate::models::NoteKind::Tree {
            continue;
        }
        let Some(root) = one.root.as_ref() else { continue };
        if root.id == node_id || crate::store::tree::find(root, node_id).is_none() {
            continue;
        }
        let mut edited = one.clone();
        if let Some(root) = edited.root.as_mut() {
            crate::store::tree::remove_branch(root, node_id)?;
        }
        // 走 `note::save`（不是原子直写）：摘节点是真的改了这篇笔记，`updatedAt` 该盖章 ——
        // 这样"这一枝没了"这件事才会在下一趟同步里被当成新改动传到对面去。
        crate::store::note::save(store, &edited)?;
        hit = true;
    }
    Ok(hit)
}

/// 把一条记录写进对应的文件（kind 决定去处）
pub(crate) fn write_record(store: &Store, one: &Rec) -> Result<(), String> {
    match one.kind.as_str() {
        k if k == merge::KIND_TODO => {
            let incoming: Todo = serde_json::from_value(one.json.clone())
                .map_err(|e| format!("待办 {} 解析失败：{e}", one.id))?;
            let mut file = crate::store::todo::load(store)?;
            match file.items.iter_mut().find(|x| x.id == one.id) {
                Some(slot) => *slot = incoming,
                None => file.items.push(incoming),
            }
            crate::store::todo::save(store, &file)
        }
        k if k == merge::KIND_NOTE => {
            let path = crate::store::note::note_path(store, &one.id);
            // 🔴 树 B（2026-10-07）：**树笔记的 root 逐节点合并**（不是"整棵树谁赢"）。
            //
            // 历史：这里原来是 P0-1 的 `keep_local_tree_when_richer`（只挡住"对方更空"那一种），
            // 现在换成 [`merge_tree_note`] —— 按节点 id 并集，两端各加的节点都留得住。
            // ⚠️ doc 笔记、或本地/对方任一方不是树笔记 → `None` → 照旧整条写（别的 kind 一个字不改）。
            if let Some((merged, _conflicts)) = merge_tree_note(store, &one.id, &one.json)? {
                return atomic::atomic_write_json(&path, &merged);
            }
            atomic::atomic_write_json(&path, &one.json)
        }
        k if k == merge::KIND_DAILY => {
            // ⚠️ 名字带「（冲突副本）」的那种**过不了日期校验**（它不是日期，是"日期 + 后缀"），
            //    但它是"两份都留"的保底文件，必须写得进去 —— 所以副本直写，正本才走 `path_for`。
            let path = if one.id.contains(COPY_SUFFIX) {
                crate::store::dailies::dir(store).join(format!("{}.json", one.id))
            } else {
                crate::store::dailies::path_for(store, &one.id)?
            };
            atomic::atomic_write_json(&path, &one.json)
        }
        k if k == merge::KIND_REMINDER => {
            let mut file = crate::store::reminder::load(store)?;
            let incoming: crate::models::Reminder = serde_json::from_value(one.json.clone())
                .map_err(|e| format!("提醒 {} 解析失败：{e}", one.id))?;
            match file.items.iter_mut().find(|x| x.id == one.id) {
                Some(slot) => *slot = incoming,
                None => file.items.push(incoming),
            }
            crate::store::reminder::save(store, &file)
        }
        k if k == merge::KIND_ANNOTATION => {
            let mut file = crate::store::annotations::load(store)?;
            let incoming: crate::models::Annotation = serde_json::from_value(one.json.clone())
                .map_err(|e| format!("批注 {} 解析失败：{e}", one.id))?;
            match file.items.iter_mut().find(|x| x.id == one.id) {
                Some(slot) => *slot = incoming,
                None => file.items.push(incoming),
            }
            crate::store::annotations::save(store, &file)
        }
        // 只进不出的族：**只追加没有的**（协议 §5.2）
        // 🔴 奖状例外（2026-10-21）：它会更新 —— 两边都有时**整条换成对面的**（计划层已经判过谁新）。
        k if k == merge::KIND_AWARD => {
            let mut file = crate::store::awards::load(store)?;
            let incoming: crate::models::Award =
                serde_json::from_value(one.json.clone()).map_err(|e| e.to_string())?;
            match file.items.iter().position(|x| x.id == one.id) {
                Some(at) => file.items[at] = incoming,
                None => file.items.push(incoming),
            }
            crate::store::awards::save(store, &file)
        }
        k if k == merge::KIND_MOTTO => {
            let mut file = crate::store::mottos::load(store)?;
            let incoming: crate::models::Motto =
                serde_json::from_value(one.json.clone()).map_err(|e| e.to_string())?;
            match file.items.iter().position(|x| x.id == one.id) {
                Some(at) => file.items[at] = incoming,
                None => file.items.push(incoming),
            }
            crate::store::mottos::save(store, &file)
        }
        k if k == merge::KIND_ARCHIVE => {
            let mut file = crate::store::archive::load(store)?;
            let incoming: crate::models::ArchiveEntry =
                serde_json::from_value(one.json.clone()).map_err(|e| e.to_string())?;
            match file.items.iter().position(|x| x.id == one.id) {
                Some(at) => file.items[at] = incoming,
                None => file.items.push(incoming),
            }
            crate::store::archive::save(store, &file)
        }
        k if k == merge::KIND_COUNTDOWN => {
            let mut file = crate::store::countdown::load(store)?;
            let incoming: crate::models::Countdown =
                serde_json::from_value(one.json.clone()).map_err(|e| e.to_string())?;
            match file.items.iter().position(|x| x.id == one.id) {
                Some(at) => file.items[at] = incoming,
                None => file.items.push(incoming),
            }
            crate::store::countdown::save(store, &file)
        }
        k if k == merge::KIND_INFO => {
            // info 是 jsonl：保持原文件顺序，只替换命中的那一行。
            let mut all = crate::store::info::read_all(store)?;
            let incoming: crate::models::Info =
                serde_json::from_value(one.json.clone()).map_err(|e| e.to_string())?;
            match all.iter().position(|x| x.id == one.id) {
                Some(at) => all[at] = incoming,
                None => all.push(incoming),
            }
            crate::store::info::write_all(store, &all)
        }
        other => Err(format!("不认识的记录种类：{other}（协议里没这一族）")),
    }
}

/// 本地删除一条记录（`apply_graves` 用）。
/// ⚠️ 待办走 `todo::delete`（它自己会埋墓碑）；笔记走 `note::delete`（进回收站）；其余从各自文件里摘掉。
fn delete_record(store: &Store, id: &str, kind: &str) -> Result<bool, String> {
    match kind {
        k if k == merge::KIND_TODO => crate::store::todo::delete(store, id),
        k if k == merge::KIND_NOTE => crate::store::note::delete(store, id),
        // 树 B：树节点墓碑 → 把这一枝从树里摘掉（见 [`delete_tree_node`]）。
        // ⚠️ 不是"删一篇笔记"：节点不是笔记，摘完这篇笔记还留着。
        k if k == merge::KIND_TREE_NODE => delete_tree_node(store, id),
        k if k == merge::KIND_DAILY => {
            let path = crate::store::dailies::path_for(store, id)?;
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
        // 🔴 2026-10-21：奖状删除也跨端了（跟 `awards::delete` 对称）。
        //    收到对面的墓碑 → 本地摘掉这条；**先留档**（跟本地删除同一条规矩）。
        k if k == merge::KIND_AWARD => {
            let mut file = crate::store::awards::load(store)?;
            let Some(at) = file.items.iter().position(|one| one.id == id) else {
                return Ok(false);
            };
            let raw = serde_json::to_string_pretty(&file.items[at])
                .map_err(|e| format!("序列化奖状失败：{e}"))?;
            crate::store::safety::archive(store, "奖状-删除前", "", &raw)?;
            file.items.remove(at);
            crate::store::awards::save(store, &file)?;
            Ok(true)
        }
        k if k == merge::KIND_REMINDER => {
            let mut file = crate::store::reminder::load(store)?;
            let before = file.items.len();
            file.items.retain(|x| x.id != id);
            let hit = file.items.len() != before;
            if hit {
                crate::store::reminder::save(store, &file)?;
            }
            Ok(hit)
        }
        k if k == merge::KIND_ANNOTATION => {
            let mut file = crate::store::annotations::load(store)?;
            let before = file.items.len();
            file.items.retain(|x| x.id != id);
            let hit = file.items.len() != before;
            if hit {
                crate::store::annotations::save(store, &file)?;
            }
            Ok(hit)
        }
        // 只进不出的族不做删除传播（协议 §5.2）→ 这里不该被调到
        _ => Ok(false),
    }
}

/// **落地合并计划**：要么全成、要么（尽量）全部还原
pub fn apply(store: &Store, plan: &Plan, theirs: &[Rec], theirs_graves: &[Grave]) -> Result<ApplyReport, String> {
    let snapshot = local_snapshot(store)?;
    let mut report = ApplyReport {
        snapshot: snapshot.to_string_lossy().to_string(),
        ..Default::default()
    };

    // ── 备份要动的文件（回滚用）：整份复制到快照目录旁边的一个 rollback 子目录
    let rollback = snapshot.join("_rollback");
    std::fs::create_dir_all(&rollback).map_err(|e| format!("建回滚目录失败：{e}"))?;
    let watched: Vec<PathBuf> = vec![
        store.data_dir().join("todos.json"),
        store.data_dir().join("reminders.json"),
        store.data_dir().join("annotations.json"),
        store.data_dir().join("awards.json"),
        store.data_dir().join("mottos.json"),
        store.data_dir().join("archive.json"),
        store.data_dir().join("countdowns.json"),
        store.data_dir().join("info.jsonl"),
        crate::store::sync::graves_path(store),
        store.data_dir().join("notes"),
        store.data_dir().join("dailies"),
    ];
    let mut saved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for one in &watched {
        if !one.exists() {
            continue;
        }
        let name = one
            .strip_prefix(store.data_dir())
            .unwrap_or(one)
            .to_string_lossy()
            .replace(['\\', '/'], "__");
        let to = rollback.join(name);
        crate::store::copy_recursive(one, &to).map_err(|e| e.to_string())?;
        saved.push((one.clone(), to));
    }

    let restore = |saved: &[(PathBuf, PathBuf)]| {
        for (orig, backup) in saved {
            if orig.is_dir() {
                let _ = std::fs::remove_dir_all(orig);
            } else {
                let _ = std::fs::remove_file(orig);
            }
            let _ = crate::store::copy_recursive(backup, orig);
        }
    };

    let by_id: BTreeMap<String, &Rec> = theirs.iter().map(|one| (one.id.clone(), one)).collect();

    // ── 0) 树 B（2026-10-07）：**先把对方报上来的「树节点」墓碑记下来**，再去采纳记录。
    //
    // 为什么非要在前面：第 1 步写树笔记时要逐节点合并，而合并要拿本地的墓碑清单判断
    // "哪些节点已经被删了、不许复活"。对方的墓碑本来要到第 3/4 步才落地 —— 晚一步的话，
    // 这一趟合并就会把对方**已经删掉**的节点当成"本地有、对方没有"给留下来（删除白删）。
    //
    // ⚠️ 只埋 `treenode` 这一族：别的 kind 的落地顺序一个字都没动。
    //    回滚也照旧兜得住 —— `graves.json` 就在下面的 `watched` 名单里，任一步失败都会连它一起还原。
    for g in theirs_graves
        .iter()
        .filter(|one| one.kind == merge::KIND_TREE_NODE)
    {
        if let Err(e) = sync::bury(store, &g.id, &g.kind) {
            restore(&saved);
            return Err(format!("记录树节点删除痕迹失败（已回滚）：{e}"));
        }
    }

    // ── 1) 采纳对方的记录
    for id in &plan.take_theirs {
        let Some(one) = by_id.get(id) else {
            restore(&saved);
            return Err(format!("对方清单里说有条 {id}，但拉取内容时没给 —— 中断并回滚"));
        };
        if let Err(e) = write_record(store, one) {
            restore(&saved);
            return Err(format!("写入 {id} 失败（已回滚）：{e}"));
        }
        report.adopted += 1;
    }

    // ── 1b) 树 B 补（2026-10-07）：**这一趟我赢的树笔记**（在 `send_mine` 里）也要并一次。
    //
    // 为什么非要有这一步：树笔记合的是"按节点 id 的并集"，"谁赢"只决定标题/正文归谁；
    // 而内容原本只往一个方向流 —— 我方赢的那些趟里，对方那份树根本不上来（`want` 里没有它），
    // 对方的节点就永远过不来（下一趟又被 `since` 闸门判成"两边都没动过"）。
    // 对方那份的**内容**由 `serve_hello` 一起要上来（`want`），这里负责把它并进本地那棵。
    //
    // ⚠️ 放在这个位置（在"要么全成要么回滚"的范围里）是刻意的：`restore` 兜得住（`notes/` 就在
    //    `watched` 名单里）。也正因为落地在这里，`serve_data` 回包时重新 `collect` 出来的就是
    //    **并过之后**的那份 —— 合并结果自然跟着回给手机（缺陷的另一半）。
    // ⚠️ 只认"两边都是树笔记"的那一种（`local_is_tree_note` + 对方那份 `kind == "tree"`）：
    //    别的 kind、别的记录，一个字节都不动。
    for one in theirs {
        if one.kind != merge::KIND_NOTE || !plan.send_mine.iter().any(|id| **id == one.id) {
            continue;
        }
        if !local_is_tree_note(store, &one.id) {
            continue;
        }
        if let Err(e) = merge_their_tree_nodes(store, &one.id, &one.json) {
            restore(&saved);
            return Err(format!("树笔记 {} 逐节点合并失败（已回滚）：{e}", one.id));
        }
    }

    // ── 2) 冲突：两份都留 → 生成「（冲突副本）」
    for Conflict { id, kind, reason, mine_at, theirs_at, title } in &plan.conflicts {
        // 🔴 树 B（2026-10-07）：**树笔记的冲突在节点里留痕，不再整份复制一篇笔记**。
        //
        // 为什么改：逐节点合并本身已经把"两边的字都留着"做到了（同一节点文字不同 → 对方那段
        // 变成「（冲突副本）」子节点），再复制一整篇只会让用户看到两棵几乎一样的树；而且两端
        // 各自复制一份（id 各不相同）→ 下一趟同步又会互相采纳 → 笔记越滚越多（实测过这条路）。
        //
        // ⚠️ 三个条件缺一不可，别的 kind / 别的情况一个字节都不改：
        //   ① 不是 `deleted_but_modified`（那时本地这份已经被删了，必须照旧走"整份复制 + 删除照样生效"）；
        //   ② 是笔记（`kind`），③ 本地这份**确实还在**且是树笔记（`local_is_tree_note`）。
        if reason != "deleted_but_modified"
            && kind == merge::KIND_NOTE
            && local_is_tree_note(store, id)
        {
            if let Some(src) = by_id.get(id).copied() {
                match merge_tree_note(store, id, &src.json) {
                    Ok(Some((merged, node_conflicts))) => {
                        let path = crate::store::note::note_path(store, id);
                        if let Err(e) = atomic::atomic_write_json(&path, &merged) {
                            restore(&saved);
                            return Err(format!("树笔记 {id} 逐节点合并落盘失败（已回滚）：{e}"));
                        }
                        // 节点级的副本标题也进账单：界面上那句"多了一份副本"要说清是哪段文字
                        for one in node_conflicts {
                            report.copies.push(one.copy_title);
                        }
                        continue;
                    }
                    Ok(None) => {} // 落不下去（对方那份不是树笔记等）→ 照旧走下面的整份复制
                    Err(e) => {
                        restore(&saved);
                        return Err(format!("树笔记 {id} 合并失败（已回滚）：{e}"));
                    }
                }
            }
        }
        // 副本来源：`same_moment` → 取"输的那一份"（时间较旧的那边）；
        //          `deleted_but_modified` → 取"改过的那一份"（它就是被删的那条的内容）
        let source: Option<&Rec> = if reason == "deleted_but_modified" {
            by_id.get(id).copied()
        } else if sync::newer_wins(theirs_at, mine_at) {
            by_id.get(id).copied() // 对方更新 → 我方那份是"输的" → 把我方存成副本
                .or(None)
        } else {
            by_id.get(id).copied() // 我方更新 → 对方那份存成副本（本来就来自对方）
        };
        let Some(src) = source else {
            restore(&saved);
            return Err(format!("冲突 {id} 找不到副本来源 —— 中断并回滚"));
        };
        let mut json = src.json.clone();
        let copy_title_text = merge::copy_title(title, &now_iso());
        // 🔴 2026-10-06 修的真 bug：**每日报告的 `id` 就是日期**（`dailies/<YYYY-MM-DD>.json`），
        //    给它换个 UUID 当副本 id，写盘时被日期校验拒掉（"日期格式不对（要 YYYY-MM-DD）：<uuid>"）
        //    → **整次同步失败并回滚**（实测撞到：`/data` 被拒 400）。
        //    协议 §5.2 对这种情况写的就是「同一天两边都改过 → 存成 `YYYY-MM-DD（冲突副本）.json`」。
        let new_id = if kind == merge::KIND_DAILY {
            // 时间戳要去掉冒号（Windows 文件名不允许），只取到分钟
            let stamp = now_iso().get(0..16).unwrap_or("").replace('T', " ").replace(':', "-");
            format!("{id}{COPY_SUFFIX}{stamp}")
        } else {
            merge::copy_id()
        };
        if let Some(obj) = json.as_object_mut() {
            obj.insert("id".into(), Value::String(new_id.clone()));
            if obj.contains_key("title") {
                obj.insert("title".into(), Value::String(copy_title_text.clone()));
            }
            if obj.contains_key("text") {
                // 格言/信息这类没有 title 的：在正文前加个标记，用户一眼能看出是副本
                let old = obj.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                obj.insert("text".into(), Value::String(format!("{COPY_SUFFIX} {old}")));
            }
            if obj.contains_key("updatedAt") {
                obj.insert("updatedAt".into(), Value::String(now_iso()));
            }
        }
        let copy = Rec {
            kind: kind.clone(),
            id: new_id,
            updated_at: now_iso(),
            json,
        };
        if let Err(e) = write_record(store, &copy) {
            restore(&saved);
            return Err(format!("生成冲突副本失败（已回滚）：{e}"));
        }
        report.copies.push(copy_title_text);
    }

    // ── 3) 落地删除（对方删了、我该跟着删）
    for g in &plan.apply_graves {
        match delete_record(store, &g.id, &g.kind) {
            Ok(hit) => {
                if hit {
                    report.deleted += 1;
                }
            }
            Err(e) => {
                restore(&saved);
                return Err(format!("删除 {} 失败（已回滚）：{e}", g.id));
            }
        }
        // ⚠️ 墓碑也要记下来：不然"以后别人又把这条传回来"时会被复活
        if let Err(e) = sync::bury(store, &g.id, &g.kind) {
            restore(&saved);
            return Err(format!("记录删除痕迹失败（已回滚）：{e}"));
        }
    }
    // 对方独有的墓碑也照录（`plan.apply_graves` 已经把两边并起来了）

    // ── 4) 对方给我的墓碑（可能不在 apply_graves 里，但同步协议要求"删除也算一条记录"）
    for g in theirs_graves {
        let _ = sync::bury(store, &g.id, &g.kind);
    }

    if let Err(e) = crate::store::archive::repair_missing_note_files(store) {
        restore(&saved);
        return Err(format!("修复档案笔记文件失败（已回滚）：{e}"));
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sync_merge::{GraveMeta, Entry};

    fn rec_todo(id: &str, at: &str, title: &str) -> Rec {
        rec(
            merge::KIND_TODO,
            id,
            at,
            serde_json::json!({
                "id": id, "title": title, "order": 0, "status": "open",
                "createdAt": at, "updatedAt": at, "focusNote": "", "pomodoros": [], "subtasks": []
            }),
        )
    }

    // ── 引擎×应用 的接口级测试（磁盘部分用临时目录，不碰用户数据）
    #[test]
    fn plan_to_apply_adopts_newer_todo() {
        let store = crate::store::temp_store("m23-apply-adopt");
        // 我这边先有一条旧的
        let mut file = crate::store::todo::load(&store).unwrap();
        let mine: Todo = serde_json::from_value(rec_todo("t1", "2026-10-06T10:00:00+08:00", "旧标题").json).unwrap();
        file.items.push(mine);
        crate::store::todo::save(&store, &file).unwrap();

        let theirs = vec![rec_todo("t1", "2026-10-06T12:00:00+08:00", "新标题")];
        let plan = merge::plan(
            &collect(&store).unwrap().records,
            &theirs,
            &[],
            &[],
        );
        assert_eq!(plan.take_theirs, vec!["t1".to_string()]);
        let report = apply(&store, &plan, &theirs, &[]).unwrap();
        assert_eq!(report.adopted, 1);
        let after = crate::store::todo::list(&store).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].title, "新标题", "整条赢（不做字段缝合）");
    }

    #[test]
    fn apply_creates_conflict_copy_with_suffix() {
        let store = crate::store::temp_store("m23-apply-copy");
        let theirs = vec![rec_todo("t1", "2026-10-06T11:00:00+08:00", "他改的")];
        let mine = vec![rec_todo("t1", "2026-10-06T11:00:00+08:00", "我改的")];
        let plan = merge::plan(&mine, &theirs, &[], &[]);
        assert_eq!(plan.conflicts.len(), 1);
        let report = apply(&store, &plan, &theirs, &[]).unwrap();
        assert_eq!(report.copies.len(), 1);
        assert!(report.copies[0].contains(COPY_SUFFIX));
        let after = crate::store::todo::list(&store).unwrap();
        assert_eq!(after.len(), 1, "副本进的是文件，但列表里应当能看到它（共 1 条）");
    }

    #[test]
    fn apply_deletes_when_their_grave_covers() {
        let store = crate::store::temp_store("m23-apply-del");
        let mut file = crate::store::todo::load(&store).unwrap();
        let mine: Todo = serde_json::from_value(rec_todo("t1", "2026-10-06T10:00:00+08:00", "要删的").json).unwrap();
        file.items.push(mine);
        crate::store::todo::save(&store, &file).unwrap();

        let theirs_graves = vec![Grave { id: "t1".into(), kind: merge::KIND_TODO.into(), deleted_at: "2026-10-06T12:00:00+08:00".into() }];
        let plan = merge::plan(&collect(&store).unwrap().records, &[], &[], &theirs_graves);
        let report = apply(&store, &plan, &[], &theirs_graves).unwrap();
        assert_eq!(report.deleted, 1);
        assert!(crate::store::todo::list(&store).unwrap().is_empty(), "该删掉");
        // 删除痕迹也要留下（防复活）
        assert!(sync::list(&store).unwrap().iter().any(|g| g.id == "t1"));
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let store = crate::store::temp_store("m23-apply-unknown");
        let bad = rec("config", "x", "2026-10-06T10:00:00+08:00", serde_json::json!({"a":1}));
        let err = write_record(&store, &bad).unwrap_err();
        assert!(err.contains("不认识"), "协议外的族必须被拒收：{err}");
    }

    #[test]
    fn records_for_only_returns_requested_ids() {
        let store = crate::store::temp_store("m23-records-for");
        let mut file = crate::store::todo::load(&store).unwrap();
        for (id, t) in [("a", "甲"), ("b", "乙")] {
            let one: Todo = serde_json::from_value(rec_todo(id, "2026-10-06T10:00:00+08:00", t).json).unwrap();
            file.items.push(one);
        }
        crate::store::todo::save(&store, &file).unwrap();
        let got = records_for(&store, &["a".to_string()]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "a");
    }

    #[test]
    fn collect_skips_missing_files_gracefully() {
        let store = crate::store::temp_store("m23-collect-empty");
        let got = collect(&store).unwrap();
        assert!(got.records.is_empty(), "空目录不该报错，也不该凭空造记录");
    }

    #[test]
    fn manifest_of_collected_has_no_payload() {
        let store = crate::store::temp_store("m23-manifest");
        let mut file = crate::store::todo::load(&store).unwrap();
        let one: Todo = serde_json::from_value(rec_todo("secret", "2026-10-06T10:00:00+08:00", "别泄露我").json).unwrap();
        file.items.push(one);
        crate::store::todo::save(&store, &file).unwrap();
        let got = collect(&store).unwrap();
        let m = merge::manifest_of("dev", &got.records, &got.graves, sync::PROTOCOL_VERSION);
        let text = serde_json::to_string(&m).unwrap();
        assert!(!text.contains("别泄露我"));
    }

    #[test]
    fn entry_shape_matches_manifest_contract() {
        let e = Entry { kind: merge::KIND_TODO.into(), id: "a".into(), updated_at: "2026-10-06T10:00:00+08:00".into() };
        let text = serde_json::to_string(&e).unwrap();
        assert!(text.contains("\"updatedAt\""), "协议字段名是 camelCase：{text}");
        let g = GraveMeta { id: "a".into(), kind: "todo".into(), deleted_at: "x".into() };
        assert!(serde_json::to_string(&g).unwrap().contains("\"deletedAt\""));
    }
}
#[cfg(test)]
mod m23_daily_copy_tests {
    use crate::models::now_iso;
    use crate::store::sync_apply;

    /// 🔴 防回归（2026-10-06 修的真 bug）：**每日报告的冲突副本必须写得进去**。
    ///    原来给副本换 UUID → `dailies::path_for` 的日期校验直接拒 → 整次同步失败并回滚。
    ///    现在：副本 id = `日期（冲突副本）时间`，写盘直写；正本仍走日期校验。
    #[test]
    fn daily_conflict_copy_is_writable() {
        let store = crate::store::temp_store("m23-daily-copy");
        let date = "2026-10-06";
        crate::store::dailies::set_note(&store, date, "day", "正本的小结").expect("写正本日报");
        let copy_id = format!("{}{}2026-10-06 01-30", date, crate::store::sync_merge::COPY_SUFFIX);
        let mut json = serde_json::to_value(crate::store::dailies::load(&store, date).expect("读正本"))
            .expect("序列化");
        if let Some(obj) = json.as_object_mut() {
            obj.insert("date".into(), serde_json::Value::String(copy_id.clone()));
            obj.insert("updatedAt".into(), serde_json::Value::String(now_iso()));
        }
        let rec = crate::store::sync_merge::Rec {
            kind: crate::store::sync_merge::KIND_DAILY.to_string(),
            id: copy_id.clone(),
            updated_at: now_iso(),
            json,
        };
        let got = sync_apply::write_record(&store, &rec);
        assert!(got.is_ok(), "冲突副本必须写得进去：{got:?}");
        let path = crate::store::dailies::dir(&store).join(format!("{copy_id}.json"));
        assert!(path.exists(), "副本文件应当落在 dailies/ 下：{path:?}");
        let main = crate::store::dailies::load(&store, date).expect("正本还在");
        assert_eq!(main.notes.len(), 1, "正本的笔记不该被动");
    }
}


/// 🔴 P0-1（2026-10-06）回归钉子：**更空的树不许覆盖本地更全的树**。
#[cfg(test)]
mod p01_tree_guard {
    use super::*;
    use crate::models::{NoteKind, TreeNode};
    use crate::store::temp_store;

    #[test]
    fn 更空的树不许覆盖本地更全的树() {
        let store = temp_store("p01-tree-guard");
        let note = crate::store::note::create(&store, NoteKind::Tree, "本地树".into()).unwrap();
        let mut local = note.clone();
        let mut root = TreeNode::new("中心主题");
        root.children.push(TreeNode::new("A"));
        root.children.push(TreeNode::new("B（电脑后加的）"));
        local.root = Some(root);
        crate::store::note::save(&store, &local).unwrap();

        // 模拟"手机那份"：只有中心主题 + A（旧副本），但**时间更新、正文是他改的**
        let mut incoming = local.clone();
        incoming.updated_at = now_iso();
        incoming.content = "手机改的正文".into();
        let mut short_root = TreeNode::new("中心主题");
        short_root.children.push(TreeNode::new("A"));
        incoming.root = Some(short_root);

        let rec = Rec {
            kind: merge::KIND_NOTE.to_string(),
            id: note.id.clone(),
            updated_at: incoming.updated_at.clone(),
            json: serde_json::to_value(&incoming).unwrap(),
        };
        write_record(&store, &rec).unwrap();

        let after = crate::store::note::get(&store, &note.id).unwrap().unwrap();
        assert_eq!(after.content, "手机改的正文", "正文该更新（手机改的字要传过来）");
        let kids: Vec<String> = after
            .root
            .as_ref()
            .unwrap()
            .children
            .iter()
            .map(|n| n.text.clone())
            .collect();
        assert!(
            kids.iter().any(|t| t.contains("B")),
            "🔴 本地更全的树被更空的覆盖了（P0-1 复发）：{kids:?}"
        );
    }

    /// 树 B 补的钉子：对方那份树笔记**根本没有 root**（坏文件 / 老文件）时，
    /// 合并结果必须是**本地那棵** —— 绝不许因为"对方缺根"就把本地整棵树写成 `null`。
    #[test]
    fn 对方缺根时不许把本地的树写没() {
        let store = temp_store("tree-b-incoming-noroot");
        let note = crate::store::note::create(&store, NoteKind::Tree, "本地树".into()).unwrap();
        let mut local = note.clone();
        let mut root = TreeNode::new("中心主题");
        root.children.push(TreeNode::new("本地节点"));
        local.root = Some(root);
        crate::store::note::save(&store, &local).unwrap();

        let mut incoming = local.clone();
        incoming.root = None; // 对方手上那份是坏树（没有根）
        incoming.content = "手机改的正文".into();
        let rec = Rec {
            kind: merge::KIND_NOTE.to_string(),
            id: note.id.clone(),
            updated_at: now_iso(),
            json: serde_json::to_value(&incoming).unwrap(),
        };
        write_record(&store, &rec).unwrap();

        let after = crate::store::note::get(&store, &note.id).unwrap().unwrap();
        assert_eq!(after.content, "手机改的正文", "正文该照旧更新");
        let root = after.root.expect("🔴 本地的根被写成了 null");
        assert_eq!(root.text, "中心主题");
        assert_eq!(root.children[0].text, "本地节点", "本地的节点一个都不许少");
    }
}
#[cfg(test)]
mod award_write_tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn 奖状_收到较新的记录_整条替换而不是新增() {
        let store = temp_store("award-write-record");
        let one = crate::store::awards::create(&store, "旧标题".into()).unwrap();
        let mut incoming = one.clone();
        incoming.title = "新标题".into();
        incoming.note = "新寄语".into();
        incoming.asset_path = Some("assets/9be034d5.png".into());
        incoming.updated_at = "2026-10-21T23:59:00+08:00".into();
        let record = rec(
            merge::KIND_AWARD,
            &one.id,
            &incoming.updated_at,
            serde_json::to_value(&incoming).unwrap(),
        );
        write_record(&store, &record).unwrap();
        let back = crate::store::awards::list(&store).unwrap();
        assert_eq!(back.len(), 1, "同一条不该变成两条");
        assert_eq!(back[0].title, "新标题");
        assert_eq!(back[0].note, "新寄语");
        assert_eq!(back[0].asset_path.as_deref(), Some("assets/9be034d5.png"));
    }
}
