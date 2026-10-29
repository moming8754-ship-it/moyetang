//! 同步的**数据层地基**（M21 / v2.11.0）
//!
//! 这个模块只干三件事，**不做合并**（合并引擎是 M23 的事）：
//!
//! 1. 🔴 **删除记录（墓碑）** —— `<数据目录>/sync/graves.json`
//!    每条只记 `id + deletedAt + kind`，**不存内容**；留 [`GRAVE_KEEP_DAYS`] = 180 天。
//!    为什么非要有它：《同步协议》§5.1 第 2 条 —— 没有它，一边删掉的东西会被另一边
//!    "传回来复活"（删了就是删了，得有痕迹）。
//! 2. **设备状态** —— `<数据目录>/sync/state.json`：设备 id（第一次用到时生成）、
//!    上次同步时间、协议版本。
//! 3. **两条纯判定**（只提供、不负责用）：[`newer_wins`]（谁最后改的听谁的）、
//!    [`same_moment`]（**时钟容差**：两台设备的钟差在 [`CLOCK_TOLERANCE_SECONDS`] 内算"同时改"，
//!    这种时候**不硬判谁赢**，交给 M23 走"两份都留"）。
//!
//! # ⚠️ 新数据文件必须登记两处（老规矩，漏一个就出事）
//! `sync` 已同时进：
//! - `store::backup` 的 `ENTRIES`（导出备份要带上）
//! - `store` 的 `DATA_ENTRIES`（换数据目录要带上）+ `SUB_DIRS`（建目录时一起建）

use chrono::{DateTime, Duration, Local};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::{atomic, safety, Store};

/// 协议版本：改《同步协议》的语义时要 +1（M22/M23 会把它写进二维码/握手）
pub const PROTOCOL_VERSION: u32 = 1;

/// 删除记录留多久（《同步协议》§十四 默认值：180 天 —— 够两台设备对上账，又不至于越积越多）
pub const GRAVE_KEEP_DAYS: i64 = 180;

/// 时钟容差（秒）：两台设备的钟差在这个范围内算"同时改"
#[allow(dead_code)]  // 只被 same_moment 与单测用
pub const CLOCK_TOLERANCE_SECONDS: i64 = 120;

/// 子目录名（数据目录下一层）
pub const SYNC_DIR: &str = "sync";
const GRAVES_FILE: &str = "graves.json";
const STATE_FILE: &str = "state.json";

/// 一条删除记录。
///
/// ⚠️ **只记"谁、什么时候、删了哪种东西"** —— 不存标题、不存内容。
/// 这是刻意的：墓碑要参与同步，存了内容等于"删掉的东西又被传了回来"。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grave {
    /// 被删掉那条东西的 id（与 `Todo.id` / `Note.id` 同一个空间）
    pub id: String,
    /// 删除时刻（本地时区的 ISO 串，跟全项目一致）
    pub deleted_at: String,
    /// `"todo"` | `"note"` | `"archive"`
    pub kind: String,
}

/// `sync/graves.json` 的整体
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GraveFile {
    pub items: Vec<Grave>,
}

/// 设备状态（`sync/state.json`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// 设备 id：**第一次用到时生成一次，之后永远不变**（M23 用它区分"这份是谁的"）
    pub device_id: String,
    /// 上次同步时间（空串 = 还没同步过）
    pub last_sync_at: String,
    pub protocol_version: u32,
}

/// `<数据目录>/sync`
pub fn dir(store: &Store) -> PathBuf {
    store.data_dir().join(SYNC_DIR)
}

/// `<数据目录>/sync/graves.json`
pub fn graves_path(store: &Store) -> PathBuf {
    dir(store).join(GRAVES_FILE)
}

/// `<数据目录>/sync/state.json`
pub fn state_path(store: &Store) -> PathBuf {
    dir(store).join(STATE_FILE)
}

/// 读删除记录（文件不在 / 坏掉 → 当成空的，**绝不因为墓碑读不出来就让主流程失败**）
pub fn load_graves(store: &Store) -> Result<GraveFile, String> {
    // ⚠️ **宽容**：墓碑文件不在 / 坏掉 → 当成"没有删除记录"，**绝不把主流程带崩**
    //    （删待办、删笔记都要先埋墓碑 —— 要是这里返回 Err，用户会发现"删不掉了"）。
    //    真丢了删除记录的代价是"对面可能把已删的东西传回来"，由下面两道兜着：
    //    ① 180 天窗口（[`GRAVE_KEEP_DAYS`]）；② 同步时的对账（M23）。
    match atomic::read_json::<GraveFile>(&graves_path(store)) {
        Ok(found) => Ok(found.unwrap_or_default()),
        Err(e) => {
            eprintln!("[东方摩耶堂] 删除记录读不出来（当空的处理）：{e}");
            Ok(GraveFile::default())
        }
    }
}

/// 写删除记录（原子写；目录不在就建）
pub fn save_graves(store: &Store, file: &GraveFile) -> Result<(), String> {
    let dir = dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    atomic::atomic_write_json(&graves_path(store), file)
}

/// 埋一条删除记录。
///
/// 规矩：
/// - **同一条 id 已经埋过 → 只更新时间**（重复删同一条不该长出两条，否则对方要判两次）；
/// - 顺手把超过 [`GRAVE_KEEP_DAYS`] 的老记录清掉（**只清墓碑，不动任何内容**）。
pub fn bury(store: &Store, id: &str, kind: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Ok(()); // 空 id 没什么可埋的，也不该报错打断删除流程
    }
    let mut file = load_graves(store)?;
    let now = crate::models::now_iso();
    match file.items.iter_mut().find(|one| one.id == id) {
        // 已经埋过：顺手更正 kind（先当笔记后当档案这种极端情况，按最后一次为准）
        Some(found) => {
            found.deleted_at = now;
            found.kind = kind.to_string();
        }
        None => file.items.push(Grave {
            id: id.to_string(),
            deleted_at: now,
            kind: kind.to_string(),
        }),
    }
    prune(&mut file, Local::now());
    save_graves(store, &file)
}

/// 删除记录列表（**新的在前**，给界面/诊断用）
pub fn list(store: &Store) -> Result<Vec<Grave>, String> {
    let mut items = load_graves(store)?.items;
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| a.id.cmp(&b.id)));
    Ok(items)
}

/// 手动清空删除记录（返回清掉几条）。
///
/// ⚠️ 这是**真删** → 照项目规矩**先留档**（`backups/同步-删除记录清空前-*.json`），留档失败就中止。
/// ⚠️ 清掉之后，"另一边已经删过的东西"就可能被重新传回来 —— 界面上要说清这一点。
pub fn purge(store: &Store) -> Result<usize, String> {
    let file = load_graves(store)?;
    if file.items.is_empty() {
        return Ok(0);
    }
    let raw = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    safety::archive(store, "同步-删除记录清空前", "", &raw)?;
    let removed = file.items.len();
    save_graves(store, &GraveFile::default())?;
    Ok(removed)
}

/// 只保留最近 [`GRAVE_KEEP_DAYS`] 天的记录（纯函数，好测）
pub fn prune(file: &mut GraveFile, now: DateTime<Local>) {
    let cutoff = now - Duration::days(GRAVE_KEEP_DAYS);
    file.items.retain(|one| match parse_at(&one.deleted_at) {
        // 时间读不出来（脏数据）→ **留着**：宁可多留一条，也别把"删过"这件事弄丢
        None => true,
        Some(at) => at >= cutoff,
    });
}

/// 读设备状态；**没有就生成一个 device id 落盘**（第一次同步之前就该有）
pub fn state_get(store: &Store) -> Result<SyncState, String> {
    // 同样宽容：state.json 坏掉 → 重新生成一份（设备 id 变了不影响正确性，只影响"这份是谁的"的记账）
    let found_state = atomic::read_json::<SyncState>(&state_path(store)).unwrap_or_else(|e| {
        eprintln!("[东方摩耶堂] 设备状态读不出来（重新生成一份）：{e}");
        None
    });
    if let Some(found) = found_state {
        if !found.device_id.trim().is_empty() {
            return Ok(found);
        }
    }
    let fresh = SyncState {
        device_id: uuid::Uuid::new_v4().to_string(),
        last_sync_at: String::new(),
        protocol_version: PROTOCOL_VERSION,
    };
    save_state(store, &fresh)?;
    Ok(fresh)
}

/// 写设备状态
pub fn save_state(store: &Store, state: &SyncState) -> Result<(), String> {
    let dir = dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    atomic::atomic_write_json(&state_path(store), state)
}

/// 记下"刚刚同步过一次"（M23 完成同步时调；现在先留好接口 + 单测）
#[allow(dead_code)]  // M23 的同步流程才会调它（现在由单测覆盖）
pub fn mark_synced(store: &Store, at: &str) -> Result<SyncState, String> {
    let mut state = state_get(store)?;
    state.last_sync_at = at.to_string();
    state.protocol_version = PROTOCOL_VERSION;
    save_state(store, &state)?;
    Ok(state)
}

// ─────────────────────────── 两条纯判定（M23 合并引擎会用） ───────────────────────────

/// 解析项目里那种本地时区 ISO 串（读不出来就 `None`，调用方自己决定怎么兜底）
pub fn parse_at(text: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(text.trim())
        .ok()
        .map(|one| one.with_timezone(&Local))
}

/// **谁最后改的听谁的**：`mine` 比 `theirs` 新 → `true`。
///
/// 兜底规矩（都很实用，别改）：
/// - 两边时间**读不出来** → 谁也别赢（`false`），让对方那份留着；
/// - `theirs` 读不出来而 `mine` 能读 → `mine` 赢（有时间的比没时间的可信）；
/// - 两个时间**差在 [`CLOCK_TOLERANCE_SECONDS`] 以内** → 算"同时改"，**不判谁赢**（`false`，
///   交给 M23 走"两份都留"）；
/// - 完全相等 → `false`（没有"新的"，别白覆盖一次）。
#[allow(dead_code)]
pub fn newer_wins(mine: &str, theirs: &str) -> bool {
    let (Some(a), Some(b)) = (parse_at(mine), parse_at(theirs)) else {
        return match (parse_at(mine), parse_at(theirs)) {
            (Some(_), None) => true, // 我这有明确时间，对方没有 → 我赢
            _ => false,
        };
    };
    if same_moment(a.to_rfc3339().as_str(), b.to_rfc3339().as_str()) {
        return false;
    }
    a > b
}

/// **严格更新**（2026-10-06 加，P0-1 连带修）：`mine` 比 `theirs` 晚，**不做 2 分钟容差**。
///
/// # 为什么要单开一个（真 bug）
/// 上面 [`newer_wins`] 对"差在 2 分钟内"的两个时间**一律返回 false**（那是给"两边同时改、
/// 分不清谁赢"用的，本身没错）。但 **`since` 闸门也拿它比** ——
/// 于是"**上次同步之后 2 分钟内改的那条记录**"会被判成"没改过" → 整个计划里什么都不做 →
/// 那条改动**永远同步不出去**（因为它的 `updatedAt` 之后再也不会变，下次同步照样被判"没改"）。
/// 2026-10-06 的双目录端到端测试就是这么撞出来的（账单：补过来 0 / 传过去 0）。
///
/// 闸门要问的是"**这条在上次同步之后动过吗**"，这是**事实判断**，不该带容差 → 用这个函数。
/// 读不出来（时间格式坏）时**一律算"动过"**：宁可多同步一次，也不能静默漏掉。
pub fn strictly_newer(mine: &str, theirs: &str) -> bool {
    match (parse_at(mine), parse_at(theirs)) {
        (Some(a), Some(b)) => a > b,
        // 只要有一边读不出来 → 当作"动过"（安全方向：同步是无害的，漏掉才致命）
        _ => true,
    }
}
/// **时钟容差**：两个时间差在 [`CLOCK_TOLERANCE_SECONDS`] 内（含）算"同一时刻"。
/// 读不出来的时间一律按"不是同一时刻"处理（让上层走"谁新听谁"）。
#[allow(dead_code)]
pub fn same_moment(a: &str, b: &str) -> bool {
    match (parse_at(a), parse_at(b)) {
        (Some(x), Some(y)) => (x - y).num_seconds().abs() <= CLOCK_TOLERANCE_SECONDS,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    fn iso(offset_secs: i64) -> String {
        (Local::now() + Duration::seconds(offset_secs)).to_rfc3339()
    }

    #[test]
    fn bury_records_id_time_kind_and_nothing_else() {
        let store = temp_store("m21-bury");
        bury(&store, "t-1", "todo").unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "t-1");
        assert_eq!(items[0].kind, "todo");
        assert!(parse_at(&items[0].deleted_at).is_some(), "删除时间必须是能读的时间");
        // 墓碑里**不该**有内容字段（序列化出来只有三个键）
        let raw = serde_json::to_string(&items[0]).unwrap();
        assert!(!raw.contains("title"), "墓碑不许存内容：{raw}");
        assert!(raw.contains("deletedAt"), "字段名必须是 camelCase：{raw}");
    }

    #[test]
    fn bury_same_id_twice_updates_instead_of_duplicating() {
        let store = temp_store("m21-bury-twice");
        bury(&store, "t-2", "todo").unwrap();
        let first = list(&store).unwrap()[0].deleted_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        bury(&store, "t-2", "todo").unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1, "同一条 id 埋两次不该长两条");
        assert!(items[0].deleted_at >= first);
    }

    #[test]
    fn bury_empty_id_is_a_noop_not_an_error() {
        let store = temp_store("m21-bury-empty");
        bury(&store, "   ", "todo").unwrap();
        assert!(list(&store).unwrap().is_empty());
    }

    #[test]
    fn bury_keeps_kinds_apart_by_id() {
        let store = temp_store("m21-bury-kinds");
        bury(&store, "x-1", "todo").unwrap();
        bury(&store, "x-2", "note").unwrap();
        bury(&store, "x-3", "archive").unwrap();
        let kinds: Vec<String> = list(&store).unwrap().into_iter().map(|one| one.kind).collect();
        assert!(kinds.contains(&"todo".to_string()));
        assert!(kinds.contains(&"note".to_string()));
        assert!(kinds.contains(&"archive".to_string()));
    }

    #[test]
    fn prune_drops_records_older_than_keep_days() {
        let mut file = GraveFile {
            items: vec![
                Grave { id: "old".into(), deleted_at: iso(-(GRAVE_KEEP_DAYS * 86400 + 3600)), kind: "todo".into() },
                Grave { id: "edge".into(), deleted_at: iso(-(GRAVE_KEEP_DAYS * 86400 - 3600)), kind: "todo".into() },
                Grave { id: "new".into(), deleted_at: iso(-60), kind: "todo".into() },
            ],
        };
        prune(&mut file, Local::now());
        let ids: Vec<&str> = file.items.iter().map(|one| one.id.as_str()).collect();
        assert!(!ids.contains(&"old"), "超过 180 天的该清掉");
        assert!(ids.contains(&"edge"), "刚好在 180 天内的要留着");
        assert!(ids.contains(&"new"));
    }

    #[test]
    fn prune_keeps_records_with_unreadable_time() {
        let mut file = GraveFile {
            items: vec![Grave { id: "broken".into(), deleted_at: "不是时间".into(), kind: "todo".into() }],
        };
        prune(&mut file, Local::now());
        assert_eq!(file.items.len(), 1, "时间读不出来宁可留着，别把'删过'弄丢");
    }

    #[test]
    fn bury_prunes_old_ones_automatically() {
        let store = temp_store("m21-bury-prune");
        let mut file = load_graves(&store).unwrap();
        file.items.push(Grave { id: "ancient".into(), deleted_at: iso(-(GRAVE_KEEP_DAYS * 86400 + 7200)), kind: "todo".into() });
        save_graves(&store, &file).unwrap();
        bury(&store, "fresh", "todo").unwrap();
        let ids: Vec<String> = list(&store).unwrap().into_iter().map(|one| one.id).collect();
        assert!(!ids.contains(&"ancient".to_string()), "埋新的时候要顺手清掉过期的");
        assert!(ids.contains(&"fresh".to_string()));
    }

    #[test]
    fn list_is_newest_first() {
        let store = temp_store("m21-list-order");
        let mut file = GraveFile::default();
        file.items.push(Grave { id: "a".into(), deleted_at: iso(-300), kind: "todo".into() });
        file.items.push(Grave { id: "b".into(), deleted_at: iso(-10), kind: "todo".into() });
        save_graves(&store, &file).unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items[0].id, "b");
        assert_eq!(items[1].id, "a");
    }

    #[test]
    fn purge_empties_the_file_and_archives_first() {
        let store = temp_store("m21-purge");
        bury(&store, "t-9", "todo").unwrap();
        let removed = purge(&store).unwrap();
        assert_eq!(removed, 1);
        assert!(list(&store).unwrap().is_empty());
        // 留档：backups/ 下应该出现"同步-删除记录清空前"这一类文件
        let backups = store.data_dir().join("backups");
        let found = std::fs::read_dir(&backups)
            .map(|dir| {
                dir.filter_map(|one| one.ok())
                    .any(|one| one.file_name().to_string_lossy().contains("同步-删除记录清空前"))
            })
            .unwrap_or(false);
        assert!(found, "真删之前必须先留档");
    }

    #[test]
    fn purge_on_empty_is_zero() {
        let store = temp_store("m21-purge-empty");
        assert_eq!(purge(&store).unwrap(), 0);
    }

    #[test]
    fn load_graves_tolerates_missing_or_broken_file() {
        let store = temp_store("m21-load-broken");
        assert!(load_graves(&store).unwrap().items.is_empty(), "文件不在 = 空");
        std::fs::create_dir_all(dir(&store)).unwrap();
        std::fs::write(graves_path(&store), b"{ not json").unwrap();
        assert!(load_graves(&store).unwrap().items.is_empty(), "坏文件也不该让主流程炸");
    }

    #[test]
    fn state_get_generates_device_id_once_and_keeps_it() {
        let store = temp_store("m21-state");
        let first = state_get(&store).unwrap();
        assert!(!first.device_id.trim().is_empty());
        let second = state_get(&store).unwrap();
        assert_eq!(first.device_id, second.device_id, "设备 id 生成一次就该稳定");
        assert_eq!(first.protocol_version, PROTOCOL_VERSION);
        assert!(state_path(&store).is_file(), "state.json 要真的落盘");
    }

    #[test]
    fn state_with_blank_device_id_is_regenerated() {
        let store = temp_store("m21-state-blank");
        save_state(&store, &SyncState { device_id: "  ".into(), last_sync_at: String::new(), protocol_version: 0 }).unwrap();
        let fixed = state_get(&store).unwrap();
        assert!(!fixed.device_id.trim().is_empty(), "空的设备 id 要补一个");
        assert_eq!(fixed.protocol_version, PROTOCOL_VERSION);
    }

    #[test]
    fn mark_synced_records_time_and_keeps_device_id() {
        let store = temp_store("m21-mark-synced");
        let before = state_get(&store).unwrap();
        let after = mark_synced(&store, "2026-10-06T12:00:00+08:00").unwrap();
        assert_eq!(after.last_sync_at, "2026-10-06T12:00:00+08:00");
        assert_eq!(after.device_id, before.device_id);
        assert_eq!(state_get(&store).unwrap().last_sync_at, "2026-10-06T12:00:00+08:00");
    }

    #[test]
    fn newer_wins_basic() {
        assert!(newer_wins(&iso(-10), &iso(-3600)), "更新的赢");
        assert!(!newer_wins(&iso(-3600), &iso(-10)), "更旧的不赢");
    }

    #[test]
    fn newer_wins_equal_times_is_false() {
        let one = Local::now().to_rfc3339();
        assert!(!newer_wins(&one, &one), "时间一样就不该判谁赢");
    }

    #[test]
    fn newer_wins_within_tolerance_is_false() {
        // 差 60 秒 < 容差 120 秒 → 算同时改，不判谁赢
        assert!(!newer_wins(&iso(-60), &iso(-120)));
        assert!(!newer_wins(&iso(-120), &iso(-60)));
    }

    #[test]
    fn newer_wins_outside_tolerance_compares_normally() {
        // 差 10 分钟 > 容差 → 正常比
        assert!(newer_wins(&iso(-600), &iso(-1200)));
        assert!(!newer_wins(&iso(-1200), &iso(-600)));
    }

    #[test]
    fn newer_wins_with_unreadable_times_is_conservative() {
        assert!(!newer_wins("", ""), "两边都读不出来 → 谁也别赢");
        assert!(!newer_wins("坏了", "也坏了"));
        assert!(newer_wins(&iso(-10), ""), "我有时间、对方没有 → 我赢");
        assert!(!newer_wins("", &iso(-10)), "反过来不赢");
    }

    #[test]
    fn same_moment_boundary() {
        assert!(same_moment(&iso(-1), &iso(-1)));
        assert!(same_moment(&iso(-CLOCK_TOLERANCE_SECONDS), &iso(0)), "刚好卡在容差上算同一时刻");
        assert!(!same_moment(&iso(-(CLOCK_TOLERANCE_SECONDS + 5)), &iso(0)));
        assert!(!same_moment("坏了", &iso(0)), "读不出来一律不算同一时刻");
    }

    #[test]
    fn parse_at_accepts_project_iso_and_rejects_junk() {
        assert!(parse_at("2026-10-06T12:00:00+08:00").is_some());
        assert!(parse_at("").is_none());
        assert!(parse_at("2026-10-06").is_none(), "只有日期没有时刻 → 不算（项目里时间一律带时区）");
    }
}
