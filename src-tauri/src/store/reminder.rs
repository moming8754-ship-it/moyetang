//! 提醒（`reminders.json`）。
//!
//! 45 分钟提醒的工作方式（"排期 → 到点弹出"两段式，好处是可测、可去重）：
//!
//! 1. 扫描时，凡「状态还是待联动、且创建已超过 N 分钟」的信息，若还没有对应提醒，
//!    就**排一条** `status=pending`、`fireAt=创建时间+N 分钟`；
//! 2. 同一趟扫描里，凡是 `pending` 且已到点的，标成 `fired` 并**返回给调用方去广播**；
//! 3. 信息一旦被联动，它的待弹提醒自动标成 `dismissed`（不用再催了）；
//! 4. 信息被删掉，对应提醒一并清掉；
//! 5. 「稍后提醒」= 回到 `pending` 并把 `fireAt` 往后推；「不再提醒」= `dismissed`；
//! 6. `dismissed` 和已 `fired` 的不会重复弹（同一条信息只打扰一次）。
//!
//! 时间比较用 [`crate::models::iso_cmp`]：解析不了就当作"已到点"——宁可多提醒一次，
//! 也别因为一个坏时间戳就永远不提醒。

use crate::models::{
    iso_cmp, iso_plus_minutes, now_iso, InfoStatus, Reminder, ReminderFile, ReminderKind,
    ReminderPayload, ReminderStatus, Todo, TodoStatus,
};
use crate::store::atomic;
use crate::store::{info, todo, Store};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::PathBuf;

/// 提醒文件名
pub const REMINDERS_FILE: &str = "reminders.json";

/// `<数据目录>/reminders.json`
pub fn reminders_path(store: &Store) -> PathBuf {
    store.data_dir().join(REMINDERS_FILE)
}

/// 读整个文件（不存在 → 空）
pub fn load(store: &Store) -> Result<ReminderFile, String> {
    Ok(atomic::read_json(&reminders_path(store))?.unwrap_or_default())
}

/// 整体重写（原子写 + 上一版留 `.bak`）
pub fn save(store: &Store, file: &ReminderFile) -> Result<(), String> {
    atomic::atomic_write_json(&reminders_path(store), file)
}

/// 提醒列表：**新的在前**（按到点时间倒序）
pub fn list(store: &Store) -> Result<Vec<Reminder>, String> {
    let mut items = load(store)?.items;
    items.sort_by(|a, b| b.fire_at.cmp(&a.fire_at));
    Ok(items)
}

/// 「不再提醒」
pub fn dismiss(store: &Store, id: &str) -> Result<bool, String> {
    let mut file = load(store)?;
    let Some(target) = file.items.iter_mut().find(|item| item.id == id) else {
        return Ok(false);
    };
    target.status = ReminderStatus::Dismissed;
    save(store, &file)?;
    Ok(true)
}

/// 「稍后提醒」：把到点时间往后推 `minutes` 分钟，并回到待弹状态
pub fn snooze(store: &Store, id: &str, minutes: u32) -> Result<Option<Reminder>, String> {
    let mut file = load(store)?;
    let Some(target) = file.items.iter_mut().find(|item| item.id == id) else {
        return Ok(None);
    };
    let minutes = minutes.max(1) as i64;
    let base = now_iso();
    target.fire_at = iso_plus_minutes(&base, minutes).unwrap_or(base);
    target.status = ReminderStatus::Pending;
    target.snoozed_until = Some(target.fire_at.clone());
    let updated = target.clone();
    save(store, &file)?;
    Ok(Some(updated))
}

/// 指向 `ref_id` 的提醒全部标成「不再提醒」——用在"用户已经把这条信息处理掉了"，
/// 比如刚在提醒横幅上点了【联动到认知区】/【建为待办】。
pub fn dismiss_for_ref(store: &Store, ref_id: &str) -> Result<usize, String> {
    let mut file = load(store)?;
    let mut changed = 0;
    for item in file.items.iter_mut() {
        if item.ref_id == ref_id && item.status != ReminderStatus::Dismissed {
            item.status = ReminderStatus::Dismissed;
            changed += 1;
        }
    }
    if changed > 0 {
        save(store, &file)?;
    }
    Ok(changed)
}

/// 指向 `ref_id` 的提醒全部清掉（信息被删时用）
pub fn drop_for_ref(store: &Store, ref_id: &str) -> Result<usize, String> {
    let mut file = load(store)?;
    let before = file.items.len();
    file.items.retain(|item| item.ref_id != ref_id);
    let removed = before - file.items.len();
    if removed > 0 {
        save(store, &file)?;
    }
    Ok(removed)
}

/// 手动排一条**待办提醒**（M5：⚙ 里的「再次设定时间提醒」）。
///
/// 手动排一条**待办提醒**（M5：⚙ 里的「再次设定时间提醒」；C 批扩成**多条**）。
///
/// # C 批（2026-10-02）改了什么，为什么这么改
///
/// 用户脑图第 7 条原话：「待办，有更自由的**信息提醒**的能力」。
/// 原来这里是「同一条待办只留一条待弹提醒」—— 点第二次是**改时间**。
/// 现在按 `key` 区分身份，于是同一条待办可以同时有：
/// - `at:<ISO>` —— 他手动挑的一个或多个时间点；
/// - `early:<分钟>` —— "到期前 10 / 30 / 60 分钟先提醒我一下"。
///
/// ⚠️ **老数据的兜底**：C 批之前写下的提醒 `key` 是空串。空串一律当成"手动那条"，
///    这样他以前排的那条提醒再点一次仍然是**改时间**，不会被当成新的一条排成两份。
///
/// 返回值是**这条待办当前所有待弹的提醒**（前端要拿它去画"已排的提醒"清单）。
pub fn schedule_todo_remind(
    store: &Store,
    todo: &Todo,
    key: String,
    fire_at: String,
    note: String,
) -> Result<Vec<Reminder>, String> {
    if fire_at.trim().is_empty() {
        return Err("请先挑一个提醒时间".to_string());
    }
    let mut file = load(store)?;
    let want = if key.trim().is_empty() {
        MANUAL_KEY.to_string()
    } else {
        key.trim().to_string()
    };

    // 同一条待办、同一个 key、还在待弹 → **改它**（不是再排一条）
    let existing = file.items.iter_mut().find(|r| {
        r.kind == ReminderKind::TodoRemind
            && r.ref_id == todo.id
            && r.status == ReminderStatus::Pending
            && same_key(&r.key, &want)
    });

    if let Some(found) = existing {
        found.fire_at = fire_at;
        found.payload.text = todo_title(todo);
        found.payload.note = note;
        found.key = want.clone();
    } else {
        file.items.push(Reminder {
            id: uuid::Uuid::new_v4().to_string(),
            kind: ReminderKind::TodoRemind,
            ref_id: todo.id.clone(),
            fire_at,
            status: ReminderStatus::Pending,
            payload: ReminderPayload {
                text: todo_title(todo),
                // 待办提醒没有"信息分类"这回事，留空；界面按 `kind` 区分显示
                category_text: String::new(),
                note: note.clone(),
            },
            snoozed_until: None,
            key: want.clone(),
        });
    }

    let updated: Vec<Reminder> = file
        .items
        .iter()
        .filter(|r| {
            r.kind == ReminderKind::TodoRemind
                && r.ref_id == todo.id
                && r.status == ReminderStatus::Pending
        })
        .cloned()
        .collect();
    save(store, &file)?;
    Ok(updated)
}

/// 「手动那条」的 key 兜底（老数据 `key` 是空串，一律按它算）
pub const MANUAL_KEY: &str = "at:manual";

/// 两个 key 是不是"同一条提醒"：完全相等算同一条；**空 key 当手动那条**
fn same_key(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let t = s.trim();
        if t.is_empty() {
            MANUAL_KEY.to_string()
        } else {
            t.to_string()
        }
    };
    norm(a) == norm(b)
}

fn todo_title(todo: &Todo) -> String {
    if todo.title.trim().is_empty() {
        "（没有标题的待办）".to_string()
    } else {
        todo.title.trim().to_string()
    }
}

/// 删掉**某一条**待办提醒（C 批：多条提醒就得能一条一条删）。
///
/// ⚠️ 只按 id 精确删那一条 —— 别的提醒（包括同一条待办的其他提醒）一律不动。
pub fn delete_one(store: &Store, id: &str) -> Result<bool, String> {
    let mut file = load(store)?;
    let before = file.items.len();
    file.items.retain(|item| item.id != id);
    let removed = before != file.items.len();
    if removed {
        save(store, &file)?;
    }
    Ok(removed)
}

/// 这条待办现在排着哪些提醒（还在待弹的）—— 给 ⚙ 弹窗画清单用
pub fn list_for_todo(store: &Store, todo_id: &str) -> Result<Vec<Reminder>, String> {
    let file = load(store)?;
    Ok(file
        .items
        .into_iter()
        .filter(|r| {
            r.kind == ReminderKind::TodoRemind
                && r.ref_id == todo_id
                && r.status == ReminderStatus::Pending
        })
        .collect())
}

/// 扫描一趟：把到点的提醒返回给调用方去广播。说明见文件头。
///
/// `stale_enabled` **只作用于「信息放久了」这一类提醒**。
///
/// ⚠️ 千万不要用这个开关把**整个扫描**掐掉。`todo-remind`
/// （⚙ 里的「再次设定时间提醒」）和 45 分钟信息提醒是两码事，
/// 用户关掉前者不代表不想收到后者。M2 的 `scheduler::tick` 就犯过这个错：
/// 它在最上面就 `if !info_stale_enabled { return }`，于是**待办提醒永远不会响**。
pub fn scan(
    store: &Store,
    stale_minutes: u32,
    stale_enabled: bool,
    now: &str,
) -> Result<Vec<Reminder>, String> {
    let infos = info::read_all(store)?;
    let mut file = load(store)?;
    let mut changed = false;

    // 1) 排期 / 撤销
    for item in &infos {
        let existing = file
            .items
            .iter()
            .position(|r| r.kind == ReminderKind::InfoStale && r.ref_id == item.id);

        if !stale_enabled {
            // 45 分钟提醒被关掉了：不再排新的，并把手头"还没弹"的收掉。
            // （已经弹过/已忽略的保持原状，不动历史。）
            if let Some(idx) = existing {
                if file.items[idx].status == ReminderStatus::Pending {
                    file.items[idx].status = ReminderStatus::Dismissed;
                    changed = true;
                }
            }
            continue;
        }

        if item.status == InfoStatus::Linked {
            // 已经联动过了 → 不管提醒是"待弹"还是"已弹"，都收掉（不用再催了）
            if let Some(idx) = existing {
                if file.items[idx].status != ReminderStatus::Dismissed {
                    file.items[idx].status = ReminderStatus::Dismissed;
                    changed = true;
                }
            }
            continue;
        }

        if existing.is_some() {
            continue; // 已经有提醒了（不管什么状态，都不再新建）
        }

        let fire_at = iso_plus_minutes(&item.created_at, stale_minutes as i64)
            .unwrap_or_else(|| now.to_string());
        file.items.push(Reminder {
            id: uuid::Uuid::new_v4().to_string(),
            kind: ReminderKind::InfoStale,
            ref_id: item.id.clone(),
            fire_at,
            status: ReminderStatus::Pending,
            payload: ReminderPayload {
                text: if item.text.trim().is_empty() {
                    item.asset_path
                        .as_ref()
                        .map(|path| format!("（图片）{path}"))
                        .unwrap_or_else(|| "（空信息）".to_string())
                } else {
                    item.text.trim().to_string()
                },
                category_text: if item.categories.is_empty() {
                    "未分类".to_string()
                } else {
                    item.categories.join("·")
                },
                // 信息提醒不做"多条"，也没有自定义说明（留空）
                note: String::new(),
            },
            snoozed_until: None,
            // 信息提醒不做"多条"，key 用不着（留空）
            key: String::new(),
        });
        changed = true;
    }

    // 2) 清理：信息已经不存在了的提醒（信息被删掉）
    let live: HashSet<&str> = infos.iter().map(|item| item.id.as_str()).collect();
    let before = file.items.len();
    file.items.retain(|r| r.kind != ReminderKind::InfoStale || live.contains(r.ref_id.as_str()));
    if file.items.len() != before {
        changed = true;
    }

    // 2b) 待办提醒的清理：待办被删了 → 提醒跟着走；待办已经做完了 → 还没弹的就别再弹了。
    //     （已弹/已忽略的历史留着，那是"什么时候提醒过"的痕迹。）
    {
        let todos = todo::load(store)?.items;
        let before = file.items.len();
        file.items.retain(|r| {
            if r.kind != ReminderKind::TodoRemind {
                return true;
            }
            let Some(target) = todos.iter().find(|t| t.id == r.ref_id) else {
                return false;
            };
            r.status != ReminderStatus::Pending || target.status == TodoStatus::Open
        });
        if file.items.len() != before {
            changed = true;
        }
    }

    // 3) 到点的弹出来
    let mut fired = Vec::new();
    for reminder in file.items.iter_mut() {
        if reminder.status != ReminderStatus::Pending {
            continue;
        }
        let due = match iso_cmp(&reminder.fire_at, now) {
            Some(Ordering::Greater) => false, // 还没到点
            _ => true,                        // 已到点，或时间戳坏了（宁可提醒）
        };
        if due {
            reminder.status = ReminderStatus::Fired;
            fired.push(reminder.clone());
            changed = true;
        }
    }

    if changed {
        save(store, &file)?;
    }
    Ok(fired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{InfoKind, ReminderKind};
    use crate::store::temp_store;

    /// 造一条"创建于 minutes_ago 分钟前"的信息
    fn info_minutes_ago(store: &Store, text: &str, minutes_ago: i64) -> crate::models::Info {
        let created = iso_plus_minutes(&now_iso(), -minutes_ago).unwrap();
        let mut items = info::read_all(store).unwrap();
        let item = crate::models::Info {
            id: uuid::Uuid::new_v4().to_string(),
            kind: InfoKind::Text,
            text: text.to_string(),
            asset_path: None,
            created_at: created.clone(),
            updated_at: created,
            categories: vec!["主动冒出".into(), "突然想起".into()],
            status: InfoStatus::Pending,
            links: Vec::new(),
        };
        items.push(item.clone());
        // 直接写文件，绕过 create 的"现在时间"盖章
        let mut file_text = String::new();
        for it in &items {
            file_text.push_str(&serde_json::to_string(it).unwrap());
            file_text.push('\n');
        }
        atomic::atomic_write_str(&info::info_path(store), &file_text).unwrap();
        item
    }

    #[test]
    fn 放够时间的信息会被排一条提醒并当场弹出() {
        let store = temp_store("reminder-fire");
        let item = info_minutes_ago(&store, "放了很久的一条", 50);

        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert_eq!(fired.len(), 1, "放了 50 分钟、阈值 45 → 应该弹");
        assert_eq!(fired[0].kind, ReminderKind::InfoStale);
        assert_eq!(fired[0].ref_id, item.id);
        assert!(fired[0].payload.text.contains("放了很久的一条"));
        assert!(fired[0].payload.category_text.contains("主动冒出"));
        assert_eq!(fired[0].status, ReminderStatus::Fired);
    }

    #[test]
    fn 没放够时间的不会弹() {
        let store = temp_store("reminder-notyet");
        info_minutes_ago(&store, "刚记的", 5);

        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert!(fired.is_empty(), "才 5 分钟，不该弹");
        // 但提醒已经排好期了
        let all = list(&store).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, ReminderStatus::Pending);
    }

    #[test]
    fn 同一条信息只打扰一次() {
        let store = temp_store("reminder-once");
        info_minutes_ago(&store, "只该提醒一次", 50);

        assert_eq!(scan(&store, 45, true, &now_iso()).unwrap().len(), 1);
        assert_eq!(
            scan(&store, 45, true, &now_iso()).unwrap().len(),
            0,
            "第二趟不该再弹"
        );
        assert_eq!(list(&store).unwrap().len(), 1, "也不该重复建行");
    }

    #[test]
    fn 不再提醒之后不会再弹() {
        let store = temp_store("reminder-dismiss");
        info_minutes_ago(&store, "别烦我", 50);
        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert_eq!(fired.len(), 1);

        assert!(dismiss(&store, &fired[0].id).unwrap());
        assert!(scan(&store, 45, true, &now_iso()).unwrap().is_empty());
        assert!(!dismiss(&store, "不存在").unwrap());
    }

    #[test]
    fn 稍后提醒会把时间往后推并重新待弹() {
        let store = temp_store("reminder-snooze");
        info_minutes_ago(&store, "等会儿再说", 50);
        let fired = scan(&store, 45, true, &now_iso()).unwrap();

        let snoozed = snooze(&store, &fired[0].id, 30).unwrap().expect("应能找到");
        assert_eq!(snoozed.status, ReminderStatus::Pending);
        assert!(snoozed.snoozed_until.is_some());
        // 30 分钟后才到点 → 现在不该弹
        assert!(scan(&store, 45, true, &now_iso()).unwrap().is_empty());
    }

    #[test]
    fn 信息被联动后待弹提醒会自动撤回() {
        let store = temp_store("reminder-linked");
        let item = info_minutes_ago(&store, "马上要联动了", 50);

        // 先把状态改成已联动（模拟用户去做了联动）
        let mut items = info::read_all(&store).unwrap();
        items[0].status = InfoStatus::Linked;
        let mut text = String::new();
        for it in &items {
            text.push_str(&serde_json::to_string(it).unwrap());
            text.push('\n');
        }
        atomic::atomic_write_str(&info::info_path(&store), &text).unwrap();

        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert!(fired.is_empty(), "已经联动过就不该再提醒");
        assert_eq!(list(&store).unwrap().len(), 0, "压根不该建提醒行：{}", item.id);
    }

    #[test]
    fn 信息被删掉后提醒也会被清掉() {
        let store = temp_store("reminder-drop");
        let item = info_minutes_ago(&store, "会被删掉", 50);
        scan(&store, 45, true, &now_iso()).unwrap();
        assert_eq!(list(&store).unwrap().len(), 1);

        assert_eq!(drop_for_ref(&store, &item.id).unwrap(), 1);
        assert!(list(&store).unwrap().is_empty());
    }

    #[test]
    fn 处理掉之后不再提醒_连已弹过的也收掉() {
        let store = temp_store("reminder-handled");
        let item = info_minutes_ago(&store, "已经处理了", 50);
        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].status, ReminderStatus::Fired);

        // 刚在横幅上点了联动/建待办 → 提醒该收掉
        assert_eq!(dismiss_for_ref(&store, &item.id).unwrap(), 1);
        let all = list(&store).unwrap();
        assert_eq!(all[0].status, ReminderStatus::Dismissed);
        assert!(
            scan(&store, 45, true, &now_iso()).unwrap().is_empty(),
            "收掉之后不该再弹"
        );
        // 再收一次没有变化
        assert_eq!(dismiss_for_ref(&store, &item.id).unwrap(), 0);
    }

    // ─────────────────── M5：待办提醒 ───────────────────

    /// 造一条**真的落盘**的待办。
    ///
    /// ⚠️ 必须真建：`scan` 会把"待办已经不存在了"的提醒清掉（`2b` 那一段），
    /// 拿一个凭空捏的 id 去测，提醒会在弹出前就被清理掉，
    /// 测试会以"没弹出"的形式失败 —— 这条坑值得留个记号。
    fn make_todo(store: &Store, title: &str) -> Todo {
        todo::create(store, title.to_string(), Default::default(), None).unwrap()
    }

    #[test]
    fn 手动排的待办提醒到点会弹() {
        let store = temp_store("reminder-todo-fire");
        let item = make_todo(&store, "再想一遍这件事");

        // 排到"过去"，下一趟扫描就该弹
        let past = iso_plus_minutes(&now_iso(), -1).unwrap();
        // C 批起返回的是**这一条待办当前排着的所有提醒**（可能是多条）
        let made = schedule_todo_remind(&store, &item, String::new(), past, String::new()).unwrap();
        assert_eq!(made.len(), 1, "刚排一条就该只有一条");
        assert_eq!(made[0].kind, ReminderKind::TodoRemind);
        assert_eq!(made[0].ref_id, item.id);
        assert_eq!(made[0].status, ReminderStatus::Pending);
        assert_eq!(made[0].payload.text, "再想一遍这件事");

        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].kind, ReminderKind::TodoRemind);
        assert_eq!(fired[0].ref_id, item.id);
    }

    /// C 批（2026-10-02）改过语义：**同一个 key** 再设一次才是"改时间"；
    /// 不同 key（手动那条 / 提前 10 分钟）是**两条并存的提醒**。
    #[test]
    fn 同一条待办同一个key重复设置是改时间不是多排几条() {
        let store = temp_store("reminder-todo-once");
        let item = make_todo(&store, "只该有一条提醒");
        let later = iso_plus_minutes(&now_iso(), 30).unwrap();
        let sooner = iso_plus_minutes(&now_iso(), 5).unwrap();

        let first = schedule_todo_remind(&store, &item, String::new(), later.clone(), String::new())
            .unwrap();
        let second =
            schedule_todo_remind(&store, &item, String::new(), sooner.clone(), String::new())
                .unwrap();

        assert_eq!(first[0].id, second[0].id, "还是同一条提醒");
        assert_eq!(second[0].fire_at, sooner, "时间被改成新的");
        assert_eq!(list(&store).unwrap().len(), 1, "★ 同一个 key 不会越排越多");
    }

    /// C 批：**不同 key 的两条提醒要并存**（用户脑图第 7 条「更自由的提醒能力」）
    #[test]
    fn 不同key的提醒可以并存_而且能一条一条删() {
        let store = temp_store("reminder-todo-multi");
        let item = make_todo(&store, "到期前先提醒我");
        let manual = iso_plus_minutes(&now_iso(), 30).unwrap();
        let early = iso_plus_minutes(&now_iso(), 10).unwrap();

        let after_manual =
            schedule_todo_remind(&store, &item, String::new(), manual.clone(), "手动那条".into())
                .unwrap();
        assert_eq!(after_manual.len(), 1);

        let after_early =
            schedule_todo_remind(&store, &item, "early:10".into(), early.clone(), "提前 10 分钟".into())
                .unwrap();
        assert_eq!(after_early.len(), 2, "两条应该并存：{after_early:?}");
        assert_eq!(list(&store).unwrap().len(), 2);

        // 提前那条再设一次（还是 early:10）→ 只改时间，不变成三条
        let again =
            schedule_todo_remind(&store, &item, "early:10".into(), early.clone(), String::new())
                .unwrap();
        assert_eq!(again.len(), 2, "同一个 key 再来一次还是两条");

        // 删掉 early:10 那一条 → 手动那条**必须留着**
        let early_id = again
            .iter()
            .find(|r| r.key == "early:10")
            .expect("该有 early:10 那条")
            .id
            .clone();
        assert!(delete_one(&store, &early_id).unwrap(), "删掉那一条");
        let left = list_for_todo(&store, &item.id).unwrap();
        assert_eq!(left.len(), 1, "★ 只删掉点名的那条：{left:?}");
        assert_eq!(left[0].fire_at, manual, "留下的是手动那条");
    }

    /// C 批：**老数据兜底** —— `key` 是空串的老提醒，再排一次仍然算"改时间"
    #[test]
    fn 老数据没有key字段的提醒_再排一次仍然是改时间() {
        let store = temp_store("reminder-todo-legacy");
        let item = make_todo(&store, "老提醒");
        let later = iso_plus_minutes(&now_iso(), 30).unwrap();
        let sooner = iso_plus_minutes(&now_iso(), 5).unwrap();

        // 先正常排一条（key 会是空串，因为传的就是空串）
        schedule_todo_remind(&store, &item, String::new(), later, String::new()).unwrap();
        // 再排一次（还是不传 key）→ 只能是改，不是加
        let made = schedule_todo_remind(&store, &item, String::new(), sooner.clone(), String::new())
            .unwrap();
        assert_eq!(made.len(), 1, "老数据不许被当成新的一条：{made:?}");
        assert_eq!(made[0].fire_at, sooner);
    }

    #[test]
    fn 待办提醒不填时间要报错() {
        let store = temp_store("reminder-todo-empty");
        let item = make_todo(&store, "没填时间");
        assert!(schedule_todo_remind(&store, &item, String::new(), "  ".into(), String::new()).is_err());
    }

    #[test]
    fn 待办删了_它的提醒也跟着走() {
        let store = temp_store("reminder-todo-gone");
        let item = make_todo(&store, "待会儿就删");
        let soon = iso_plus_minutes(&now_iso(), 30).unwrap();
        schedule_todo_remind(&store, &item, String::new(), soon, String::new()).unwrap();
        assert_eq!(list(&store).unwrap().len(), 1);

        todo::delete(&store, &item.id).unwrap();
        scan(&store, 45, true, &now_iso()).unwrap();
        assert!(list(&store).unwrap().is_empty(), "待办没了，提醒不该留着");
    }

    #[test]
    fn 待办做完了_还没弹的提醒就别弹了() {
        let store = temp_store("reminder-todo-done");
        let item = make_todo(&store, "已经做完了");
        let soon = iso_plus_minutes(&now_iso(), 30).unwrap();
        schedule_todo_remind(&store, &item, String::new(), soon, String::new()).unwrap();

        todo::set_done(&store, &item.id, true).unwrap();
        let fired = scan(&store, 45, true, &now_iso()).unwrap();
        assert!(fired.is_empty(), "做完了就不该再提醒");
        assert!(list(&store).unwrap().is_empty());
    }

    /// **M2 留下来、M5 必须修掉的那个坑**：45 分钟提醒的开关
    /// 只该管"信息放久了"，不该把待办提醒一起掐死。
    #[test]
    fn 关掉45分钟提醒_待办提醒照样弹() {
        let store = temp_store("reminder-todo-independent");
        // 一条放了很久、没联动的信息（关掉开关后它不该被催）
        info_minutes_ago(&store, "放很久了", 50);
        // 一条到点的待办提醒
        let item = make_todo(&store, "这个必须提醒");
        let past = iso_plus_minutes(&now_iso(), -1).unwrap();
        schedule_todo_remind(&store, &item, String::new(), past, String::new()).unwrap();

        let fired = scan(&store, 45, false, &now_iso()).unwrap();
        assert_eq!(
            fired.len(),
            1,
            "★ 关掉信息提醒后，待办提醒仍要弹：{fired:?}"
        );
        assert_eq!(fired[0].kind, ReminderKind::TodoRemind);

        // 而且没有给那条信息排新提醒
        let all = list(&store).unwrap();
        assert_eq!(
            all.iter()
                .filter(|r| r.kind == ReminderKind::InfoStale)
                .count(),
            0,
            "关掉开关就不该再排信息提醒"
        );
    }

    #[test]
    fn 关掉45分钟提醒_信息提醒不再弹并且待弹的被收掉() {
        let store = temp_store("reminder-stale-off");
        info_minutes_ago(&store, "放了很久", 50);
        // 先开着扫一趟：会排期并当场弹
        assert_eq!(scan(&store, 45, true, &now_iso()).unwrap().len(), 1);

        // 再来一条没到点的，验证开着时是 pending
        info_minutes_ago(&store, "刚放的", 5);
        scan(&store, 45, true, &now_iso()).unwrap();
        let pending_before = list(&store)
            .unwrap()
            .iter()
            .filter(|r| r.kind == ReminderKind::InfoStale && r.status == ReminderStatus::Pending)
            .count();
        assert_eq!(pending_before, 1);

        // 关掉开关再扫：待弹的要被收掉，也不会新排
        assert!(scan(&store, 45, false, &now_iso()).unwrap().is_empty());
        let pending_after = list(&store)
            .unwrap()
            .iter()
            .filter(|r| r.kind == ReminderKind::InfoStale && r.status == ReminderStatus::Pending)
            .count();
        assert_eq!(pending_after, 0, "关掉之后不该还留着待弹的信息提醒");
    }
}
