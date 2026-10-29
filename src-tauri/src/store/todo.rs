//! 待办（`todos.json`，整个文件一个对象，里面 `items` 数组）。
//!
//! M2 只用到「以信息建待办」；M5 才会做待办集/四象限/番茄钟/自动检测。
//! 文件结构按 DEV-PLAN §4.3 定好，后面只加字段不改形状。

use crate::models::{now_iso, PomodoroExtra, Todo, TodoFile, TodoSource};
use crate::store::atomic;
use crate::store::Store;
use std::path::PathBuf;

/// 待办文件名
pub const TODOS_FILE: &str = "todos.json";

/// `<数据目录>/todos.json`
pub fn todos_path(store: &Store) -> PathBuf {
    store.data_dir().join(TODOS_FILE)
}

/// 读整个文件（不存在 → 空）
pub fn load(store: &Store) -> Result<TodoFile, String> {
    let mut file: TodoFile = atomic::read_json(&todos_path(store))?.unwrap_or_default();
    // M21（v2.11.0）：老数据里**没有** `updatedAt`（读进来是空串）→ 用 `createdAt` 兜底。
    // ⚠️ 只在**内存里**补齐，这里**不写盘**（免得"打开一下程序"就把所有待办都写成刚改过；
    //    真写盘发生在任何一次真实改动时，那时 save 会把补齐的值一起落下去）。
    for one in file.items.iter_mut() {
        if one.updated_at.trim().is_empty() {
            one.updated_at = one.created_at.clone();
        }
    }
    Ok(file)
}

/// 整体重写（原子写 + 上一版留 `.bak`）
pub fn save(store: &Store, file: &TodoFile) -> Result<(), String> {
    atomic::atomic_write_json(&todos_path(store), file)
}


/// M21（v2.11.0）：把"最后改动时间"刷新成现在。
///
/// 🔴 **每个写待办的路径都必须调它**（`patch` / `create` / `spawn_next_occurrence` /
/// 子任务三件套 / `reorder` / `add_pomodoro` / `mark_*`）—— 漏一处，那条改动在同步时就会被
/// 判成"旧的"、被对面的版本静默盖掉（这正是"谁新听谁的"最怕的那种丢改动）。
fn touch(one: &mut Todo) {
    one.updated_at = now_iso();
}
/// 待办列表：按 `order` 升序（拖动排序就是改这个字段）
pub fn list(store: &Store) -> Result<Vec<Todo>, String> {
    let mut items = load(store)?.items;
    items.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.created_at.cmp(&b.created_at)));
    Ok(items)
}

/// 新建待办（`title` 为空会报错；`order` 排到最后）
pub fn create(
    store: &Store,
    title: String,
    source: TodoSource,
    planned_at: Option<String>,
) -> Result<Todo, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("待办标题不能为空".to_string());
    }

    let mut file = load(store)?;
    let next_order = file
        .items
        .iter()
        .map(|item| item.order)
        .max()
        .unwrap_or(-1)
        + 1;

    let now = now_iso();
    let todo = Todo {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        order: next_order,
        planned_at: planned_at.filter(|value| !value.trim().is_empty()),
        // 截止日期新建时为空（要设就在卡片 ⚙ 里设）
        due_at: None,
        status: Default::default(),
        done_at: None,
        quadrant: None,
        source,
        reminder_at: None,
        pomodoros: Vec::new(),
        subtasks: Vec::new(),
        // 重复规则在卡片 ⚙ 里设（M9-6）
        repeat: None,
        repeat_from: None,
        // 「须知」（M13-C）新建时是空的，在专注小窗 / 番茄钟面板里写
        focus_note: String::new(),
        // 分组（D 批）：新建时一律"未分组"，要进组就用卡片的 ⋮ 菜单
        group: String::new(),
        // 番茄时长（v1.15.0）：新建时**跟随设置里的全局值**，要单独设就在卡片 ⚙ 里设
        custom_minutes: None,
        created_at: now.clone(),
        // M21：新建时"最后改动时间" = 创建时间
        updated_at: now,
    };

    file.items.push(todo.clone());
    save(store, &file)?;
    Ok(todo)
}

/// 一条待办要改哪几处（`None` = 这一项不动）
///
/// ⚠️ 这是**内部**用的补丁结构，不直接暴露给前端。原因记在
/// [`set_planned_at`] 的注释里：`Option<Option<T>>` 在 JSON 里分不开
/// "不传"和"传 null"，所以对外一律是**一个动作一条专用命令**。
///
/// 两个可空字段在这里用双层 `Option` 表达三种意思（Rust 内部构造，不经过 serde）：
/// - `None` → 不动
/// - `Some(None)` → 清空
/// - `Some(Some(v))` → 设成 `v`
#[derive(Debug, Clone, Default)]
pub struct TodoPatch {
    pub title: Option<String>,
    pub status: Option<crate::models::TodoStatus>,
    pub planned_at: Option<Option<String>>,
    /// 截止日期（M9-1）：`None` 不动 / `Some(None)` 清空 / `Some(Some(v))` 设成 v
    pub due_at: Option<Option<String>>,
    pub quadrant: Option<Option<crate::models::Quadrant>>,
    /// 重复规则（M9-6）：`None` 不动 / `Some(None)` = 不重复 / `Some(Some(v))` 设成 v
    pub repeat: Option<Option<crate::models::Repeat>>,
    /// 「再次设定时间提醒」设过的时间（留一笔，重启后 ⚙ 里还看得见）
    pub reminder_at: Option<Option<String>>,
    /// 「须知」（M13-C）：`None` 不动 / `Some(v)` 设成 v（**空串 = 清掉**，不是删字段）。
    /// 它不是可空字段（`focus_note: String`），所以用单层 `Option` 表达"动没动"就够了。
    pub focus_note: Option<String>,
    /// 分组（D 批）：`None` 不动 / `Some(v)` 设成 v（**空串 = 移出分组**）。
    /// 跟 `focus_note` 一样是"不可空字段"，单层 `Option` 就够。
    pub group: Option<String>,
    /// **这一条待办的番茄时长**（v1.15.0）：`None` 不动 / `Some(None)` = **恢复跟随全局** /
    /// `Some(Some(v))` 设成 v（分钟）。
    /// ⚠️ 它本身是**可空字段**（`Option<u32>`），所以必须双层 `Option` —— 只有这样才能把
    /// "不改"和"清掉"分开（serde 会把两者都吃成 `null`，这正是本项目踩过的坑）。
    pub custom_minutes: Option<Option<u32>>,
}

/// 改一条待办的若干字段（**只动传进来的那些**，其余原样保留）
pub fn patch(store: &Store, id: &str, change: TodoPatch) -> Result<Todo, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("要改的待办不存在：{id}"))?;

    if let Some(title) = change.title {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("待办标题不能为空".to_string());
        }
        // M11 前置（2026-09-26，方案①）：**在执行区给笔记来源的待办改过名，名字就归执行区了**。
        // 记上这一笔，`note::sync_markers` 以后不再拿笔记里的 `-[]文字` 覆盖它。
        // ⚠️ 只在"真的改了"的时候记（标题没动就别留痕）；链接照旧跟着笔记走，见 `TodoSource::renamed` 的注释。
        if item.title != title && item.source.kind == crate::models::TodoSourceKind::Note {
            item.source.renamed = true;
        }
        item.title = title;
    }
    if let Some(status) = change.status {
        item.status = status;
        // 完成 → 盖完成时间；退回未完成 → 把完成时间抹掉（不然界面上会显示"已完成"的旧时间）
        item.done_at = if status == crate::models::TodoStatus::Done {
            Some(item.done_at.clone().unwrap_or_else(now_iso))
        } else {
            None
        };
    }
    if let Some(planned_at) = change.planned_at {
        item.planned_at = planned_at.filter(|value| !value.trim().is_empty());
    }
    if let Some(due_at) = change.due_at {
        item.due_at = due_at.filter(|value| !value.trim().is_empty());
    }
    if let Some(quadrant) = change.quadrant {
        item.quadrant = quadrant;
    }
    if let Some(custom_minutes) = change.custom_minutes {
        // `Some(None)` 就是"恢复跟随全局"（清掉这个字段 → 落盘时连键都不写）
        item.custom_minutes = custom_minutes;
    }
    if let Some(repeat) = change.repeat {
        item.repeat = repeat;
    }
    if let Some(reminder_at) = change.reminder_at {
        item.reminder_at = reminder_at.filter(|value| !value.trim().is_empty());
    }
    if let Some(focus_note) = change.focus_note {
        // M13-C「须知」：空串 = 清掉（**不是删字段** —— 这几个字段是 `String`，没有 null 可言）。
        // 顺手去掉首尾空白：纯空白等于"没写"，否则小窗上会飘着一行看不见的空格，
        // 而前端按 `focusNote !== ''` 判断"有没有须知"，会以为写了。
        item.focus_note = focus_note.trim().to_string();
    }
    if let Some(group) = change.group {
        // 分组（D 批）：空串 = 移出分组；名字 `trim` + **最多 24 字**
        // —— 跟 `note::set_group` 完全一样的规矩（分组名是一行标签，太长会把列表撑坏）。
        let group = group.trim();
        item.group = group.chars().take(24).collect();
    }

    // M21：这条待办真被改了 → 刷新"最后改动时间"
    touch(item);
    let updated = item.clone();
    save(store, &file)?;
    Ok(updated)
}

/// 标完成 / 取消完成（**M5 第一件事**：执行区要能勾，信息区来的待办也要能勾）。
///
/// 自己的函数而不是走 [`patch`]：这是最常用的一个动作，只碰 `status`/`doneAt`，
/// 连标题都不看 —— 把"不会误伤别的字段"写死在代码里。
///
/// M9-6 起多做一件事：**从"没完成 → 完成"的这一次**，如果这条待办带重复规则，
/// 就顺手派一条下一次的（见 [`spawn_next_occurrence`]）。
/// 注意判定用的是**改之前**的状态：来回勾（完成→取消→再完成）只会派一次。
pub fn set_done(store: &Store, id: &str, done: bool) -> Result<Todo, String> {
    let previous = load(store)?
        .items
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("要改的待办不存在：{id}"))?;

    let updated = patch(
        store,
        id,
        TodoPatch {
            status: Some(if done {
                crate::models::TodoStatus::Done
            } else {
                crate::models::TodoStatus::Open
            }),
            ..Default::default()
        },
    )?;

    if done && previous.status == crate::models::TodoStatus::Open && updated.repeat.is_some() {
        spawn_next_occurrence(store, &updated)?;
    }
    Ok(updated)
}

/// 设 / 清**重复规则**（M9-6）：`None` = 不重复
pub fn set_repeat(store: &Store, id: &str, repeat: Option<crate::models::Repeat>) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            repeat: Some(repeat),
            ..Default::default()
        },
    )
}

/// 把一条时间往后推 `steps` 个周期
///
/// 解析不了的时间原样返回 `None`（宁可这次不派新待办，也别写一个坏时间进去）。
fn add_steps(from: &str, repeat: crate::models::Repeat, steps: u32) -> Option<String> {
    use chrono::TimeZone;
    let parsed = chrono::DateTime::parse_from_rfc3339(from).ok()?;
    let local = parsed.with_timezone(&chrono::Local).naive_local();
    let moved = match repeat {
        crate::models::Repeat::Daily => local + chrono::Duration::days(steps as i64),
        crate::models::Repeat::Weekly => local + chrono::Duration::days(steps as i64 * 7),
        crate::models::Repeat::Monthly => {
            local.checked_add_months(chrono::Months::new(steps))?
        }
    };
    let back = chrono::Local.from_local_datetime(&moved).earliest()?;
    Some(back.to_rfc3339_opts(chrono::SecondsFormat::Millis, false))
}

/// 从 `base` 出发要推几个周期才**落在将来**
///
/// "落在将来"而不是"永远只推一格"：隔了半个月才把那条约每天做的待办勾掉时，
/// 一格一格补会派出一串早该过去的日子（还得再手动收拾）。
/// 这里直接跳到下一个"还没到"的点，中间漏掉的那些**不补**——
/// 漏掉的本来就没做，凭空补出来只会让人更不想用。
fn steps_to_future(base: &str, repeat: crate::models::Repeat, now: chrono::DateTime<chrono::Local>) -> u32 {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(base) else {
        return 1;
    };
    let anchor = parsed.with_timezone(&chrono::Local);
    if anchor > now {
        // 时间还没到（比如提前把它勾了）→ 下一次就是"再往后一格"
        return 1;
    }
    let naive_now = now.naive_local();
    // 上限 600 格（每月的话是 50 年）：数据再怪也不会在这儿转到天荒地老
    for steps in 1..=600u32 {
        let Some(moved) = add_steps(base, repeat, steps) else {
            return steps;
        };
        let Ok(at) = chrono::DateTime::parse_from_rfc3339(&moved) else {
            return steps;
        };
        if at.with_timezone(&chrono::Local).naive_local() > naive_now {
            return steps;
        }
    }
    600
}

/// **派下一次**（M9-6）：勾完一条带重复规则的待办时调用。
///
/// 新待办是**一条普通的、未完成的待办**：
/// - 时间往后推（`plannedAt` / `dueAt` 一起推同样多的格数，两者的间隔不会被拉散）；
/// - 子任务照抄一份、全部重置成没完成（"每周大扫除"的清单要重新来一遍）；
/// - **「须知」照抄**（M13-C）：它说的是"这件事是什么"，跟标题/象限/子任务同类，
///   写一次就该一直有用；
/// - **番茄钟记录不带过去**（那是上一次花掉的时间，带过去统计就假了）；
/// - 来源写成"手动"：它不再挂在哪条 `-[]` 标记或哪条信息上，
///   照抄来源会让"来源已移除"这类对账认错人；
/// - `repeatFrom = 上一条的 id`，用来防止重复派发（见字段注释）。
pub fn spawn_next_occurrence(store: &Store, done: &Todo) -> Result<Option<Todo>, String> {
    let Some(repeat) = done.repeat else {
        return Ok(None);
    };

    let mut file = load(store)?;
    // 已经派过了就别再派（取消完成再勾一次、验收脚本重跑，都会走到这儿）
    if file
        .items
        .iter()
        .any(|item| item.repeat_from.as_deref() == Some(done.id.as_str()))
    {
        return Ok(None);
    }

    // 以"设定时间"为准；没有就拿截止日期当锚；两个都没有就当成"从现在起算"
    let anchor = done
        .planned_at
        .clone()
        .or_else(|| done.due_at.clone())
        .unwrap_or_else(now_iso);
    let steps = steps_to_future(&anchor, repeat, chrono::Local::now());

    let next_order = file.items.iter().map(|item| item.order).max().unwrap_or(-1) + 1;
    let spawned = Todo {
        id: uuid::Uuid::new_v4().to_string(),
        title: done.title.clone(),
        order: next_order,
        planned_at: done
            .planned_at
            .as_deref()
            .and_then(|value| add_steps(value, repeat, steps)),
        due_at: done
            .due_at
            .as_deref()
            .and_then(|value| add_steps(value, repeat, steps)),
        status: crate::models::TodoStatus::Open,
        done_at: None,
        quadrant: done.quadrant,
        source: TodoSource::default(),
        reminder_at: None,
        pomodoros: Vec::new(),
        subtasks: done
            .subtasks
            .iter()
            .map(|sub| crate::models::Subtask::new(sub.text.clone()))
            .collect(),
        repeat: Some(repeat),
        repeat_from: Some(done.id.clone()),
        // 「须知」（M13-C）**照抄**：它描述的是"这件事本身要干什么 / 守什么"，
        // 和标题、象限、子任务一样属于"这件事是什么"，不是"上一次花掉的时间"。
        // "每天专注"的须知写一次就该一直有用，不该第二天又要重写。
        // （跟番茄钟记录正相反 —— 那个带过去统计就假了，见上面的函数注释。）
        focus_note: done.focus_note.clone(),
        // 分组（D 批）：**跟着原条走** —— "每天复习高数"派出来的下一条当然还在「学业」组里，
        // 跟标题/象限/须知同一个道理（都属于"这件事是什么"）。
        group: done.group.clone(),
        // 番茄时长（v1.15.0）：**跟着原条走** —— 跟标题 / 象限 / 须知同一个道理
        // （"这件事要做多久"属于"这件事是什么"，不是"上一次花掉的时间"）。
        custom_minutes: done.custom_minutes,
        // M21：派出来的下一条也是"新记录" → 最后改动时间 = 创建时间
        updated_at: now_iso(),
        created_at: now_iso(),
    };

    file.items.push(spawned.clone());
    save(store, &file)?;
    Ok(Some(spawned))
}

/// 改标题（只碰标题）
pub fn set_title(store: &Store, id: &str, title: String) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            title: Some(title),
            ..Default::default()
        },
    )
}

/// 写这条待办的「须知」（M13-C）：**只碰这一个字段**，空串 = 清掉。
///
/// 「须知」= 点开始专注时飘在小窗上的长期备注（"这件事要干什么 / 有什么规则"）。
/// 它**跟着待办走**，不跟番茄记录走 —— 所以是待办上的一个字段，
/// 而不是某一条 `Pomodoro` 的 `note`（那个是"这一笔"的备注，两者并存、各记各的）。
///
/// 走 [`patch`] 而不是整条覆盖：`todos.json` 会被后端自己改
/// （`sync_markers` 同步标题、番茄钟往 `pomodoros` 里追加），
/// 前端把手里那份整条发回来会把刚写进去的抹掉（M4/M5 都栽过，见 `commands.rs` 那一族命令的注释）。
pub fn set_focus_note(store: &Store, id: &str, text: &str) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            focus_note: Some(text.to_string()),
            ..Default::default()
        },
    )
}

/// 把待办移到某个分组（`group` 传空串 = 移出分组）：D 批（2026-10-04）
///
/// 跟 `note::set_group` 一模一样：**操作式**（只改 `group` 这一个字段，不整条覆盖）、
/// 名字 `trim` + 最多 24 字。前端拿返回的 `Todo` 就地更新列表。
pub fn set_group(store: &Store, id: &str, group: String) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            group: Some(group),
            ..Default::default()
        },
    )
}

/// 设 / 清**这一条待办自己的番茄时长**（v1.15.0）：`None` = 恢复跟随设置里的全局值
///
/// 用户拍板的语义（B）：**每条待办各设各的**（背单词 15 分钟、写作业 45 分钟），
/// 没设过就跟随全局 `config.focus.customMinutes`。
///
/// ⚠️ 合法区间 **1~999** 在这里把关：越界直接拒收，绝不写进 `todos.json`
/// （0 和 null 在界面上都是"跟随设置"，所以 `Some(0)` 这种脏数据一个都不许落盘）。
pub fn set_custom_minutes(store: &Store, id: &str, minutes: Option<u32>) -> Result<Todo, String> {
    if let Some(value) = minutes {
        if !(1..=999).contains(&value) {
            return Err(format!("番茄时长要 1~999 分钟（收到 {value}）"));
        }
    }
    patch(
        store,
        id,
        TodoPatch {
            custom_minutes: Some(minutes),
            ..Default::default()
        },
    )
}

/// 全部用过的分组名（去重、按名字排序）—— 分组列表和"移到分组"菜单都要用
///
/// 跟 `note::groups` 一致：空串（未分组）不算一个组。
pub fn groups(store: &Store) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = list(store)?
        .into_iter()
        .map(|todo| todo.group.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 设定时间（今日时间轴用）；`None` 或空白 = **清掉设定时间**
///
/// ⚠️ 为什么清空要单独开一个命令，而不是在 `todo_update` 里传 `null`：
/// serde 反序列化 `null` 时**外层 `Option` 会直接把它吃成 `None`**，
/// 于是"键不传（不动）"和"传 null（清空）"又分不开了，清空会静默变成不动。
/// 单测 `记一笔_双层Option分不开不传和null_所以改用专用setter` 钉住了这个行为。
pub fn set_planned_at(
    store: &Store,
    id: &str,
    planned_at: Option<String>,
) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            planned_at: Some(non_empty(planned_at)),
            ..Default::default()
        },
    )
}

/// 设/清**截止日期**（M9-1）：`dueAt` 传 `None` 或空串 = 清掉。
///
/// 和 [`set_planned_at`] 的区别（**两个都要有，别合并**）：
/// - `plannedAt` = **我打算什么时候做** —— 今日时间轴按它排；
/// - `dueAt` = **最晚什么时候必须做完** —— 过了就在卡片上标红"逾期"。
/// 一件事完全可以"打算今天做、周五之前必须完成"。
pub fn set_due_at(store: &Store, id: &str, due_at: Option<String>) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            due_at: Some(non_empty(due_at)),
            ..Default::default()
        },
    )
}

/// 加一条子任务（M9-2）：空文本不接受，返回更新后的待办
pub fn subtask_add(store: &Store, id: &str, text: String) -> Result<Todo, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("子任务不能是空的".to_string());
    }
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的待办不存在：{id}"))?;
    // 一条待办最多 30 个子任务：再多就不是"步骤"、是另一张清单了
    if item.subtasks.len() >= 30 {
        return Err("一条待办的子任务最多 30 个".to_string());
    }
    item.subtasks
        .push(crate::models::Subtask::new(text.to_string()));
    touch(item);
    let updated = item.clone();
    save(store, &file)?;
    Ok(updated)
}

/// 勾上/取消一条子任务
pub fn subtask_toggle(store: &Store, id: &str, subtask_id: &str, done: bool) -> Result<Todo, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的待办不存在：{id}"))?;
    let sub = item
        .subtasks
        .iter_mut()
        .find(|one| one.id == subtask_id)
        .ok_or_else(|| format!("这条待办里没有这个子任务：{subtask_id}"))?;
    sub.done = done;
    touch(item);
    let updated = item.clone();
    save(store, &file)?;
    Ok(updated)
}

/// 删掉一条子任务
pub fn subtask_remove(store: &Store, id: &str, subtask_id: &str) -> Result<Todo, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的待办不存在：{id}"))?;
    let before = item.subtasks.len();
    item.subtasks.retain(|one| one.id != subtask_id);
    if item.subtasks.len() == before {
        return Err(format!("这条待办里没有这个子任务：{subtask_id}"));
    }
    touch(item);
    let updated = item.clone();
    save(store, &file)?;
    Ok(updated)
}

/// 调整四象限分类；`None` = **拖出象限**（回到"没分类"）
pub fn set_quadrant(
    store: &Store,
    id: &str,
    quadrant: Option<crate::models::Quadrant>,
) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            quadrant: Some(quadrant),
            ..Default::default()
        },
    )
}

/// 记下/清掉"再次设定时间提醒"的时间
pub fn set_reminder_at(
    store: &Store,
    id: &str,
    reminder_at: Option<String>,
) -> Result<Todo, String> {
    patch(
        store,
        id,
        TodoPatch {
            reminder_at: Some(non_empty(reminder_at)),
            ..Default::default()
        },
    )
}

/// 去首尾空白；空串当作"没有"
fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 按给定顺序重排（拖动排序）：`ordered_ids` 里没提到的排在后面、**相对顺序不变**
///
/// "相对顺序"指的是**当前显示顺序**（`order` 排出来的），不是文件里的物理顺序
/// —— 排过一次之后这两者就不一样了，用物理顺序会让没拖动的待办莫名其妙地跳位。
/// 传进来的 id 要是在库里找不到，直接忽略（前端状态过期时不该把整次拖动弄失败）。
pub fn reorder(store: &Store, ordered_ids: &[String]) -> Result<Vec<Todo>, String> {
    let mut file = load(store)?;

    // 当前显示顺序：没提到的按它接在后面
    let mut current = file.items.clone();
    current.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.created_at.cmp(&b.created_at)));

    let mut rank: Vec<String> = Vec::new();
    for id in ordered_ids {
        // 不存在的 id 丢掉；重复的也只算第一次
        if file.items.iter().any(|item| &item.id == id) && !rank.contains(id) {
            rank.push(id.clone());
        }
    }
    for item in &current {
        if !rank.contains(&item.id) {
            rank.push(item.id.clone());
        }
    }

    for item in file.items.iter_mut() {
        if let Some(pos) = rank.iter().position(|id| id == &item.id) {
            item.order = pos as i64;
            // M21：顺序也是"用户改过的东西" → 跟着刷新（不然排完序同步过去对面看不见）
            touch(item);
        }
    }
    save(store, &file)?;
    list(store)
}

/// 记一次番茄钟；`finish` 为真时顺手标完成 —— **只标完成，绝不删除**
/// （PRD 5.3 / 10.4：番茄钟结束 → 待办被标记为完成，但仍然存在）
///
/// `extra` 是 M13-B 的「意外中断」四项（疑似离开秒数 / 次数、暂停秒数、是否作废）。
/// 不关心这些的调用方传 `PomodoroExtra::default()` 就是"这一笔没有中断信息"。
pub fn add_pomodoro(
    store: &Store,
    id: &str,
    mode: String,
    seconds: u32,
    note: String,
    finish: bool,
    extra: PomodoroExtra,
) -> Result<Todo, String> {
    let mut file = load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("要记番茄钟的待办不存在：{id}"))?;

    // 记这一笔之前它是不是"还没完成" —— 重复待办要按这个判断该不该派下一次
    let was_open = item.status == crate::models::TodoStatus::Open;

    item.pomodoros.push(crate::models::Pomodoro {
        mode,
        seconds,
        note,
        at: now_iso(),
        interrupted_seconds: extra.interrupted_seconds,
        interrupted_times: extra.interrupted_times,
        paused_seconds: extra.paused_seconds,
        voided: extra.voided,
    });
    if finish {
        item.status = crate::models::TodoStatus::Done;
        if item.done_at.is_none() {
            item.done_at = Some(now_iso());
        }
    }

    touch(item);
    let updated = item.clone();
    save(store, &file)?;

    // 番茄钟结束顺手标完成时，**也要**给重复待办派下一次。
    // 不在这儿补的话就有一条静默的缝：同一件事，用复选框勾会派、用番茄钟结束却不派 ——
    // 用户会觉得"重复怎么忽然不灵了"。
    if finish && was_open && updated.repeat.is_some() {
        spawn_next_occurrence(store, &updated)?;
    }
    Ok(updated)
}

/// 删除待办，返回是否真的删到了
///
/// ⚠️ 和 [`purge_removed`] 一样是**真删**，所以删之前也留一份 `todos.json` 原文
/// （`backups/todos-删除前-<时间>.json`）。理由见 [`archive_todos`]：
/// `.bak` 只留得住**上一版**，而"上一版"会被紧接着的任何一次写覆盖掉。
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let raw = atomic::read_to_string(&todos_path(store))
        .map_err(|e| format!("读 todos.json 失败：{e}"))?
        .unwrap_or_default();
    let mut file = load(store)?;
    let before = file.items.len();
    file.items.retain(|item| item.id != id);
    if file.items.len() == before {
        return Ok(false);
    }
    archive_todos(store, "todos-删除前", "", &raw)?;
    save(store, &file)?;
    // M21（《同步协议》§5.3）：删待办要留一条**删除记录**，否则对面会把这条又传回来复活。
    // ⚠️ 埋墓碑失败**不该**让删除失败（真删已经发生了）→ 只留痕，不返回 Err。
    if let Err(e) = crate::store::sync::bury(store, id, "todo") {
        eprintln!("[东方摩耶堂] 删除记录没写成功（{id}）：{e}");
    }
    Ok(true)
}

/// 把某篇笔记产生的待办全部标成「来源已移除」（M5-1）
///
/// 笔记**被删掉**时用（标记连同笔记一起没了）。注意是"标"不是"删"：
/// 待办照旧留着，用户可能在别处已经做完了这件事。
pub fn mark_note_removed(store: &Store, note_id: &str) -> Result<usize, String> {
    let mut file = load(store)?;
    let mut touched = 0;
    for item in file.items.iter_mut() {
        if item.source.kind == crate::models::TodoSourceKind::Note
            && item.source.note_id.as_deref() == Some(note_id)
            && !item.source.source_removed
        {
            item.source.source_removed = true;
            item.source.marker_key = None;
            touch(item);
            touched += 1;
        }
    }
    if touched > 0 {
        save(store, &file)?;
    }
    Ok(touched)
}

/// 把"**来源笔记已经不在了**"的待办标成「来源已移除」。
///
/// 专门给 **M5 之前攒下来的孤儿待办**收账：那时候删笔记还不会标记
/// （标记行为是 M5-1 才补上的），于是这些待办既没有标记、界面上也看不出
/// 来源其实早就没了。反复跑验收脚本最容易攒出这种。
///
/// [`purge_removed`] 会**先跑一遍它**，所以界面那个「清理」按钮能一次收干净，
/// 不用用户先手动触发一次对账。
pub fn mark_orphans_removed(store: &Store) -> Result<usize, String> {
    let mut live: std::collections::HashSet<String> = crate::store::note::list(store)?
        .into_iter()
        .map(|note| note.id)
        .collect();
    // M15：**收进档案库的笔记也算"还在"**。
    // ⚠️ 收纳 ≠ 删除：那篇笔记只是被挪到 `notes/_archive/` 了，它 `-[]` 出来的待办
    //    不该因为"notes/ 里找不到"就被标成「来源已移除」（2026-09-27 子代理报的跨区联动问题）。
    //    真删掉笔记时（`note_delete`）走的是另一条路，照样会mark。
    if let Ok(archived) = crate::store::archive::list(store) {
        for one in archived {
            if one.kind == "note" {
                live.insert(one.id);
            }
        }
    }

    let mut file = load(store)?;
    let mut touched = 0;
    for item in file.items.iter_mut() {
        if item.source.kind != crate::models::TodoSourceKind::Note || item.source.source_removed {
            continue;
        }
        // `note_id` 都没有的（数据异常）也算孤儿
        let gone = item
            .source
            .note_id
            .as_deref()
            .map(|id| !live.contains(id))
            .unwrap_or(true);
        if gone {
            touch(item);
            item.source.source_removed = true;
            touched += 1;
        }
    }
    if touched > 0 {
        save(store, &file)?;
    }
    Ok(touched)
}

/// 清理前留在 `backups/` 里的底稿最多留几份（真正的清理逻辑在 `store::safety`）
///
/// 这里只留一个薄包装：`safety::archive` 是三个"真删"入口公用的
/// （待办清理 / 删单条待办 / 删信息 / 清空回收站），见 [`crate::store::safety`]。
fn archive_todos(store: &Store, prefix: &str, suffix: &str, raw: &str) -> Result<PathBuf, String> {
    crate::store::safety::archive(store, prefix, suffix, raw)
}

/// 清理之前留档（给 [`purge_removed`] 用；`removed` 只进文件名，方便人一眼看出删了几条）
fn archive_before_purge(store: &Store, raw: &str, removed: usize) -> Result<PathBuf, String> {
    archive_todos(store, "todos-清理前", &format!("{removed}条"), raw)
}

/// 清掉所有「来源已移除」的待办，返回清掉几条（界面上那个清理入口）
///
/// 先对一次账（见 [`mark_orphans_removed`]），把 M5 之前的老孤儿也标上再清。
/// 真删之前会留一份底稿（见 [`archive_before_purge`]）。
pub fn purge_removed(store: &Store) -> Result<usize, String> {
    mark_orphans_removed(store)?;
    // 先把"准备删的那一版"原文抓在手里，再去算要删几条
    let raw = atomic::read_to_string(&todos_path(store))
        .map_err(|e| format!("读 todos.json 失败：{e}"))?
        .unwrap_or_default();
    let mut file = load(store)?;
    let before = file.items.len();
    // M21：**真删之前**先把要埋的 id 抓在手里（删完就找不到了）
    let doomed: Vec<String> = file
        .items
        .iter()
        .filter(|item| item.source.source_removed)
        .map(|item| item.id.clone())
        .collect();
    file.items.retain(|item| !item.source.source_removed);
    let removed = before - file.items.len();
    if removed == 0 {
        return Ok(0);
    }
    archive_before_purge(store, &raw, removed)?;
    save(store, &file)?;
    // M21：清理掉的每一条都要留删除记录（否则对面会把它们又传回来）
    for id in &doomed {
        if let Err(e) = crate::store::sync::bury(store, id, "todo") {
            eprintln!("[东方摩耶堂] 删除记录没写成功（{id}）：{e}");
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{TodoSourceKind, TodoStatus};
    use crate::store::temp_store;
    use chrono::{Datelike, TimeZone};

    fn from_info(info_id: &str) -> TodoSource {
        TodoSource {
            kind: TodoSourceKind::Info,
            info_id: Some(info_id.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn 新建的待办排到最后且默认未完成() {
        let store = temp_store("todo-create");
        let a = create(&store, "第一件".into(), TodoSource::default(), None).unwrap();
        let b = create(&store, "第二件".into(), from_info("info-1"), None).unwrap();

        assert_eq!(a.order, 0);
        assert_eq!(b.order, 1);

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "第一件");
        assert_eq!(items[1].source.kind, TodoSourceKind::Info);
        assert_eq!(items[1].source.info_id.as_deref(), Some("info-1"));
        assert_eq!(items[1].status, TodoStatus::Open);
    }

    #[test]
    fn 空标题不许建() {
        let store = temp_store("todo-empty");
        assert!(create(&store, "  ".into(), TodoSource::default(), None).is_err());
    }

    #[test]
    fn 标完成会自动盖完成时间() {
        let store = temp_store("todo-done");
        let todo = create(&store, "做完它".into(), TodoSource::default(), None).unwrap();

        let saved = set_done(&store, &todo.id, true).unwrap();
        assert!(saved.done_at.is_some(), "标完成要盖上 doneAt");
        assert_eq!(saved.status, TodoStatus::Done);
        assert_eq!(list(&store).unwrap().len(), 1, "标完成不等于删除");
    }

    // ── D 批（2026-10-04）：分组 ────────────────────────────────────────

    #[test]
    fn 分组设得上也读得回_空串等于移出分组() {
        let store = temp_store("todo-group");
        let todo = create(&store, "复习高数".into(), TodoSource::default(), None).unwrap();
        assert_eq!(todo.group, "", "新建的一律未分组");

        let moved = set_group(&store, &todo.id, "学业".into()).unwrap();
        assert_eq!(moved.group, "学业");
        assert_eq!(list(&store).unwrap()[0].group, "学业", "真的落盘了");

        let out = set_group(&store, &todo.id, String::new()).unwrap();
        assert_eq!(out.group, "", "空串 = 移出分组");
    }

    #[test]
    fn 分组名会去空白并截到二十四字() {
        let store = temp_store("todo-group-trim");
        let todo = create(&store, "x".into(), TodoSource::default(), None).unwrap();

        let trimmed = set_group(&store, &todo.id, "  学业  ".into()).unwrap();
        assert_eq!(trimmed.group, "学业");

        let long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十".to_string();
        let cut = set_group(&store, &todo.id, long).unwrap();
        assert_eq!(cut.group.chars().count(), 24, "超过 24 字要截断（跟 Note.group 一个规矩）");
    }

    #[test]
    fn 分组名列表去重排序且不含未分组() {
        let store = temp_store("todo-groups");
        let a = create(&store, "a".into(), TodoSource::default(), None).unwrap();
        let b = create(&store, "b".into(), TodoSource::default(), None).unwrap();
        let c = create(&store, "c".into(), TodoSource::default(), None).unwrap();
        set_group(&store, &a.id, "学业".into()).unwrap();
        set_group(&store, &b.id, "生活".into()).unwrap();
        set_group(&store, &c.id, "学业".into()).unwrap();

        assert_eq!(groups(&store).unwrap(), vec!["学业".to_string(), "生活".into()]);
    }

    #[test]
    fn 老数据里没有group字段也能读进来() {
        // D 批之前的 todos.json 长这样（没有 group）—— `#[serde(default)]` 要能读成空串
        let store = temp_store("todo-old-json");
        let old = r#"{"items":[{"id":"old-1","title":"老待办","order":0,"status":"open",
            "source":{"kind":"manual"},"pomodoros":[],"focusNote":"","createdAt":"2026-01-01T00:00:00.000Z"}]}"#;
        crate::store::atomic::atomic_write_str(&todos_path(&store), old).unwrap();

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "老待办");
        assert_eq!(items[0].group, "", "没有 group 字段 → 未分组（不是读崩）");
    }

    #[test]
    fn 改不存在的待办要报错() {
        let store = temp_store("todo-ghost");
        assert!(set_done(&store, "不存在", true).is_err());
        assert!(set_title(&store, "不存在", "x".into()).is_err());
        assert!(set_planned_at(&store, "不存在", None).is_err());
    }

    #[test]
    fn 删除返回是否删到并留_bak() {
        let store = temp_store("todo-delete");
        let todo = create(&store, "删我".into(), TodoSource::default(), None).unwrap();
        assert!(delete(&store, &todo.id).unwrap());
        assert!(!delete(&store, &todo.id).unwrap());
        assert!(list(&store).unwrap().is_empty());

        let bak = atomic::read_to_string(&atomic::bak_path(&todos_path(&store)))
            .unwrap()
            .unwrap();
        assert!(bak.contains("删我"), ".bak 里应留着删除前的内容");
    }

    // ─────────────────── M5：操作式命令 ───────────────────

    #[test]
    fn 标完成盖时间_取消完成抹掉时间() {
        let store = temp_store("todo-done-toggle");
        let todo = create(&store, "勾我".into(), TodoSource::default(), None).unwrap();

        let done = set_done(&store, &todo.id, true).unwrap();
        assert_eq!(done.status, TodoStatus::Done);
        assert!(done.done_at.is_some(), "完成要盖完成时间");

        let undone = set_done(&store, &todo.id, false).unwrap();
        assert_eq!(undone.status, TodoStatus::Open);
        assert!(undone.done_at.is_none(), "退回未完成要把完成时间抹掉");
        assert_eq!(list(&store).unwrap().len(), 1, "来回勾不会多出待办");
    }

    #[test]
    fn 信息区来的待办也能标完成() {
        // 用户点名要的一条：M3 过渡期「来源=信息」的待办没法完成
        let store = temp_store("todo-done-from-info");
        let todo = create(&store, "信息来的".into(), from_info("info-9"), None).unwrap();
        assert_eq!(todo.source.kind, TodoSourceKind::Info);

        let done = set_done(&store, &todo.id, true).unwrap();
        assert_eq!(done.status, TodoStatus::Done);
        // 来源一点没动
        assert_eq!(done.source.kind, TodoSourceKind::Info);
        assert_eq!(done.source.info_id.as_deref(), Some("info-9"));
    }

    #[test]
    fn patch_只动传进来的字段() {
        let store = temp_store("todo-patch");
        let made = create(&store, "原标题".into(), from_info("info-1"), None).unwrap();
        let with_planned = patch(
            &store,
            &made.id,
            TodoPatch {
                planned_at: Some(Some("2026-09-21T09:00:00.000+08:00".into())),
                ..Default::default()
            },
        )
        .unwrap();
        // 追加一次番茄钟，用来验证后面的 patch 不会把它抹掉（这正是"整条覆盖"的坑）
        add_pomodoro(
            &store,
            &made.id,
            "countdown".into(),
            1500,
            "第一次".into(),
            false,
            PomodoroExtra::default(),
        )
        .unwrap();

        let after = patch(
            &store,
            &made.id,
            TodoPatch {
                title: Some("改过的标题".into()),
                quadrant: Some(Some(crate::models::Quadrant::Q1)),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(after.title, "改过的标题");
        assert_eq!(after.quadrant, Some(crate::models::Quadrant::Q1));
        assert_eq!(
            after.planned_at, with_planned.planned_at,
            "没传 plannedAt 就不该被动"
        );
        assert_eq!(after.source.info_id.as_deref(), Some("info-1"), "来源不该被动");
        assert_eq!(after.pomodoros.len(), 1, "番茄钟记录不该被抹掉");
    }

    #[test]
    fn patch_能清空可空字段() {
        let store = temp_store("todo-patch-clear");
        let made = create(&store, "带时间的".into(), TodoSource::default(), None).unwrap();
        patch(
            &store,
            &made.id,
            TodoPatch {
                planned_at: Some(Some("2026-09-21T09:00:00.000+08:00".into())),
                quadrant: Some(Some(crate::models::Quadrant::Q3)),
                ..Default::default()
            },
        )
        .unwrap();

        let cleared = patch(
            &store,
            &made.id,
            TodoPatch {
                planned_at: Some(None),
                quadrant: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(cleared.planned_at.is_none(), "传 Some(None) 要清空");
        assert!(cleared.quadrant.is_none(), "四象限要能拖回去");
    }

    /// ⚠️ **一次真实的翻车记录，别再试那个"双层 Option 小技巧"**。
    ///
    /// 本来想让 `todo_update(plannedAt: Option<Option<String>>)` 用
    /// "键不传 = 不动 / 传 null = 清空"这套三态。写完单测才发现**它在本项目里行不通**：
    /// serde 反序列化 `null` 时，**外层 `Option` 直接把它吃成 `None`**，
    /// 压根不会去问内层。于是"清空"会静默变成"不动"，用户点了清空却没反应。
    /// （那个技巧要配 `serde_with::double_option` 才行，为一个字段加一个 crate 不值。）
    ///
    /// 结论：**清空一律走专用 setter**（`set_planned_at(None)` / `set_quadrant(None)`）。
    /// 这条测试把 serde 的行为钉住，免得以后有人又去走一遍这条弯路。
    #[test]
    fn 记一笔_双层option分不开不传和null_所以改用专用setter() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            planned_at: Option<Option<String>>,
        }

        let missing: Args = serde_json::from_str("{}").unwrap();
        assert!(missing.planned_at.is_none(), "键不传 → 外层 None");

        let null: Args = serde_json::from_str(r#"{"plannedAt":null}"#).unwrap();
        assert!(
            null.planned_at.is_none(),
            "★ serde 把 null 也吃成了 None —— 这就是双层 Option 在这里不好使的原因"
        );
        // 有值的时候倒是能正常拿到
        let value: Args = serde_json::from_str(r#"{"plannedAt":"2026-09-21T09:00:00.000Z"}"#).unwrap();
        assert_eq!(
            value.planned_at,
            Some(Some("2026-09-21T09:00:00.000Z".to_string()))
        );
    }

    #[test]
    fn 专用setter能设也能清空() {
        let store = temp_store("todo-setters");
        let made = create(&store, "原标题".into(), from_info("info-1"), None).unwrap();

        let with_time = set_planned_at(
            &store,
            &made.id,
            Some("2026-09-21T09:00:00.000+08:00".into()),
        )
        .unwrap();
        assert_eq!(
            with_time.planned_at.as_deref(),
            Some("2026-09-21T09:00:00.000+08:00")
        );

        let quadrant = set_quadrant(&store, &made.id, Some(crate::models::Quadrant::Q2)).unwrap();
        assert_eq!(quadrant.quadrant, Some(crate::models::Quadrant::Q2));
        assert_eq!(
            quadrant.planned_at, with_time.planned_at,
            "设分类不该动设定时间"
        );

        let renamed = set_title(&store, &made.id, "新标题".into()).unwrap();
        assert_eq!(renamed.title, "新标题");
        assert_eq!(
            renamed.quadrant,
            Some(crate::models::Quadrant::Q2),
            "改标题不该动分类"
        );
        assert_eq!(
            renamed.source.info_id.as_deref(),
            Some("info-1"),
            "来源一路都没被动过"
        );

        // 清空
        let cleared = set_planned_at(&store, &made.id, None).unwrap();
        assert!(cleared.planned_at.is_none(), "传 None 要清空");
        let out = set_quadrant(&store, &made.id, None).unwrap();
        assert!(out.quadrant.is_none(), "四象限要能拖出去");

        // 空串也算清空（前端把输入框清掉时给的就是空串）
        set_reminder_at(
            &store,
            &made.id,
            Some("2026-09-21T10:00:00.000+08:00".into()),
        )
        .unwrap();
        let blank = set_reminder_at(&store, &made.id, Some("   ".into())).unwrap();
        assert!(blank.reminder_at.is_none(), "空白也要当清空");
    }

    #[test]
    fn reorder_按传入顺序重排_没提到的排后面且相对顺序不变() {
        let store = temp_store("todo-reorder");
        let a = create(&store, "甲".into(), TodoSource::default(), None).unwrap();
        let b = create(&store, "乙".into(), TodoSource::default(), None).unwrap();
        let c = create(&store, "丙".into(), TodoSource::default(), None).unwrap();

        let sorted = reorder(&store, &[c.id.clone(), a.id.clone()]).unwrap();
        let titles: Vec<&str> = sorted.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, vec!["丙", "甲", "乙"], "丙甲提到前面，乙自动跟后面");

        // 再重排一次，id 列表里有个不存在的也不该炸
        let again = reorder(&store, &["不存在的id".into(), b.id.clone()]).unwrap();
        let titles2: Vec<&str> = again.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles2, vec!["乙", "丙", "甲"]);
    }

    #[test]
    fn 番茄钟结束标完成但绝不删除且记录入档() {
        let store = temp_store("todo-pomodoro");
        let todo = create(&store, "专注一下".into(), TodoSource::default(), None).unwrap();

        let after = add_pomodoro(
            &store,
            &todo.id,
            "countdown".into(),
            1500,
            "被手机打断了一次".into(),
            true,
            PomodoroExtra::default(),
        )
        .unwrap();

        assert_eq!(after.status, TodoStatus::Done, "结束要标完成");
        assert!(after.done_at.is_some());
        assert_eq!(after.pomodoros.len(), 1);
        assert_eq!(after.pomodoros[0].mode, "countdown");
        assert_eq!(after.pomodoros[0].seconds, 1500);
        assert_eq!(after.pomodoros[0].note, "被手机打断了一次");

        let all = list(&store).unwrap();
        assert_eq!(all.len(), 1, "★ 标完成不等于删除：待办必须还在");
        assert_eq!(all[0].pomodoros.len(), 1, "记录要落盘");
    }

    #[test]
    fn 记番茄钟可以不结束() {
        let store = temp_store("todo-pomodoro-open");
        let todo = create(&store, "歇一会儿".into(), TodoSource::default(), None).unwrap();
        let after = add_pomodoro(
            &store,
            &todo.id,
            "free".into(),
            60,
            String::new(),
            false,
            PomodoroExtra::default(),
        )
        .unwrap();
        assert_eq!(after.status, TodoStatus::Open, "不计时的记录不该把待办标完成");
        assert_eq!(after.pomodoros.len(), 1);
    }

    /// M5 之前攒下来的孤儿待办（来源笔记早没了、又没被标记过）也要能收账
    #[test]
    fn 对账能把来源笔记已不在的待办标出来() {
        let store = temp_store("todo-orphan-reconcile");
        // 真建一篇笔记，再删掉它 —— 直接构造 note_id 会让"笔记在不在"这件事说不清
        let note = crate::store::note::create(
            &store,
            crate::models::NoteKind::Doc,
            "会被删掉的笔记".into(),
        )
        .unwrap();
        let alive = create(
            &store,
            "笔记还在".into(),
            TodoSource {
                kind: TodoSourceKind::Note,
                note_id: Some(note.id.clone()),
                marker_key: Some("k1".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let orphan = create(
            &store,
            "笔记早就没了".into(),
            TodoSource {
                kind: TodoSourceKind::Note,
                note_id: Some("早就没了的笔记id".into()),
                marker_key: Some("k2".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let manual = create(&store, "手工的".into(), TodoSource::default(), None).unwrap();

        let touched = mark_orphans_removed(&store).unwrap();
        assert_eq!(touched, 1, "只有「笔记没了」那条该被标");

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 3, "★ 对账只标不删");
        let by_id = |id: &str| items.iter().find(|t| t.id == id).unwrap().clone();
        assert!(by_id(&orphan.id).source.source_removed);
        assert!(!by_id(&alive.id).source.source_removed, "笔记还在的不该被标");
        assert!(!by_id(&manual.id).source.source_removed, "手动的更不该被标");

        // 清理由 purge 负责，而且它自己会先对一次账
        assert_eq!(purge_removed(&store).unwrap(), 1);
        assert_eq!(list(&store).unwrap().len(), 2);
    }

    #[test]
    fn 来源已移除是标记而不是删除() {
        let store = temp_store("todo-source-removed");
        // 乙那条挂在一篇**真笔记**上，好让"别篇笔记不受影响"这句话有依据
        // （甲那条挂的是个不存在的 noteId —— 它本来就是要被标成孤儿的那个）
        let real = crate::store::note::create(
            &store,
            crate::models::NoteKind::Doc,
            "真笔记".into(),
        )
        .unwrap();

        let todo_a = create(
            &store,
            "甲".into(),
            TodoSource {
                kind: TodoSourceKind::Note,
                note_id: Some("note-a".into()),
                marker_key: Some("note-a#甲".into()),
                marker_text: Some("甲".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let todo_b = create(
            &store,
            "乙".into(),
            TodoSource {
                kind: TodoSourceKind::Note,
                note_id: Some(real.id.clone()),
                marker_key: Some(format!("{}#乙", real.id)),
                marker_text: Some("乙".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();

        let touched = mark_note_removed(&store, "note-a").unwrap();
        assert_eq!(touched, 1, "只动那一篇笔记的待办");
        assert_eq!(list(&store).unwrap().len(), 2, "★ 一条都没删");

        let items = list(&store).unwrap();
        let a = items.iter().find(|t| t.id == todo_a.id).unwrap();
        let b = items.iter().find(|t| t.id == todo_b.id).unwrap();
        assert!(a.source.source_removed, "甲应被标为来源已移除");
        assert!(!b.source.source_removed, "别篇笔记的待办不受影响");

        // 再标一次不该重复计数
        assert_eq!(mark_note_removed(&store, "note-a").unwrap(), 0);

        // 清理入口：只清被标的那些（乙的笔记还在，动不到它）
        assert_eq!(purge_removed(&store).unwrap(), 1);
        let left = list(&store).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, todo_b.id);
    }

    #[test]
    fn 清理之前一定会先留一份底稿() {
        // 守 2026-09-20 那次丢数据：清理是真删，删之前必须在 backups/ 里留一份原文，
        // 而且要留**删之前那一版的全文**（被删的那几条也在里面），不能只留个空壳。
        let store = temp_store("todo-purge-archive");
        let keep = create(&store, "要留着的".into(), from_info("info-1"), None).unwrap();
        create(&store, "会被清掉的甲".into(), from_info("info-2"), None).unwrap();
        create(
            &store,
            "会被清掉的乙".into(),
            TodoSource {
                kind: TodoSourceKind::Note,
                note_id: Some("早就没了的笔记".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();

        // 清之前：没有 backups 目录，也不该凭空建
        let dir = store.data_dir().join("backups");
        assert!(!dir.exists(), "没清理之前不该建 backups");

        // 乙挂的是不存在的笔记 → purge 里那次对账会自己标上它；
        // 甲是信息来的、对账动不到，这里手动标一下，凑够「要删两条」的场景
        let mut file = load(&store).unwrap();
        for item in file.items.iter_mut() {
            if item.title == "会被清掉的甲" {
                item.source.source_removed = true;
            }
        }
        save(&store, &file).unwrap();

        assert_eq!(purge_removed(&store).unwrap(), 2);
        let left = list(&store).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, keep.id);

        // ★ 底稿：名字带条数，内容是被清那一版的全文
        let archived: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("todos-清理前-") && name.ends_with(".json"))
            .collect();
        assert_eq!(archived.len(), 1, "应该正好留一份底稿：{archived:?}");
        assert!(archived[0].contains("2条"), "文件名要写清几条：{}", archived[0]);

        let raw = std::fs::read_to_string(dir.join(&archived[0])).unwrap();
        assert!(raw.starts_with('{'), "底稿不该带 BOM（serde 会读不动）");
        for title in ["要留着的", "会被清掉的甲", "会被清掉的乙"] {
            assert!(raw.contains(title), "底稿里少了「{title}」：{raw}");
        }

        // 没有要清的 → 不该产生新底稿
        assert_eq!(purge_removed(&store).unwrap(), 0);
        let again = std::fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(again, 1, "没删东西就不该多留档");
    }

    #[test]
    fn 删单条待办之前也会留一份底稿() {
        // 2026-09-21 用户拍板 A1 之后顺手加的：`delete` 也是真删，
        // `.bak` 只留得住上一版（再点两下别的就没了），所以同样先留档。
        let store = temp_store("todo-delete-archive");
        let a = create(&store, "要删的".into(), from_info("i1"), None).unwrap();
        let b = create(&store, "留着的".into(), from_info("i2"), None).unwrap();

        assert!(delete(&store, &a.id).unwrap());
        assert_eq!(list(&store).unwrap().len(), 1);

        let dir = store.data_dir().join("backups");
        let archived: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("todos-删除前-") && name.ends_with(".json"))
            .collect();
        assert_eq!(archived.len(), 1, "应该留一份底稿：{archived:?}");

        let raw = std::fs::read_to_string(dir.join(&archived[0])).unwrap();
        assert!(raw.contains("要删的"), "底稿里得有待删那条：{raw}");
        assert!(raw.contains("留着的"), "底稿里也得有别的待办：{raw}");
        let _ = b;

        // 删不存在的 → 什么都没发生，也不该多留档
        assert!(!delete(&store, "根本没有这个 id").unwrap());
        let again = std::fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(again, 1, "没删着就不该多留档");
    }

    // 「留档只留最近 20 份、别的族/.bak/整包备份都不动」那条测试搬到
    // `store::safety` 里去了（`每族只留最近二十份_别的族和bak都不动`）——
    // 留档现在是三个"真删"入口公用的，测试也该跟着待在公用模块里，别两处各写一份。

    #[test]
    fn 截止日期和设定时间是两个字段_互不影响() {
        // M9-1：`plannedAt`（打算什么时候做）与 `dueAt`（最晚什么时候完成）必须能**同时**存在，
        // 而且改一个不许动另一个 —— 它们很容易被后人"合并成一个时间"。
        let store = temp_store("todo-due-at");
        let todo = create(&store, "两套时间".into(), from_info("i1"), None).unwrap();
        assert!(todo.due_at.is_none(), "新建的待办没有截止日期");

        let planned = set_planned_at(&store, &todo.id, Some("2026-09-22T09:00:00.000+08:00".into())).unwrap();
        assert_eq!(planned.planned_at.as_deref(), Some("2026-09-22T09:00:00.000+08:00"));
        assert!(planned.due_at.is_none(), "设设定时间不该顺手写截止日期");

        let due = set_due_at(&store, &todo.id, Some("2026-09-25T18:00:00.000+08:00".into())).unwrap();
        assert_eq!(due.due_at.as_deref(), Some("2026-09-25T18:00:00.000+08:00"));
        assert_eq!(
            due.planned_at.as_deref(),
            Some("2026-09-22T09:00:00.000+08:00"),
            "设截止日期不该动设定时间"
        );

        // 清空：空串和 None 都算清掉
        let cleared = set_due_at(&store, &todo.id, Some("   ".into())).unwrap();
        assert!(cleared.due_at.is_none(), "空串 = 清掉");
        set_due_at(&store, &todo.id, Some("2026-09-26T18:00:00.000+08:00".into())).unwrap();
        let cleared2 = set_due_at(&store, &todo.id, None).unwrap();
        assert!(cleared2.due_at.is_none(), "None = 清掉");
        assert_eq!(cleared2.planned_at.as_deref(), Some("2026-09-22T09:00:00.000+08:00"));

        // 标完成不该动截止日期（"完成了但曾经逾期"这个事实要留着）
        let done = set_done(&store, &todo.id, true).unwrap();
        assert!(done.due_at.is_none() || done.due_at.is_some(), "只是确认不炸");
        set_due_at(&store, &todo.id, Some("2026-09-27T18:00:00.000+08:00".into())).unwrap();
        let finished = set_done(&store, &todo.id, true).unwrap();
        assert_eq!(
            finished.due_at.as_deref(),
            Some("2026-09-27T18:00:00.000+08:00"),
            "标完成不该把截止日期抹掉"
        );
    }

    #[test]
    fn 旧文件没有_duedate_字段也能读() {
        // 守「加字段必须带 default」：M9 之前写的 todos.json 里没有 dueAt
        let store = temp_store("todo-old-no-due");
        let path = todos_path(&store);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic::atomic_write_str(
            &path,
            r#"{"items":[{"id":"t1","title":"老待办","order":0,"status":"open",
                 "source":{"kind":"manual"},"pomodoros":[],"createdAt":"2026-09-01T00:00:00.000+08:00"}]}"#,
        )
        .unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].due_at.is_none(), "缺字段 → 没有截止日期");
        assert_eq!(items[0].title, "老待办");
    }

    #[test]
    fn 子任务能加能勾能删_而且不动别的字段() {
        // M9-2：子任务是"一条待办下面的小步骤"。三个底线：
        // ① 空文本不接受；② 勾/删只动那一条子任务；③ 待办自己的字段一个都不许碰。
        let store = temp_store("todo-subtasks");
        let todo = create(&store, "大扫除".into(), from_info("i1"), None).unwrap();
        assert!(todo.subtasks.is_empty(), "新建的待办没有子任务");

        let with_planned = set_planned_at(
            &store,
            &todo.id,
            Some("2026-09-22T09:00:00.000+08:00".into()),
        )
        .unwrap();
        let a = subtask_add(&store, &todo.id, "擦桌子".into()).unwrap();
        let b = subtask_add(&store, &todo.id, "  拖地  ".into()).unwrap();
        assert_eq!(b.subtasks.len(), 2);
        assert_eq!(b.subtasks[1].text, "拖地", "子任务文本要 trim");
        assert!(!b.subtasks[0].done, "新加的子任务默认没完成");
        assert_eq!(b.planned_at, with_planned.planned_at, "加子任务不该动设定时间");
        assert_eq!(b.title, "大扫除");

        // 空文本要被挡下来（别让清单里出现空白行）
        assert!(subtask_add(&store, &todo.id, "   ".into()).is_err(), "空子任务要被拒绝");
        assert!(subtask_add(&store, &todo.id, String::new()).is_err());

        // 勾上第一条（注意 `a` 是"加第一条之后"的快照，只有 1 条；第二条在 `b` 里）
        let first_id = a.subtasks[0].id.clone();
        let second_id = b.subtasks[1].id.clone();
        let toggled = subtask_toggle(&store, &todo.id, &first_id, true).unwrap();
        assert!(toggled.subtasks[0].done, "第一条该被勾上");
        assert!(!toggled.subtasks[1].done, "第二条不许被连累");

        // 取消勾选
        let untoggled = subtask_toggle(&store, &todo.id, &first_id, false).unwrap();
        assert!(!untoggled.subtasks[0].done);

        // 删第二条
        let removed = subtask_remove(&store, &todo.id, &second_id).unwrap();
        assert_eq!(removed.subtasks.len(), 1);
        assert_eq!(removed.subtasks[0].id, first_id, "剩下的是第一条");
        assert_eq!(removed.planned_at, with_planned.planned_at, "删子任务不该动设定时间");

        // 删/勾不存在的子任务要报错（而不是静默成功）
        assert!(subtask_remove(&store, &todo.id, "根本没有").is_err());
        assert!(subtask_toggle(&store, &todo.id, "根本没有", true).is_err());

        // 上限 30：再多就不是"步骤"、是另一张清单了
        for index in 0..40 {
            let _ = subtask_add(&store, &todo.id, format!("第 {index} 步"));
        }
        let capped = list(&store)
            .unwrap()
            .into_iter()
            .find(|one| one.id == todo.id)
            .unwrap();
        assert_eq!(capped.subtasks.len(), 30, "最多 30 个");
    }

    #[test]
    fn 旧文件没有_subtasks_字段也能读() {
        let store = temp_store("todo-old-no-subtasks");
        let path = todos_path(&store);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic::atomic_write_str(
            &path,
            r#"{"items":[{"id":"t1","title":"老待办","order":0,"status":"open",
                 "source":{"kind":"manual"},"pomodoros":[],"createdAt":"2026-09-01T00:00:00.000+08:00"}]}"#,
        )
        .unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].subtasks.is_empty(), "缺字段 → 空清单");
    }

    // ─────────────────── M9-6：重复待办 ───────────────────

    /// 造一条"带重复规则 + 设定时间 + 子任务"的待办，供下面几个测试复用
    fn repeating(store: &Store, title: &str, planned: &str) -> Todo {
        let made = create(store, title.into(), TodoSource::default(), Some(planned.into())).unwrap();
        subtask_add(store, &made.id, "第一步".into()).unwrap();
        subtask_add(store, &made.id, "第二步".into()).unwrap();
        set_repeat(store, &made.id, Some(crate::models::Repeat::Daily)).unwrap()
    }

    #[test]
    fn 勾完重复待办会自动派下一条_时间往后推一天() {
        let store = temp_store("todo-repeat-daily");
        // 用一个**还没到**的时间当锚，日期差才算得准（不受"现在是几点"影响）
        let anchor = (chrono::Local::now().date_naive() + chrono::Duration::days(1))
            .and_hms_opt(9, 0, 0)
            .unwrap();
        let anchor_iso = chrono::Local
            .from_local_datetime(&anchor)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false);

        let todo = repeating(&store, "每天喝水", &anchor_iso);
        let done = set_done(&store, &todo.id, true).unwrap();
        assert_eq!(done.status, TodoStatus::Done);

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 2, "★ 勾完应该多出一条下一次的");
        let next = items.iter().find(|t| t.id != todo.id).unwrap();
        assert_eq!(next.title, "每天喝水");
        assert_eq!(next.status, TodoStatus::Open, "下一条是未完成");
        assert_eq!(next.repeat, Some(crate::models::Repeat::Daily), "重复规则要接着传下去");
        assert_eq!(next.repeat_from.as_deref(), Some(todo.id.as_str()));
        let shifted = chrono::DateTime::parse_from_rfc3339(next.planned_at.as_deref().unwrap()).unwrap();
        assert_eq!(
            shifted.with_timezone(&chrono::Local).naive_local(),
            anchor + chrono::Duration::days(1),
            "下一次应该正好是明天同一时刻"
        );

        // 子任务照抄一份、全部重置
        assert_eq!(next.subtasks.len(), 2, "子任务要跟着过去");
        assert_eq!(next.subtasks[0].text, "第一步");
        assert!(next.subtasks.iter().all(|sub| !sub.done), "新一份的子任务要全部没完成");
        assert_ne!(
            next.subtasks[0].id, done.subtasks[0].id,
            "子任务 id 要是新的（不然两份共用一条，勾了会串）"
        );
        assert_eq!(done.subtasks[0].done, false);
    }

    #[test]
    fn 来回勾只会派一次_不会滚出一串() {
        // ⚠️ 这条是重复功能最容易翻车的地方：用户点错了取消再点上，或者脚本重跑，
        //    没有 `repeatFrom` 去重的话会滚出一长串一模一样的待办。
        let store = temp_store("todo-repeat-idempotent");
        let todo = repeating(&store, "每天背单词", "2026-09-21T09:00:00.000+08:00");

        set_done(&store, &todo.id, true).unwrap();
        assert_eq!(list(&store).unwrap().len(), 2, "第一次勾：派一条");

        // 取消完成 → 再勾一次
        set_done(&store, &todo.id, false).unwrap();
        assert_eq!(list(&store).unwrap().len(), 2, "取消完成不会删掉已派出去的那条");
        set_done(&store, &todo.id, true).unwrap();
        assert_eq!(list(&store).unwrap().len(), 2, "★ 再勾一次不许再派");

        // 直接调也行（脚本/重试路径）
        assert!(spawn_next_occurrence(&store, &list(&store).unwrap()[0]).unwrap().is_none());
        assert_eq!(list(&store).unwrap().len(), 2);
    }

    #[test]
    fn 没有重复规则的待办_勾完不派新的() {
        let store = temp_store("todo-no-repeat");
        let todo = create(&store, "一次性的".into(), TodoSource::default(), None).unwrap();
        set_done(&store, &todo.id, true).unwrap();
        assert_eq!(list(&store).unwrap().len(), 1);
    }

    #[test]
    fn 隔了很久才勾_直接跳到将来_中间漏掉的不补() {
        // 用户出去了半个月，回来才把"每天做"那条勾掉：
        // 一格一格补会一口气冒出十几条早该过去的日子，界面上就是一堆逾期。
        let store = temp_store("todo-repeat-catchup");
        let past = chrono::Local::now() - chrono::Duration::days(10);
        let past_iso = past.to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
        let todo = repeating(&store, "每天拉伸", &past_iso);

        set_done(&store, &todo.id, true).unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 2, "★ 只派一条，不补齐漏掉的十天");
        let next = items.iter().find(|t| t.id != todo.id).unwrap();
        let at = chrono::DateTime::parse_from_rfc3339(next.planned_at.as_deref().unwrap()).unwrap();
        assert!(
            at.with_timezone(&chrono::Local) > chrono::Local::now(),
            "下一次必须落在将来：{}",
            next.planned_at.as_deref().unwrap()
        );
    }

    #[test]
    fn 每周和每月推得对_而且_duedate_跟着一起推() {
        let store = temp_store("todo-repeat-weekly");
        let anchor = chrono::Local::now().date_naive() + chrono::Duration::days(3);
        let planned = anchor.and_hms_opt(15, 0, 0).unwrap();
        let due = anchor.and_hms_opt(23, 0, 0).unwrap();
        let iso = |value: chrono::NaiveDateTime| {
            chrono::Local
                .from_local_datetime(&value)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
        };

        let made = create(&store, "交周报".into(), TodoSource::default(), Some(iso(planned))).unwrap();
        set_due_at(&store, &made.id, Some(iso(due))).unwrap();
        set_repeat(&store, &made.id, Some(crate::models::Repeat::Weekly)).unwrap();

        set_done(&store, &made.id, true).unwrap();
        let next = list(&store)
            .unwrap()
            .into_iter()
            .find(|t| t.id != made.id)
            .unwrap();
        let next_planned =
            chrono::DateTime::parse_from_rfc3339(next.planned_at.as_deref().unwrap()).unwrap();
        let next_due = chrono::DateTime::parse_from_rfc3339(next.due_at.as_deref().unwrap()).unwrap();
        assert_eq!(
            next_planned.with_timezone(&chrono::Local).naive_local(),
            planned + chrono::Duration::days(7),
            "每周 → 设定时间往后 7 天"
        );
        assert_eq!(
            next_due.with_timezone(&chrono::Local).naive_local(),
            due + chrono::Duration::days(7),
            "★ 截止日期要跟着一起推（不然新的一条一出生就是逾期）"
        );

        // 每月：月底那天要能正常落到下个月（1 月 31 日 → 2 月 28/29 日，不许 panic）
        let store2 = temp_store("todo-repeat-monthly");
        let made2 = create(
            &store2,
            "交房租".into(),
            TodoSource::default(),
            Some("2026-01-31T09:00:00.000+08:00".into()),
        )
        .unwrap();
        set_repeat(&store2, &made2.id, Some(crate::models::Repeat::Monthly)).unwrap();
        set_done(&store2, &made2.id, true).unwrap();
        let next2 = list(&store2)
            .unwrap()
            .into_iter()
            .find(|t| t.id != made2.id)
            .unwrap();
        let at2 = chrono::DateTime::parse_from_rfc3339(next2.planned_at.as_deref().unwrap()).unwrap();
        let local2 = at2.with_timezone(&chrono::Local).naive_local();
        assert!(local2 > chrono::Local::now().naive_local(), "每月那条也要跳到将来");
        assert!(local2.year() >= 2026, "别把年份算飞了：{local2}");
    }

    #[test]
    fn 重复规则能设也能清_旧文件没这个字段也能读() {
        let store = temp_store("todo-repeat-field");
        let todo = create(&store, "看看".into(), TodoSource::default(), None).unwrap();
        assert!(todo.repeat.is_none(), "新建的待办不重复");
        assert!(todo.repeat_from.is_none());

        let set = set_repeat(&store, &todo.id, Some(crate::models::Repeat::Monthly)).unwrap();
        assert_eq!(set.repeat, Some(crate::models::Repeat::Monthly));
        let cleared = set_repeat(&store, &todo.id, None).unwrap();
        assert!(cleared.repeat.is_none(), "传 None = 不重复");
        assert!(cleared.repeat_from.is_none(), "清规则不该乱写 repeatFrom");

        // 旧文件（M9 之前写的、没有这两个字段）
        let store2 = temp_store("todo-old-no-repeat");
        let path = todos_path(&store2);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic::atomic_write_str(
            &path,
            r#"{"items":[{"id":"t1","title":"老待办","order":0,"status":"open",
                 "source":{"kind":"manual"},"pomodoros":[],"createdAt":"2026-09-01T00:00:00.000+08:00"}]}"#,
        )
        .unwrap();
        let items = list(&store2).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].repeat.is_none(), "缺字段 → 不重复");
        assert!(items[0].repeat_from.is_none());
    }

    #[test]
    fn 番茄钟结束标完成_重复待办也照样派下一次() {
        // 勾复选框和"番茄钟结束顺手标完成"是**两条**把待办标完成的路径，
        // 重复派发必须两条都覆盖 —— 少一条就是"重复偶尔不灵"的幽灵 bug。
        let store = temp_store("todo-repeat-pomodoro");
        let todo = repeating(&store, "每天专注", "2026-09-21T09:00:00.000+08:00");

        add_pomodoro(
            &store,
            &todo.id,
            "countdown".into(),
            1500,
            String::new(),
            true,
            PomodoroExtra::default(),
        )
        .unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items.len(), 2, "番茄钟结束标完成也要派下一条");
        assert!(items.iter().any(|t| t.repeat_from.as_deref() == Some(todo.id.as_str())));

        // 不结束（finish=false）不该派
        let store2 = temp_store("todo-repeat-pomodoro-open");
        let another = repeating(&store2, "每天专注".into(), "2026-09-21T09:00:00.000+08:00");
        add_pomodoro(
            &store2,
            &another.id,
            "free".into(),
            60,
            String::new(),
            false,
            PomodoroExtra::default(),
        )
        .unwrap();
        assert_eq!(list(&store2).unwrap().len(), 1, "没标完成就不该派");
    }

    #[test]
    fn 旧文件没有_sourceremoved_字段也能读() {
        // 守「加字段必须带 default」：M4 之前写的 todos.json 里没有这个字段
        let store = temp_store("todo-old-file");
        let path = todos_path(&store);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic::atomic_write_str(
            &path,
            r#"{"items":[{"id":"t1","title":"老待办","order":0,"status":"open",
                 "source":{"kind":"note","noteId":"n1","markerKey":"n1#老待办","markerText":"老待办"},
                 "pomodoros":[],"createdAt":"2026-09-01T00:00:00.000+08:00"}]}"#,
        )
        .unwrap();

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "老待办");
        assert!(!items[0].source.source_removed, "缺字段应读成 false");
        assert!(items[0].source.node_id.is_none());
    }

    #[test]
    fn 写出来的_json_不带上多余的_null() {
        // 顺手做的：`source` 里那几个 Option 加了 skip_serializing_if，文件干净些
        let store = temp_store("todo-nulls");
        create(&store, "手工的".into(), TodoSource::default(), None).unwrap();
        let raw = atomic::read_to_string(&todos_path(&store)).unwrap().unwrap();
        assert!(!raw.contains("null"), "不该写出 null：{raw}");
    }

    // ─────────────────── M13-C：专注小窗的「须知」 ───────────────────

    #[test]
    fn 改须知只改这一个字段_别的字段与番茄记录一个不动() {
        // 「须知」是**操作式**命令：读盘 → 只改这一个字段 → 原子写回。
        // 整条覆盖会把后端自己写进去的番茄记录抹掉（M4/M5 的坑），所以这条测试
        // 先把别的字段和一条番茄记录摆上，改完逐项比对。
        let store = temp_store("todo-focus-note");
        let todo = create(&store, "写方案".into(), from_info("info-9"), None).unwrap();
        set_planned_at(
            &store,
            &todo.id,
            Some("2026-09-26T09:00:00.000+08:00".into()),
        )
        .unwrap();
        set_quadrant(&store, &todo.id, Some(crate::models::Quadrant::Q1)).unwrap();
        add_pomodoro(
            &store,
            &todo.id,
            "countdown".into(),
            1500,
            "第一笔".into(),
            false,
            PomodoroExtra::default(),
        )
        .unwrap();

        let before = list(&store).unwrap().remove(0);
        let after = set_focus_note(&store, &todo.id, "先关手机；只做这一件事").unwrap();

        assert_eq!(after.focus_note, "先关手机；只做这一件事");
        assert_eq!(after.id, before.id);
        assert_eq!(after.title, before.title);
        assert_eq!(after.order, before.order);
        assert_eq!(after.planned_at, before.planned_at, "设定时间不许被碰");
        assert_eq!(after.due_at, before.due_at);
        assert_eq!(after.status, before.status);
        assert_eq!(after.done_at, before.done_at);
        assert_eq!(after.quadrant, before.quadrant, "象限不许被碰");
        assert_eq!(after.reminder_at, before.reminder_at);
        assert_eq!(after.repeat, before.repeat);
        assert_eq!(after.repeat_from, before.repeat_from);
        assert_eq!(after.created_at, before.created_at);
        assert_eq!(after.source.kind, TodoSourceKind::Info);
        assert_eq!(after.source.info_id.as_deref(), Some("info-9"), "来源不许被碰");
        assert_eq!(after.subtasks.len(), before.subtasks.len());
        // ★ 番茄记录一个不动 —— 整条覆盖就是在这儿出事的
        assert_eq!(after.pomodoros.len(), 1, "番茄记录不许被抹掉");
        assert_eq!(after.pomodoros[0].seconds, 1500);
        assert_eq!(after.pomodoros[0].note, "第一笔");

        // 真的落盘了，不只是改了内存里那份
        let on_disk = list(&store).unwrap().remove(0);
        assert_eq!(on_disk.focus_note, "先关手机；只做这一件事");
        assert_eq!(on_disk.pomodoros.len(), 1);
        assert_eq!(on_disk.planned_at, before.planned_at);
    }

    #[test]
    fn 须知传空串就是清掉_旧文件没这个字段也能读() {
        let store = temp_store("todo-focus-note-clear");
        let todo = create(&store, "写方案".into(), TodoSource::default(), None).unwrap();
        set_focus_note(&store, &todo.id, "先关手机").unwrap();

        let cleared = set_focus_note(&store, &todo.id, "").unwrap();
        assert_eq!(cleared.focus_note, "");
        assert_eq!(list(&store).unwrap()[0].focus_note, "", "清掉要真的落盘");

        // 纯空白也算"没写"：前端按 `focusNote !== ''` 判断有没有须知，
        // 留一串看不见的空格会让它以为"写了"
        let blank = set_focus_note(&store, &todo.id, "   \n  ").unwrap();
        assert_eq!(blank.focus_note, "");

        // 清掉之后还能再写（不是"清空就锁死"）；首尾空白顺手去掉
        let again = set_focus_note(&store, &todo.id, " 别忘了喝水 ").unwrap();
        assert_eq!(again.focus_note, "别忘了喝水");

        // 旧文件（M13-C 之前写的、没有 focusNote 字段）要照读成空串
        let store2 = temp_store("todo-old-no-focus-note");
        let path = todos_path(&store2);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic::atomic_write_str(
            &path,
            r#"{"items":[{"id":"t1","title":"老待办","order":0,"status":"open",
                 "source":{"kind":"manual"},"pomodoros":[],"createdAt":"2026-09-01T00:00:00.000+08:00"}]}"#,
        )
        .unwrap();
        let items = list(&store2).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].focus_note, "", "缺字段 → 空串（老数据照读）");

        // 老数据也能就地写上须知
        let wrote = set_focus_note(&store2, "t1", "从今天开始写").unwrap();
        assert_eq!(wrote.focus_note, "从今天开始写");
        assert_eq!(wrote.title, "老待办", "写须知不许动老数据的标题");
    }

    /// v1.15.0：**这条待办自己的番茄时长** —— 设上有值、清掉回 None、越界拒收。
    ///
    /// 用户拍板的语义（B）：每条待办各设各的；没设就跟随设置里的全局值。
    /// 这里盯的是"数据层不许出现脏值"：0 和 1000 都不许落盘（界面上 0/空另有含义 = 跟随设置）。
    #[test]
    fn 番茄时长_能设能清_越界拒收() {
        let store = temp_store("todo-custom-minutes");
        let todo = create(&store, "背单词".into(), TodoSource::default(), None).unwrap();
        assert_eq!(todo.custom_minutes, None, "新建的待办默认跟随设置");

        let set = set_custom_minutes(&store, &todo.id, Some(45)).unwrap();
        assert_eq!(set.custom_minutes, Some(45));
        assert_eq!(list(&store).unwrap()[0].custom_minutes, Some(45), "真落盘了");

        // 清掉 → 恢复跟随全局
        let cleared = set_custom_minutes(&store, &todo.id, None).unwrap();
        assert_eq!(cleared.custom_minutes, None);

        // 越界一律拒收，而且**不许改动**现有值
        let _ = set_custom_minutes(&store, &todo.id, Some(45)).unwrap();
        assert!(set_custom_minutes(&store, &todo.id, Some(0)).is_err(), "0 不是合法时长");
        assert!(set_custom_minutes(&store, &todo.id, Some(1000)).is_err(), "超过 999 不合法");
        assert_eq!(
            list(&store).unwrap()[0].custom_minutes,
            Some(45),
            "拒收之后原值必须原样还在"
        );
    }

    /// v1.15.0：没设过的待办，`todos.json` 里**连这个键都不该有**（不写 `null`）。
    ///
    /// 老规矩（`TodoSource` 那几个 `Option` 也是这么办的）：宁可缺键，也不写 `null` ——
    /// 写了 `null` 等于给"以后想做迁移/对比"的人留一堆噪音。
    #[test]
    fn 番茄时长_没设过就不写这个键() {
        let store = temp_store("todo-custom-minutes-absent");
        let todo = create(&store, "写作业".into(), TodoSource::default(), None).unwrap();
        let raw = std::fs::read_to_string(todos_path(&store)).unwrap();
        assert!(
            !raw.contains("customMinutes"),
            "没设过的待办不该在文件里出现 customMinutes：{raw}"
        );

        // 设了才出现，清掉又消失
        set_custom_minutes(&store, &todo.id, Some(15)).unwrap();
        let raw2 = std::fs::read_to_string(todos_path(&store)).unwrap();
        assert!(raw2.contains("\"customMinutes\": 15"), "设过之后要写进去：{raw2}");
        set_custom_minutes(&store, &todo.id, None).unwrap();
        let raw3 = std::fs::read_to_string(todos_path(&store)).unwrap();
        assert!(!raw3.contains("customMinutes"), "清掉之后键也要消失：{raw3}");
    }

    /// v1.15.0：老 `todos.json`（没有这个字段）照读成 `None`，也能就地设上。
    #[test]
    fn 番茄时长_老数据照读也能设() {
        let store = temp_store("todo-custom-minutes-old");
        let path = todos_path(&store);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        atomic::atomic_write_str(
            &path,
            r#"{"items":[{"id":"t9","title":"老待办","order":0,"status":"open",
                 "source":{"kind":"manual"},"pomodoros":[],"createdAt":"2026-09-01T00:00:00.000+08:00"}]}"#,
        )
        .unwrap();
        let items = list(&store).unwrap();
        assert_eq!(items[0].custom_minutes, None, "缺字段 → None（跟随设置）");
        let set = set_custom_minutes(&store, "t9", Some(30)).unwrap();
        assert_eq!(set.custom_minutes, Some(30));
        assert_eq!(set.title, "老待办", "设时长不许动老数据的标题");
    }
}

/// M21（v2.11.0）：**"最后改动时间"与删除记录**的专项测试。
///
/// 为什么单开一个模块：这一批测的是"**每个写路径都刷新了 `updatedAt`**"这件容易漏的事 ——
/// 漏一处的后果是"那条改动在同步时被判成旧的、被对面静默盖掉"，光看代码看不出来。
///
/// 手法：先把某条待办的 `updatedAt` 改成一个**远古时间**（`stale`），再做那个动作，
/// 然后断言它**变了** —— 这样不依赖 `now_iso()` 的精度（同秒内也能验出来）。
#[cfg(test)]
mod m21_tests {
    use super::*;
    use crate::store::sync;
    use crate::store::temp_store;

    const ANCIENT: &str = "2000-01-01T00:00:00+08:00";

    /// 把一条待办的 updatedAt 改成远古时间（直接改文件，绕过所有业务逻辑）
    fn stale(store: &Store, id: &str) {
        let mut file = load(store).unwrap();
        let one = file.items.iter_mut().find(|one| one.id == id).unwrap();
        one.updated_at = ANCIENT.to_string();
        save(store, &file).unwrap();
    }

    fn updated(store: &Store, id: &str) -> String {
        load(store)
            .unwrap()
            .items
            .into_iter()
            .find(|one| one.id == id)
            .map(|one| one.updated_at)
            .unwrap_or_default()
    }

    fn fresh(store: &Store, title: &str) -> String {
        create(store, title.to_string(), TodoSource::default(), None).unwrap().id
    }

    #[test]
    fn m21_新建时最后改动时间就是创建时间() {
        let store = temp_store("m21-create");
        let one = create(&store, "写点东西".into(), TodoSource::default(), None).unwrap();
        assert!(!one.updated_at.trim().is_empty(), "新建必须有最后改动时间");
        assert_eq!(one.updated_at, one.created_at, "新建时两者应当一致");
    }

    #[test]
    fn m21_改标题会刷新最后改动时间() {
        let store = temp_store("m21-title");
        let id = fresh(&store, "原标题");
        stale(&store, &id);
        set_title(&store, &id, "新标题".into()).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT, "改标题必须刷新");
    }

    #[test]
    fn m21_标完成会刷新最后改动时间() {
        let store = temp_store("m21-done");
        let id = fresh(&store, "做完它");
        stale(&store, &id);
        set_done(&store, &id, true).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
        assert_eq!(updated(&store, &id), load(&store).unwrap().items[0].updated_at);
    }

    #[test]
    fn m21_取消完成也会刷新最后改动时间() {
        let store = temp_store("m21-undone");
        let id = fresh(&store, "来回勾");
        set_done(&store, &id, true).unwrap();
        stale(&store, &id);
        set_done(&store, &id, false).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_分组会刷新最后改动时间() {
        let store = temp_store("m21-group");
        let id = fresh(&store, "进组");
        stale(&store, &id);
        set_group(&store, &id, "学业".into()).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_须知会刷新最后改动时间() {
        let store = temp_store("m21-note");
        let id = fresh(&store, "写须知");
        stale(&store, &id);
        set_focus_note(&store, &id, "只做这一件").unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_番茄时长会刷新最后改动时间() {
        let store = temp_store("m21-minutes");
        let id = fresh(&store, "设时长");
        stale(&store, &id);
        set_custom_minutes(&store, &id, Some(45)).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_设定时间会刷新最后改动时间() {
        let store = temp_store("m21-planned");
        let id = fresh(&store, "安排时间");
        stale(&store, &id);
        set_planned_at(&store, &id, Some("2026-10-07T09:00:00+08:00".into())).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_截止日期会刷新最后改动时间() {
        let store = temp_store("m21-due");
        let id = fresh(&store, "定截止");
        stale(&store, &id);
        set_due_at(&store, &id, Some("2026-10-08T18:00:00+08:00".into())).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_象限会刷新最后改动时间() {
        let store = temp_store("m21-quadrant");
        let id = fresh(&store, "进象限");
        stale(&store, &id);
        set_quadrant(&store, &id, Some(crate::models::Quadrant::Q1)).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_子任务增删勾都会刷新最后改动时间() {
        let store = temp_store("m21-subtasks");
        let id = fresh(&store, "拆步骤");

        stale(&store, &id);
        let one = subtask_add(&store, &id, "第一步".into()).unwrap();
        assert_ne!(one.updated_at, ANCIENT, "加子任务要刷新");
        let sub = one.subtasks[0].id.clone();

        stale(&store, &id);
        subtask_toggle(&store, &id, &sub, true).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT, "勾子任务要刷新");

        stale(&store, &id);
        subtask_remove(&store, &id, &sub).unwrap();
        assert_ne!(updated(&store, &id), ANCIENT, "删子任务要刷新");
    }

    #[test]
    fn m21_排序会刷新最后改动时间() {
        let store = temp_store("m21-reorder");
        let a = fresh(&store, "第一");
        let b = fresh(&store, "第二");
        stale(&store, &a);
        stale(&store, &b);
        reorder(&store, &[b.clone(), a.clone()]).unwrap();
        assert_ne!(updated(&store, &a), ANCIENT, "顺序变了要刷新（不然同步过去对面看不见）");
        assert_ne!(updated(&store, &b), ANCIENT);
    }

    #[test]
    fn m21_记番茄会刷新最后改动时间() {
        let store = temp_store("m21-pomodoro");
        let id = fresh(&store, "专注一次");
        stale(&store, &id);
        add_pomodoro(
            &store,
            &id,
            "countdown".into(),
            1500,
            String::new(),
            false,
            crate::models::PomodoroExtra::default(),
        )
        .unwrap();
        assert_ne!(updated(&store, &id), ANCIENT);
    }

    #[test]
    fn m21_重复待办派生出来的下一条也有最后改动时间() {
        let store = temp_store("m21-spawn");
        let id = fresh(&store, "每天背单词");
        set_repeat(&store, &id, Some(crate::models::Repeat::Daily)).unwrap();
        set_planned_at(&store, &id, Some("2026-10-06T08:00:00+08:00".into())).unwrap();
        // ⚠️ `set_done` 内部**已经**给带重复规则的待办派了下一条（这是它的既有行为），
        //    所以这里不能再去手工调 `spawn_next_occurrence`（那个有"派过就别再派"的守卫，会返回 None）。
        set_done(&store, &id, true).unwrap();
        let spawned = load(&store)
            .unwrap()
            .items
            .into_iter()
            .find(|one| one.repeat_from.as_deref() == Some(id.as_str()))
            .expect("勾完带重复规则的待办应当派出一条下一条");
        assert!(!spawned.updated_at.trim().is_empty(), "派出来的下一条也是新记录");
        assert_eq!(spawned.updated_at, spawned.created_at, "新派出来的：最后改动时间 = 创建时间");
    }

    #[test]
    fn m21_来源已移除标记会刷新最后改动时间() {
        let store = temp_store("m21-removed");
        // 造一条来自笔记的待办（note_id 指向一篇不存在的笔记 → 会被判成孤儿）
        let mut file = load(&store).unwrap();
        let mut one = create(&store, "笔记里的待办".into(), TodoSource::default(), None).unwrap();
        one.source.kind = crate::models::TodoSourceKind::Note;
        one.source.note_id = Some("note-gone".into());
        one.updated_at = ANCIENT.into();
        file = load(&store).unwrap();
        let at = file.items.iter().position(|x| x.id == one.id).unwrap();
        file.items[at] = one.clone();
        save(&store, &file).unwrap();

        let touched = mark_orphans_removed(&store).unwrap();
        assert_eq!(touched, 1);
        assert_ne!(updated(&store, &one.id), ANCIENT, "标记也要刷新（它是用户看得见的状态）");
    }

    #[test]
    fn m21_删待办会留下一条删除记录() {
        let store = temp_store("m21-grave-delete");
        let id = fresh(&store, "要删掉");
        assert!(delete(&store, &id).unwrap());
        let graves = sync::list(&store).unwrap();
        assert_eq!(graves.len(), 1, "删一条待办要留一条墓碑");
        assert_eq!(graves[0].id, id);
        assert_eq!(graves[0].kind, "todo");
    }

    #[test]
    fn m21_删不存在的待办不留墓碑() {
        let store = temp_store("m21-grave-none");
        assert!(!delete(&store, "根本没有这条").unwrap());
        assert!(sync::list(&store).unwrap().is_empty(), "没删到东西就别留墓碑");
    }

    #[test]
    fn m21_清理来源已移除的待办会给每条留墓碑() {
        let store = temp_store("m21-grave-purge");
        let mut file = load(&store).unwrap();
        let a = create(&store, "孤儿甲".into(), TodoSource::default(), None).unwrap();
        let b = create(&store, "孤儿乙".into(), TodoSource::default(), None).unwrap();
        let keep = create(&store, "正常的".into(), TodoSource::default(), None).unwrap();
        file = load(&store).unwrap();
        for item in file.items.iter_mut() {
            if item.id == a.id || item.id == b.id {
                item.source.kind = crate::models::TodoSourceKind::Note;
                item.source.note_id = Some("note-gone".into());
                item.source.source_removed = true;
            }
        }
        save(&store, &file).unwrap();

        let removed = purge_removed(&store).unwrap();
        assert_eq!(removed, 2);
        let ids: Vec<String> = sync::list(&store).unwrap().into_iter().map(|one| one.id).collect();
        assert!(ids.contains(&a.id) && ids.contains(&b.id), "清掉的每条都要留墓碑");
        assert!(!ids.contains(&keep.id), "没被清的不该留墓碑");
    }

    #[test]
    fn m21_老数据没有这个字段时用创建时间兜底() {
        let store = temp_store("m21-legacy");
        // 手写一份 M21 之前格式的 todos.json（没有 updatedAt）
        let legacy = r#"{"items":[{"id":"old-1","title":"老待办","order":0,"status":"open","createdAt":"2026-09-01T10:00:00+08:00"}]}"#;
        std::fs::write(todos_path(&store), legacy).unwrap();

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].updated_at, "2026-09-01T10:00:00+08:00", "缺字段 → 用 createdAt 兜底");
    }

    #[test]
    fn m21_只是打开一下不会把兜底值写回文件() {
        let store = temp_store("m21-no-silent-write");
        let legacy = r#"{"items":[{"id":"old-2","title":"老待办","order":0,"status":"open","createdAt":"2026-09-01T10:00:00+08:00"}]}"#;
        std::fs::write(todos_path(&store), legacy).unwrap();
        let before = std::fs::read_to_string(todos_path(&store)).unwrap();

        let _ = list(&store).unwrap();
        let _ = load(&store).unwrap();

        let after = std::fs::read_to_string(todos_path(&store)).unwrap();
        assert_eq!(before, after, "读一遍不该改文件（兜底只在内存里做）");
    }

    #[test]
    fn m21_最后改动时间是驼峰字段且能来回序列化() {
        let store = temp_store("m21-serde");
        let one = create(&store, "序列化".into(), TodoSource::default(), None).unwrap();
        let raw = serde_json::to_string(&one).unwrap();
        assert!(raw.contains("\"updatedAt\""), "落盘必须是 camelCase：{raw}");
        let back: crate::models::Todo = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.updated_at, one.updated_at);
    }
}
/// M21 的"**用真实数据的副本核对**"。
///
/// 为什么要有它：M21 是**唯一动老数据结构**的一步（给待办加 `updatedAt`），
/// 光靠"我自己造的测试数据"不足以让人放心 —— 得拿**用户真实数据的副本**跑一遍，
/// 证明"内容一字不差，只多了新字段"。
///
/// 跑法（由 `tools\m21\run.ps1` 自动做；**副本**，绝不是原件）：
/// ```powershell
/// $env:M21_COPY = 'D:\m21-copy-<时间戳>'
/// cargo test --lib m21_真实数据副本 -- --nocapture
/// ```
/// 没设这个环境变量就**直接跳过**（日常 `cargo test` 不该依赖用户数据）。
#[cfg(test)]
mod m21_real_data {
    use super::*;
    use std::collections::BTreeMap;

    /// 把一条待办的 JSON 摘成"除了 updatedAt 之外的字段"（用于逐条比对）
    fn without_updated(one: &serde_json::Value) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        if let Some(map) = one.as_object() {
            for (key, value) in map {
                if key == "updatedAt" {
                    continue;
                }
                out.insert(key.clone(), serde_json::to_string(value).unwrap_or_default());
            }
        }
        out
    }

    #[test]
    fn m21_真实数据副本只多了最后改动时间() {
        let Ok(copy) = std::env::var("M21_COPY") else {
            eprintln!("（没设 M21_COPY → 跳过真实数据核对）");
            return;
        };
        let todos = std::path::Path::new(&copy).join("todos.json");
        let raw = std::fs::read_to_string(&todos).expect("副本里应该有 todos.json");
        let before: serde_json::Value = serde_json::from_str(&raw).expect("副本要是合法 JSON");

        let store = Store::at(std::path::PathBuf::from(&copy));
        let loaded = load(&store).expect("新代码必须能读出老文件");
        let after = serde_json::to_value(&loaded).unwrap();

        let before_items = before.get("items").and_then(|one| one.as_array()).cloned().unwrap_or_default();
        let after_items = after.get("items").and_then(|one| one.as_array()).cloned().unwrap_or_default();

        println!("  副本路径            : {copy}");
        println!("  待办条数            : 读前 {} / 读后 {}", before_items.len(), after_items.len());
        assert_eq!(before_items.len(), after_items.len(), "条数不许变");

        let mut filled = 0usize;
        let mut already = 0usize;
        for (old, new) in before_items.iter().zip(after_items.iter()) {
            assert_eq!(
                without_updated(old),
                without_updated(new),
                "有字段被改动了（只允许新增 updatedAt）：{}",
                old.get("title").and_then(|v| v.as_str()).unwrap_or("?")
            );
            let got = new.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
            assert!(!got.trim().is_empty(), "updatedAt 必须补上");
            let created = new.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
            if old.get("updatedAt").is_some() {
                // ⚠️ 这一条**本来就有** updatedAt（说明它在 M21 之后被真改过 —— 比如回归套件
                //    勾了完成、改了标题）→ 这时候 `updatedAt != createdAt` 是**正确行为**，
                //    只要求它非空即可。（2026-10-06 修：原来在这儿无条件断言两者相等，
                //    回归期间套件改过数据 → 假红。）
                already += 1;
            } else {
                // 真的老数据（M21 之前写的）→ 兜底值必须等于创建时间
                assert_eq!(got, created, "老数据的兜底值应当等于创建时间");
                filled += 1;
            }
        }
        println!("  新补上的 updatedAt  : {filled} 条（值都等于各自的 createdAt）");
        println!("  本来就有 updatedAt  : {already} 条");
        println!("  ✅ 逐条比对：除 updatedAt 外没有别的字段被改动");

        let after_raw = std::fs::read_to_string(&todos).unwrap();
        assert_eq!(raw, after_raw, "只读一遍不该动用户的文件");
    }
}