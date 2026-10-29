//! 隐藏档案库（M15 · 2026-09-27）
//!
//! # 这个模块负责什么
//! 读写 `<数据目录>/archive.json`（档案条目）+ 搬 `notes/_archive/`（被收纳的笔记文件），
//! **只做原子写**（`store::atomic`）。命令全是**操作式**的：读盘拿最新 → 只改这一处 → 原子写回
//! —— 和 `mottos` / `annotations` / `awards` 一个套路。
//!
//! 这一块收的是"**已经被遗忘、今后必将遗忘**的东西"（用户原话），定位是**收纳性质、
//! 更重要的东西**：平时没有入口，只有设置里「启用档案区」打开才看得见（`config.archive.enabled`，
//! M14-B 建好、默认 false）。
//!
//! # 存的是"整条快照"，不是"一个标题"（🔴 计划里专门警告过这条）
//! 收进来的东西来源有**三种**，取出时要**逐项复原**回原来的区。只存个标题的话，取回去的
//! 是一条"空壳"：待办的番茄记录 / 子任务、笔记的正文、信息的分类与联动全没了。
//! 所以 [`ArchiveEntry::snapshot`] 存的是**原记录原样的那一份 JSON**
//! （`serde_json::Value`，**不解析成结构体再拼回来**），取出时照它写回原位。
//! `title` / `summary` 只是**从快照里抽出来的投影**（列表不用反序列化），
//! 谁都不许单独手改它们 —— **单一来源是快照**。
//!
//! # 收纳 = 从原位拿走
//! - `info` → 整条存进快照，**并从 `info.jsonl` 里删掉它**；
//! - `todo` → 整条存进快照（含 `pomodoros` / `subtasks` / `order` / `repeat` 等全部字段），
//!   **并从 `todos.json` 里删掉它**；
//! - `note` → **整个文件内容**存进快照，文件**挪到 `notes/_archive/<id>.json`**
//!   （⚠️ 新建这个子目录；**不要**用 `_trash` —— 那是"删除留后路"，语义完全不同：
//!   进 `_trash` 表示"我删了"，进 `_archive` 表示"我收起来了，随时要拿回来"）。
//!   它原来的 `.bak` 也一起挪。
//!
//! # 顺序：先记下来，再从原位拿走
//! [`put`] 与 [`restore`] 都是"**两边都写**"的操作，所以每一步的先后顺序是有讲究的
//! （和 `backup::import` 那条"先留后路再动手"一个道理）：
//! - `put`：① 先把快照写进 `archive.json`，② 才从原位拿掉 —— 反过来万一第 ② 步之后写盘失败，
//!   这条东西就**两头都没有了**；
//! - `restore`：① 先放回原来的区，② 才从 `archive.json` 里删掉。
//!
//! 宁可出现"两边各有一份"（看得见、能收拾），也不要出现"哪都没有"（真丢了）。
//!
//! # 档案里的东西**能直接改**（用户 2026-09-27 拍板，连笔记正文都能改）
//! ⚠️ **不能**走 `info_update` / `todo_*` 那些命令：它们动的是**原区的文件**，
//! 而这条已经在档案库里了（原区早没它了）。所以就地改的两条路都在这里：
//! [`patch_snapshot`]（快照字段 patch）与 [`save_archived_note`]（笔记的标题 + 正文）。
//!
//! # 三条要记住的
//! 1. 🔴 **新数据文件已经在两处登记**：`store/backup.rs` 的 `ENTRIES`（`archive.json`；
//!    `notes/_archive/` 跟着 `notes/` 一起进备份，**故意不在 `ENTRIES` 里再列一次** ——
//!    列了就会把同一批文件在 zip 里打两遍）与 `store/mod.rs` 的 `DATA_ENTRIES`
//!    （换数据目录要带上）。**漏一个就出事。**
//! 2. **档案条目的 `id` 就是原记录的 id**：同一条东西只有一个 id，"还是那一条"；
//!    收纳 / 取出 / 改名都按它找（也顺手挡住了"同一条被收两次"）。
//! 3. `title` / `summary` 是**算出来的**，不是改出来的；[`set`] 改标题时是把它**写进快照**，
//!    再由快照重算回来。

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

use crate::models::{now_iso, ArchiveEntry, ArchiveFile, Info, Todo};
use crate::store::{atomic, info, note, safety, todo, Store};

/// 档案库数据文件名
pub const ARCHIVE_FILE: &str = "archive.json";
/// 被收纳的笔记放哪：`notes/_archive/`（⚠️ **不是** `_trash`）
pub const ARCHIVE_DIR: &str = "_archive";

/// 来源：信息区
const KIND_INFO: &str = "info";
/// 来源：认知区笔记
const KIND_NOTE: &str = "note";
/// 来源：执行区待办
const KIND_TODO: &str = "todo";
/// **自由档案**（2026-10-11 用户反馈第 2 条 · v2.21.0）：
///
/// 用户原话：「打开档案区后，没有创建档案的选项」＋（我问他时）「**两个方案都要有**」
/// —— 既要能从别处收进来（`put`，三种来源），也要能**直接在档案库里新建一条**。
///
/// 这条东西**没有"原位"**：它不是任何原记录的投影，id 是新 uuid、快照就 `{title, content}`
/// 两个键（正好落在 `title_of` / `summary_of` 的兜底分支上，所以那两个函数一个字没动）。
/// ⇒ **取不出来**（[`restore`] 里显式拦一道），只能写 / 改 / 删。
pub const KIND_FREE: &str = "free";

/// 摘要最多留几个字（列表上就一行，长了会把行撑坏）
const SUMMARY_MAX: usize = 60;

/// `<数据目录>/archive.json`
fn path(store: &Store) -> PathBuf {
    store.data_dir().join(ARCHIVE_FILE)
}

/// `<数据目录>/notes/_archive`（收纳笔记的地方，**不是** `_trash`）
fn archive_dir(store: &Store) -> PathBuf {
    note::notes_dir(store).join(ARCHIVE_DIR)
}

/// `<数据目录>/notes/_archive/<id>.json`
fn archived_note_path(store: &Store, id: &str) -> PathBuf {
    archive_dir(store).join(format!("{id}.json"))
}

pub fn load(store: &Store) -> Result<ArchiveFile, String> {
    Ok(atomic::read_json::<ArchiveFile>(&path(store))?.unwrap_or_default())
}

pub fn save(store: &Store, file: &ArchiveFile) -> Result<(), String> {
    atomic::atomic_write_json(&path(store), file)
}

/// 档案条目还在、`notes/_archive/<id>.json` 却不见时，拿快照补回来。
///
/// 同步、旧版本 bug、手工挪动都可能让文件缺失；`archive.json` 里的快照是完整
/// 原记录，所以这个修复不会造假数据，也不会覆盖仍然存在的文件。
pub fn repair_missing_note_files(store: &Store) -> Result<usize, String> {
    let file = load(store)?;
    let dir = archive_dir(store);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建档案目录失败（{}）：{e}", dir.display()))?;
    let mut repaired = 0;
    for entry in file.items.iter().filter(|one| one.kind == KIND_NOTE) {
        let target = archived_note_path(store, &entry.id);
        if target.is_file() {
            continue;
        }
        atomic::atomic_write_json(&target, &entry.snapshot)?;
        repaired += 1;
    }
    Ok(repaired)
}

/// 全部档案（**原样按文件顺序** = 收纳顺序；怎么摆、怎么搜是界面的事）
pub fn list(store: &Store) -> Result<Vec<ArchiveEntry>, String> {
    Ok(load(store)?.items)
}

// ─────────────────────────── 标题 / 摘要：都从快照里算 ───────────────────────────

/// 快照里的一个字符串字段（没有 / 不是字符串 → 空串；顺手去首尾空白）
fn str_field(snapshot: &Value, key: &str) -> String {
    snapshot
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 一段文字的**首行**（摘要用）；整段都是空白 → 空串。太长的截断（一行放不下那么多）
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|one| !one.is_empty())
        .unwrap_or("");
    let chars: Vec<char> = line.chars().collect();
    if chars.len() > SUMMARY_MAX {
        format!("{}…", chars[..SUMMARY_MAX].iter().collect::<String>())
    } else {
        line.to_string()
    }
}

/// 列表上那一行标题。**快照是单一来源**，标题只是它的投影：
/// 快照里有非空的 `title` 就用它（笔记 / 待办本来就有这个字段），没有就从内容里取首行。
fn title_of(kind: &str, snapshot: &Value) -> String {
    let explicit = str_field(snapshot, "title");
    if !explicit.is_empty() {
        return explicit;
    }
    match kind {
        KIND_INFO => {
            let line = first_line(&str_field(snapshot, "text"));
            if !line.is_empty() {
                line
            } else if snapshot.get("assetPath").and_then(Value::as_str).is_some() {
                // 图片信息可以没有文字（正文空着，只有一张图）
                "[图片]".to_string()
            } else {
                "(没有内容)".to_string()
            }
        }
        KIND_TODO => "未命名待办".to_string(),
        _ => "未命名笔记".to_string(),
    }
}

/// 一行摘要（信息取正文首行、待办取象限/状态、笔记取首行）
fn summary_of(kind: &str, snapshot: &Value) -> String {
    match kind {
        KIND_INFO => {
            let line = first_line(&str_field(snapshot, "text"));
            if line.is_empty() && snapshot.get("assetPath").and_then(Value::as_str).is_some() {
                "[图片]".to_string()
            } else {
                line
            }
        }
        KIND_TODO => todo_summary(snapshot),
        _ => {
            let line = first_line(&str_field(snapshot, "content"));
            if line.is_empty() && str_field(snapshot, "kind") == "tree" {
                "树状图笔记".to_string()
            } else {
                line
            }
        }
    }
}

/// 待办的一行摘要：`重要且紧急 · 未完成`
///
/// ⚠️ 象限的中文名与前端 `features/todos/time.ts::QUADRANT_LABEL` **是一对**
/// （和 `marker.rs` ↔ `markers.ts` 一样的镜像约定）：**改一边就要改另一边**。
fn todo_summary(snapshot: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    match str_field(snapshot, "quadrant").as_str() {
        "q1" => parts.push("重要且紧急".to_string()),
        "q2" => parts.push("不重要但紧急".to_string()),
        "q3" => parts.push("重要但不急".to_string()),
        "q4" => parts.push("都不".to_string()),
        _ => {}
    }
    parts.push(
        if str_field(snapshot, "status") == "done" {
            "已完成"
        } else {
            "未完成"
        }
        .to_string(),
    );
    parts.join(" · ")
}

/// 记上"用户手工改过这条待办的名字"（M11 前置的规矩：**名字从此归用户**）。
///
/// 和 `todo::patch` 里那一段是同一件事：不记这一笔的话，取出执行区之后，
/// 下一次笔记保存触发的 `sync_markers` 会拿笔记里的 `-[]文字` 把用户改的名字**覆盖回去**。
/// （待办在档案库里时不在 `todos.json` 里，`sync_markers` 根本看不到它，所以只在改动那一刻留痕。）
fn mark_todo_renamed(snapshot: &mut Value) {
    if let Some(source) = snapshot.get_mut("source").and_then(Value::as_object_mut) {
        source.insert("renamed".to_string(), Value::Bool(true));
    }
}

// ─────────────────────────── 收纳 / 取出 ───────────────────────────

/// 收纳一条：`kind` 决定从哪读原记录（`info.jsonl` / `notes/<id>.json` / `todos.json`）。
///
/// 顺序见模块头那段"先记下来，再从原位拿走"。
/// `note` 是**你自己给这条档案写的一句话**（可空）。
///
/// 返回收进去的那条（`id` 就是原记录的 id）。
pub fn put(store: &Store, kind: &str, source_id: &str, note: &str) -> Result<ArchiveEntry, String> {
    let kind = kind.trim();
    let source_id = source_id.trim();
    if source_id.is_empty() {
        return Err("不知道要收哪一条（缺 id）".to_string());
    }
    if !matches!(kind, KIND_INFO | KIND_NOTE | KIND_TODO) {
        return Err(format!("不认识的来源：{kind}（只有 info / note / todo）"));
    }

    let mut file = load(store)?;
    if let Some(existing) = file.items.iter().find(|one| one.id == source_id) {
        return Err(format!("这一条已经在档案库里了：{}", existing.title));
    }

    // ① 只看不动：把整条原记录读成快照
    let snapshot = snapshot_of(store, kind, source_id)?;
    let entry = ArchiveEntry {
        id: source_id.to_string(),
        kind: kind.to_string(),
        title: title_of(kind, &snapshot),
        summary: summary_of(kind, &snapshot),
        snapshot,
        archived_at: now_iso(),
        updated_at: now_iso(),
        note: note.trim().to_string(),
    };

    // ② 先把快照写进档案（**留下了才拿走**）
    file.items.push(entry.clone());
    save(store, &file)?;

    // ③ 再从原位拿走
    if let Err(error) = take_away(store, kind, source_id) {
        // 收纳失败就当没发生：把刚写进去的那条撤回来。
        // 不撤的话同一条东西会在两个地方各有一份，用户会以为"收进去了"，其实原位还在。
        file.items.retain(|one| one.id != source_id);
        return match save(store, &file) {
            Ok(()) => Err(error),
            Err(back) => Err(format!(
                "{error}；而且它已经记进档案库了（撤回失败：{back}），请到档案库里删掉多出来的那条"
            )),
        };
    }
    Ok(entry)
}

/// 把原记录整条读成快照（**只看不动**）
fn snapshot_of(store: &Store, kind: &str, source_id: &str) -> Result<Value, String> {
    match kind {
        KIND_INFO => {
            let items = info::read_all(store)?;
            let one = items
                .iter()
                .find(|one| one.id == source_id)
                .ok_or_else(|| format!("信息区里没有这一条：{source_id}"))?;
            serde_json::to_value(one).map_err(|e| format!("信息快照序列化失败：{e}"))
        }
        KIND_TODO => {
            let file = todo::load(store)?;
            let one = file
                .items
                .iter()
                .find(|one| one.id == source_id)
                .ok_or_else(|| format!("执行区里没有这一条待办：{source_id}"))?;
            serde_json::to_value(one).map_err(|e| format!("待办快照序列化失败：{e}"))
        }
        // 笔记存的是**整个文件的内容**（原样的那一份 JSON，不解析成结构体再拼回来）
        KIND_NOTE => {
            let raw = atomic::read_to_string(&note::note_path(store, source_id))
                .map_err(|e| format!("读笔记失败：{e}"))?
                .ok_or_else(|| format!("笔记不存在（连上一版也没有）：{source_id}"))?;
            serde_json::from_str::<Value>(&raw)
                .map_err(|e| format!("笔记文件读不动（{source_id}）：{e}"))
        }
        other => Err(format!("不认识的来源：{other}")),
    }
}

/// 从原位拿走（`put` 的第 ③ 步）。每一步都**重新读盘拿最新的**，只把这一条滤掉。
fn take_away(store: &Store, kind: &str, source_id: &str) -> Result<(), String> {
    match kind {
        KIND_INFO => {
            let mut items = info::read_all(store)?;
            let before = items.len();
            items.retain(|one| one.id != source_id);
            if items.len() == before {
                return Err(format!("信息区里没有这一条：{source_id}"));
            }
            info::write_all(store, &items)
        }
        KIND_TODO => {
            let mut file = todo::load(store)?;
            let before = file.items.len();
            file.items.retain(|one| one.id != source_id);
            if file.items.len() == before {
                return Err(format!("执行区里没有这一条待办：{source_id}"));
            }
            todo::save(store, &file)
        }
        KIND_NOTE => move_note_into_archive(store, source_id),
        other => Err(format!("不认识的来源：{other}")),
    }
}

/// 把 `notes/<id>.json`（连同它的 `.bak`）挪到 `notes/_archive/`
fn move_note_into_archive(store: &Store, id: &str) -> Result<(), String> {
    let dir = archive_dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建档案目录失败（{}）：{e}", dir.display()))?;

    let source = note::note_path(store, id);
    let mut moved = false;
    for (from, name) in [
        (source.clone(), format!("{id}.json")),
        (atomic::bak_path(&source), format!("{id}.json.bak")),
    ] {
        if !from.is_file() {
            continue;
        }
        let to = dir.join(&name);
        if to.exists() {
            // `archive.json` 里没有这一条的条目（上面查过），所以这是个孤儿文件 —— 直接换掉它。
            // ⚠️ 不能用加 uuid 后缀那招（`note::delete` 挪回收站是那么干的）：
            //    取出时要按 `<id>.json` 这个名字找回来。
            fs::remove_file(&to)
                .map_err(|e| format!("清掉档案目录里的旧文件失败（{}）：{e}", to.display()))?;
        }
        fs::rename(&from, &to).map_err(|e| {
            format!(
                "挪到档案目录失败（{} → {}）：{e}",
                from.display(),
                to.display()
            )
        })?;
        moved = true;
    }
    if !moved {
        return Err(format!("笔记不存在（连上一版也没有）：{id}"));
    }
    Ok(())
}

/// 取出：把快照写回原来的区（**原 id 与时间原样保留** —— "还是那一条"，不是新的一条），
/// 然后把这条例从 `archive.json` 里删掉。
///
/// 顺序与 [`put`] 对称：**先放回原位，再从档案里删**（反过来的话，放回失败就两头都没有了）。
pub fn restore(store: &Store, id: &str) -> Result<ArchiveEntry, String> {
    let mut file = load(store)?;
    let at = file
        .items
        .iter()
        .position(|one| one.id == id)
        .ok_or_else(|| format!("档案库里没有这一条：{id}"))?;
    let entry = file.items[at].clone();

    match entry.kind.as_str() {
        KIND_INFO => {
            let one: Info = serde_json::from_value(entry.snapshot.clone())
                .map_err(|e| format!("档案里的信息快照读不动（{}）：{e}", entry.id))?;
            let mut items = info::read_all(store)?;
            if items.iter().any(|old| old.id == one.id) {
                return Err(format!(
                    "信息区里已经有这一条了（{}），先处理掉那条再取回",
                    one.id
                ));
            }
            // 追加到文件末尾：信息列表按 `createdAt` 倒序显示，位置由时间决定（时间原样保留）
            items.push(one);
            info::write_all(store, &items)?;
        }
        KIND_TODO => {
            let one: Todo = serde_json::from_value(entry.snapshot.clone())
                .map_err(|e| format!("档案里的待办快照读不动（{}）：{e}", entry.id))?;
            let mut todos = todo::load(store)?;
            if todos.items.iter().any(|old| old.id == one.id) {
                return Err(format!(
                    "执行区里已经有这一条待办了（{}），先处理掉那条再取回",
                    one.id
                ));
            }
            todos.items.push(one);
            todo::save(store, &todos)?;
        }
        KIND_NOTE => put_note_back(store, &entry)?,
        // 自由档案没有原位可回（它就是在这儿生的）—— 说清楚，别让用户以为是坏了
        KIND_FREE => {
            return Err(
                "这条是**自由档案**（直接在档案库里新建的），没有原来的区可以放回去 —— \
                 想留着就留着，想清掉就点「删除」"
                    .to_string(),
            )
        }
        other => return Err(format!("这条档案的来源不认识了：{other}（拿不出来）")),
    }

    // 放回原位了 → 才从档案库里删掉。
    // （`at` 是上面查的下标；中间只动过别的文件，没动 `file` 自己）
    file.items.remove(at);
    save(store, &file)?;
    Ok(entry)
}

/// 把笔记从 `notes/_archive/` 挪回 `notes/`（连同 `.bak`）
fn put_note_back(store: &Store, entry: &ArchiveEntry) -> Result<(), String> {
    let target = note::note_path(store, &entry.id);
    if target.is_file() || atomic::bak_path(&target).is_file() {
        return Err(format!(
            "notes 里已经有这一篇了（{}），先处理掉那篇再取回",
            entry.id
        ));
    }

    let from = archived_note_path(store, &entry.id);
    if from.is_file() {
        let dir = note::notes_dir(store);
        fs::create_dir_all(&dir).map_err(|e| format!("创建笔记目录失败（{}）：{e}", dir.display()))?;
        fs::rename(&from, &target).map_err(|e| {
            format!(
                "从档案目录挪回笔记失败（{} → {}）：{e}",
                from.display(),
                target.display()
            )
        })?;
        let from_bak = atomic::bak_path(&from);
        if from_bak.is_file() {
            fs::rename(&from_bak, atomic::bak_path(&target))
                .map_err(|e| format!("挪回笔记的上一版失败：{e}"))?;
        }
        return Ok(());
    }

    // 档案目录里那个文件不见了（被手工挪走 / 删掉）→ **拿快照把这一篇写回来**。
    // 不这么兜的话这条档案就永远取不出来了，而快照里装的正是当初整个文件的内容。
    atomic::atomic_write_json(&target, &entry.snapshot)
}

// ─────────────────────────── 就地改（用户 2026-09-27 拍板：档案里能直接改） ───────────────────────────

/// 改档案里那条的**备注**与**标题**。`None` = 不传就不动；备注传**空串 = 清掉**那一格。
///
/// ⚠️ 标题是**写进快照**（`snapshot.title`）再从快照重算回来的 —— 快照是单一来源，
/// 只改显示用的那一格的话，取出之后名字又变回去了。分两种情况：
/// - 笔记 / 待办本来就有 `title` 字段 → 写进去，取出后名字就是新的；
/// - 信息没有这个键 → 它在写回 `info.jsonl` 时会被 `Info` 丢掉了，
///   也就是说**信息改标题只影响它在档案库里怎么显示**（想改信息的正文请用 [`patch_snapshot`]）。
///
/// 待办改名还会顺手记上"用户改过名"（见 [`mark_todo_renamed`]）。
pub fn set(
    store: &Store,
    id: &str,
    note: Option<String>,
    title: Option<String>,
) -> Result<ArchiveEntry, String> {
    let mut file = load(store)?;
    let entry = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的那条档案不存在：{id}"))?;

    if let Some(value) = note {
        entry.note = value.trim().to_string();
    }
    if let Some(value) = title {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err("档案的标题不能改空（想清掉就写回原来的内容）".to_string());
        }
        let wrote = match entry.snapshot.as_object_mut() {
            Some(object) => {
                object.insert("title".to_string(), Value::String(value.clone()));
                true
            }
            None => false,
        };
        if wrote {
            if entry.kind == KIND_TODO {
                mark_todo_renamed(&mut entry.snapshot);
            }
            entry.title = title_of(&entry.kind, &entry.snapshot);
        } else {
            // 快照不是对象（老数据 / 脏数据）：退一步，只改档案里显示的那一格
            entry.title = value;
        }
    }
    entry.updated_at = now_iso();

    let done = entry.clone();
    save(store, &file)?;
    Ok(done)
}

/// 新建一条**自由档案**（`kind = free`）：标题 + 正文，**id 是新 uuid**。
///
/// 2026-10-11（v2.21.0 · 用户反馈第 2 条「两个方案都要有」）：档案区原来只能"从别处收进来"，
/// 没有"直接新建"这个门。这条命令补的就是它 —— 建出来的东西**只活在 `archive.json` 里**，
/// 没有原位、取不出来（[`restore`] 会拦住并说明），但能就地改（[`patch_snapshot`]）与删。
///
/// ⚠️ `title` / `summary` 照旧**只从快照算**（单一来源），不单独手写：
/// 快照形状固定是 `{ "title": …, "content": … }`，标题空着就兜底成「未命名档案」。
pub fn create(store: &Store, title: &str, content: &str) -> Result<ArchiveEntry, String> {
    let clean = title.trim();
    let snapshot = serde_json::json!({
        "title": if clean.is_empty() { "未命名档案" } else { clean },
        "content": content,
    });
    let entry = ArchiveEntry {
        id: uuid::Uuid::new_v4().to_string(),
        kind: KIND_FREE.to_string(),
        title: title_of(KIND_FREE, &snapshot),
        summary: summary_of(KIND_FREE, &snapshot),
        snapshot,
        archived_at: now_iso(),
        updated_at: now_iso(),
        note: String::new(),
    };
    let mut file = load(store)?;
    file.items.push(entry.clone());
    save(store, &file)?;
    Ok(entry)
}

/// 就地改档案里那条的内容：`patch` 是**快照里的字段 patch**，只改传进来的键，**别的键一个不动**。
///
/// 为什么不能复用原区的命令：`info_update` / `todo_*` 动的是**原区的文件**，
/// 而这条东西已经不在原区了（收纳 = 从原位拿走）。
///
/// 改完 `title` / `summary` 跟着新快照**重算**（单一来源是快照）。
/// ⚠️ 笔记这条档案有**两份**（`archive.json` 里的快照 + `notes/_archive/` 里的文件），
/// 所以两边一起写：只改快照不改文件的话，改半天一取出全变回去了
/// ——"同一个事实两个来源迟早对不上"（M11-A 那条教训）。
/// 顺序是**先写文件、再写 `archive.json`**：文件写不动就中止，两边都还是老的，不会半新半旧。
pub fn patch_snapshot(store: &Store, id: &str, patch: Value) -> Result<ArchiveEntry, String> {
    let patch = patch
        .as_object()
        .ok_or_else(|| "patch 得是一个对象（要改的字段）".to_string())?
        .clone();

    let mut file = load(store)?;
    let entry = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的那条档案不存在：{id}"))?;

    if !patch.is_empty() {
        {
            let object = entry
                .snapshot
                .as_object_mut()
                .ok_or_else(|| format!("这条档案的快照不是一个对象，改不了（id={id}）"))?;
            for (key, value) in &patch {
                object.insert(key.clone(), value.clone());
            }
        }
        // 改了标题 → 照 `todo::patch` 的规矩给"用户改过名"留痕
        if entry.kind == KIND_TODO && patch.contains_key("title") {
            mark_todo_renamed(&mut entry.snapshot);
        }
        entry.updated_at = now_iso();
    }

    entry.title = title_of(&entry.kind, &entry.snapshot);
    entry.summary = summary_of(&entry.kind, &entry.snapshot);
    sync_archived_note_file(store, entry)?;

    let done = entry.clone();
    save(store, &file)?;
    Ok(done)
}

/// 档案里那篇笔记的标题 / 正文保存（写回 `notes/_archive/<id>.json`）。
///
/// ⚠️ **以磁盘上那个文件为准**（它才是这篇笔记的全部字段：`root` / `group` / `sourceInfoIds` …），
/// 只覆盖 `title` / `content` / `updatedAt` 三个键 —— 树状图笔记的树、分组、联动一个都不动。
/// 正文**一个字都不改**（用户手写的，照原样存）。
/// 标题空着跟 `note::save` 一个待遇：兜底成「未命名笔记」。
pub fn save_archived_note(
    store: &Store,
    id: &str,
    title: String,
    content: String,
) -> Result<ArchiveEntry, String> {
    let mut file = load(store)?;
    let entry = file
        .items
        .iter_mut()
        .find(|one| one.id == id)
        .ok_or_else(|| format!("要改的那条档案不存在：{id}"))?;
    if entry.kind != KIND_NOTE {
        return Err(format!(
            "这条档案不是笔记（{}），改内容请用 archive_patch",
            entry.kind
        ));
    }

    // 磁盘上那份才是"笔记的全部字段"；它不在（或读不动）就退回快照
    let path = archived_note_path(store, id);
    let mut value = match atomic::read_json::<Value>(&path)? {
        Some(value) => value,
        None => entry.snapshot.clone(),
    };

    let title = title.trim();
    let title = if title.is_empty() {
        "未命名笔记".to_string()
    } else {
        title.to_string()
    };
    {
        let object = value
            .as_object_mut()
            .ok_or_else(|| format!("这篇笔记的内容不是一个对象，改不了（{id}）"))?;
        object.insert("title".to_string(), Value::String(title));
        object.insert("content".to_string(), Value::String(content));
        // 真改过就盖一次时间（照 `note::save` 的规矩）；`createdAt` 与 id 一个字不动
        object.insert("updatedAt".to_string(), Value::String(now_iso()));
    }

    let dir = archive_dir(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建档案目录失败（{}）：{e}", dir.display()))?;
    atomic::atomic_write_json(&path, &value)?;

    entry.snapshot = value;
    entry.title = title_of(KIND_NOTE, &entry.snapshot);
    entry.summary = summary_of(KIND_NOTE, &entry.snapshot);
    entry.updated_at = now_iso();

    let done = entry.clone();
    save(store, &file)?;
    Ok(done)
}

/// 把快照原样写回 `notes/_archive/<id>.json`（笔记这条档案在磁盘上的那一份）。
///
/// 文件不在（被手工挪走 / 删掉）就只改 `archive.json` 里那份 —— 那种情况下
/// 取出时会拿快照把这一篇写回来（见 [`put_note_back`]），不会丢东西。
fn sync_archived_note_file(store: &Store, entry: &ArchiveEntry) -> Result<(), String> {
    if entry.kind != KIND_NOTE {
        return Ok(());
    }
    let path = archived_note_path(store, &entry.id);
    if !path.is_file() {
        return Ok(());
    }
    atomic::atomic_write_json(&path, &entry.snapshot)
}

// ─────────────────────────── 删 ───────────────────────────

/// 删一条（**真删**）：照 V1 的规矩**先留档再删**（`safety`），**留档失败就中止**。
///
/// ⚠️ 笔记来源的还会把 `notes/_archive/` 里那份**一起清掉**：条目都没了，留个孤儿文件
/// 只会在磁盘上攒垃圾、还会被备份白白带走。内容在留档里（留档存的是这条档案的完整 JSON，
/// 含整条快照），想捞随时捞得回来。
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let mut file = load(store)?;
    let at = file
        .items
        .iter()
        .position(|one| one.id == id)
        .ok_or_else(|| format!("要删的那条档案不存在：{id}"))?;
    let gone = file.items[at].clone();
    let raw = serde_json::to_string_pretty(&gone).map_err(|e| format!("序列化失败：{e}"))?;
    safety::archive(store, "档案-删除前", "", &raw)?;
    file.items.remove(at);
    save(store, &file)?;
    // M21：档案条目真删也要留删除记录（kind 用**它原本的种类**：todo / note / info）
    if let Err(e) = crate::store::sync::bury(store, id, &gone.kind) {
        eprintln!("[东方摩耶堂] 删除记录没写成功（{id}）：{e}");
    }

    if gone.kind == KIND_NOTE {
        let path = archived_note_path(store, id);
        for one in [path.clone(), atomic::bak_path(&path)] {
            if one.is_file() {
                // 清不掉不影响"这条档案已经删了"这个事实，但要留痕，别无声无息
                if let Err(e) = fs::remove_file(&one) {
                    eprintln!(
                        "[东方摩耶堂] 档案里的笔记文件没清掉（{}）：{e}",
                        one.display()
                    );
                }
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{InfoKind, PomodoroExtra, Quadrant, Repeat};
    use crate::store::temp_store;

    /// 造一条像模像样的信息（分类 + 一段多行正文）
    fn seed_info(store: &Store) -> Info {
        info::create(
            store,
            InfoKind::Text,
            "今天想到的一件事\n第二行也是正文".to_string(),
            vec!["主动冒出·突然想起".to_string()],
            None,
        )
        .unwrap()
    }

    /// 造一篇带正文的笔记
    fn seed_note(store: &Store, content: &str) -> crate::models::Note {
        note::create_with_content(
            store,
            crate::models::NoteKind::Doc,
            "归档前的那篇".to_string(),
            content.to_string(),
        )
        .unwrap()
        .0
    }

    #[test]
    fn 收一条信息_快照字段齐_原位真的没了() {
        let store = temp_store("archive-put-info");
        let one = seed_info(&store);

        let entry = put(&store, "info", &one.id, "  先收着  ").unwrap();
        assert_eq!(entry.kind, "info");
        assert_eq!(entry.id, one.id, "★ 档案条目的 id 就是原记录的 id");
        assert_eq!(entry.title, "今天想到的一件事", "标题取正文首行");
        assert_eq!(entry.summary, "今天想到的一件事");
        assert_eq!(entry.note, "先收着", "备注去首尾空白");
        assert!(entry.archived_at.contains('T'), "收纳时间得盖章：{}", entry.archived_at);

        // 快照字段齐 —— 取出时要逐项复原，少一个都不行
        let snap = entry.snapshot.as_object().expect("快照该是个对象");
        assert_eq!(snap["id"], one.id);
        assert_eq!(snap["text"], "今天想到的一件事\n第二行也是正文");
        assert_eq!(snap["kind"], "text");
        assert_eq!(snap["createdAt"], one.created_at);
        assert_eq!(snap["categories"][0], "主动冒出·突然想起");
        assert_eq!(snap["status"], "pending");
        assert!(snap["links"].is_array(), "联动字段也得在快照里");

        // ★ 收纳 = 从原位拿走
        assert!(
            info::read_all(&store).unwrap().iter().all(|old| old.id != one.id),
            "★ 收纳之后 info.jsonl 里真的不该有它了"
        );
        assert_eq!(list(&store).unwrap().len(), 1, "档案里该有这一条");

        // 同一条不许收两次；来源 / id 不对都要给明白话
        assert!(put(&store, "info", &one.id, "").is_err(), "已经在档案里了");
        assert!(put(&store, "什么鬼", &one.id, "").is_err(), "不认识的来源");
        assert!(put(&store, "info", "不存在的 id", "").is_err());
        assert!(put(&store, "info", "  ", "").is_err(), "缺 id 也得拒");
    }

    #[test]
    fn 取回信息区_原id与时间原样_档案里没了() {
        let store = temp_store("archive-restore-info");
        let one = seed_info(&store);
        let entry = put(&store, "info", &one.id, "先收着").unwrap();

        let back = restore(&store, &entry.id).unwrap();
        assert_eq!(back.id, one.id);

        let all = info::read_all(&store).unwrap();
        assert_eq!(all.len(), 1, "★ 取回来了");
        let now = &all[0];
        assert_eq!(now.id, one.id, "★ 原 id 原样（还是那一条，不是新的一条）");
        assert_eq!(now.created_at, one.created_at, "★ 原时间原样");
        assert_eq!(now.text, one.text);
        assert_eq!(now.categories, one.categories);
        assert_eq!(now.kind, one.kind);
        assert_eq!(now.status, one.status);
        assert_eq!(now.links.len(), one.links.len());

        assert!(list(&store).unwrap().is_empty(), "取出之后档案里就不该有它了");

        // 取出过的 id 再取一次 → 明白话，不是 panic
        assert!(restore(&store, &entry.id).is_err());
        // 取回之后再收一次，照样能收（原位又有了）
        assert!(put(&store, "info", &one.id, "").is_ok());
    }

    #[test]
    fn 收放一条待办_番茄记录与子任务一个不少() {
        let store = temp_store("archive-put-todo");
        let one = todo::create(&store, "把这件事做完".to_string(), Default::default(), None).unwrap();

        // 把它弄成"真用过的一条"：子任务 / 番茄 / 象限 / 设定时间 / 重复 / 顺序
        todo::subtask_add(&store, &one.id, "第一步".to_string()).unwrap();
        let with_two = todo::subtask_add(&store, &one.id, "第二步".to_string()).unwrap();
        let second_id = with_two.subtasks[1].id.clone();
        todo::subtask_toggle(&store, &one.id, &second_id, true).unwrap();
        todo::add_pomodoro(
            &store,
            &one.id,
            "countdown".to_string(),
            1500,
            "第一笔".to_string(),
            false,
            PomodoroExtra::default(),
        )
        .unwrap();
        todo::set_quadrant(&store, &one.id, Some(Quadrant::Q1)).unwrap();
        todo::set_planned_at(&store, &one.id, Some("2026-09-27T09:00:00+08:00".to_string())).unwrap();
        todo::set_repeat(&store, &one.id, Some(Repeat::Weekly)).unwrap();
        let before = todo::list(&store)
            .unwrap()
            .into_iter()
            .find(|item| item.id == one.id)
            .unwrap();

        let entry = put(&store, "todo", &one.id, "先搁这儿").unwrap();
        assert_eq!(entry.title, "把这件事做完");
        assert_eq!(entry.summary, "重要且紧急 · 未完成", "摘要取象限 + 状态");
        let snap = &entry.snapshot;
        assert_eq!(snap["pomodoros"].as_array().unwrap().len(), 1, "★ 番茄记录进快照");
        assert_eq!(snap["pomodoros"][0]["seconds"].as_u64(), Some(1500));
        assert_eq!(snap["pomodoros"][0]["note"], "第一笔");
        assert_eq!(snap["subtasks"].as_array().unwrap().len(), 2, "★ 子任务一个不少");
        assert_eq!(snap["subtasks"][1]["text"], "第二步");
        assert_eq!(snap["subtasks"][1]["done"], true);
        assert_eq!(snap["quadrant"], "q1");
        assert_eq!(snap["repeat"], "weekly");
        assert_eq!(snap["plannedAt"], before.planned_at.clone().unwrap());
        assert_eq!(snap["order"], before.order, "★ 拖动顺序也得存（取出后位置不变）");
        assert_eq!(snap["createdAt"], before.created_at);

        // ★ 原位（todos.json）里真的没了
        assert!(
            todo::list(&store).unwrap().iter().all(|item| item.id != one.id),
            "★ 收纳之后 todos.json 里不该有它了"
        );

        restore(&store, &entry.id).unwrap();
        let after = todo::list(&store)
            .unwrap()
            .into_iter()
            .find(|item| item.id == one.id)
            .expect("取回来了");
        assert_eq!(after.created_at, before.created_at, "★ 原时间原样");
        assert_eq!(after.order, before.order);
        assert_eq!(after.planned_at, before.planned_at);
        assert_eq!(after.quadrant, Some(Quadrant::Q1));
        assert_eq!(after.repeat, Some(Repeat::Weekly));
        assert_eq!(after.pomodoros.len(), 1, "★ 番茄记录一个不少");
        assert_eq!(after.pomodoros[0].seconds, 1500);
        assert_eq!(after.pomodoros[0].note, "第一笔");
        assert_eq!(after.subtasks.len(), 2, "★ 子任务一个不少");
        assert_eq!(after.subtasks[1].text, "第二步");
        assert!(after.subtasks[1].done, "子任务的勾也得还在");
        assert_eq!(after.title, "把这件事做完");
        assert!(list(&store).unwrap().is_empty(), "取出之后档案里就没它了");
    }

    #[test]
    fn 笔记_收进_archive_目录_取出正文逐字相同() {
        let store = temp_store("archive-put-note");
        // 正文里故意放 `-[]`、中文标点、行尾空格：取出必须**逐字**相同
        let content = "# 标题\n\n-[]买牛奶\n\n第二段：标点，句号。  \n";
        let one = seed_note(&store, content);

        let entry = put(&store, "note", &one.id, "先收着").unwrap();
        assert_eq!(entry.title, "归档前的那篇");
        assert_eq!(entry.summary, "# 标题", "摘要取正文首行");
        assert_eq!(entry.snapshot["content"], content, "★ 正文原样进快照");
        assert_eq!(entry.snapshot["id"], one.id);
        assert_eq!(entry.snapshot["createdAt"], one.created_at);

        let archived = archived_note_path(&store, &one.id);
        assert!(archived.is_file(), "★ 笔记文件该搬到 notes/_archive/：{}", archived.display());
        assert!(
            !note::note_path(&store, &one.id).is_file(),
            "★ 原位 notes/ 里不该还留着它"
        );
        assert!(
            note::list(&store).unwrap().iter().all(|item| item.id != one.id),
            "认知区列表里也看不到了"
        );

        // 取出：文件回到 notes/，正文逐字相同
        restore(&store, &entry.id).unwrap();
        assert!(note::note_path(&store, &one.id).is_file(), "★ 回原位了");
        assert!(!archived.is_file(), "★ 档案目录里那份不该留成孤儿");
        let back = note::get(&store, &one.id).unwrap().expect("取回来了");
        assert_eq!(back.content, content, "★ 正文逐字相同");
        assert_eq!(back.title, "归档前的那篇");
        assert_eq!(back.created_at, one.created_at, "★ 原时间原样");
        assert!(list(&store).unwrap().is_empty(), "取出之后档案里就没它了");

        // 笔记不存在 → 收纳要给明白话
        assert!(put(&store, "note", "根本没有这篇", "").is_err());
    }

    #[test]
    fn patch_只改传进来的键_别的键一个不动() {
        let store = temp_store("archive-patch");
        let one = todo::create(&store, "原来的名字".to_string(), Default::default(), None).unwrap();
        todo::set_quadrant(&store, &one.id, Some(Quadrant::Q3)).unwrap();
        todo::subtask_add(&store, &one.id, "别动我".to_string()).unwrap();
        let entry = put(&store, "todo", &one.id, "").unwrap();
        let before = entry.snapshot.as_object().unwrap().clone();

        // 只改标题
        let after = patch_snapshot(&store, &entry.id, serde_json::json!({ "title": "改过的名字" }))
            .unwrap();
        let now = after.snapshot.as_object().unwrap();
        assert_eq!(now["title"], "改过的名字");
        assert_eq!(after.title, "改过的名字", "★ 标题跟着新快照重算");
        for (key, value) in &before {
            // `title` 是这次**要改**的那个键；`source` 单独看（改待办名字要留一笔"用户改过名"）
            if key == "title" || key == "source" {
                continue;
            }
            assert_eq!(&now[key], value, "★ 没传的键一个都不许动：{key}");
        }
        // `source` 只该多一个"用户改过名"的记号（见 `mark_todo_renamed`），别的键原样
        let before_source = before["source"].as_object().unwrap();
        let now_source = now["source"].as_object().unwrap();
        assert_eq!(before_source["renamed"], false);
        assert_eq!(now_source["renamed"], true, "★ 在档案里改过名也要留痕（取回后不被覆盖回去）");
        for (key, value) in before_source {
            if key == "renamed" {
                continue;
            }
            assert_eq!(&now_source[key], value, "★ source 里别的键也不许动：{key}");
        }

        // 加一个快照里原本没有的键 + 改一个数组字段
        let after = patch_snapshot(
            &store,
            &entry.id,
            serde_json::json!({ "focusNote": "新加的须知", "quadrant": "q2" }),
        )
        .unwrap();
        assert_eq!(after.snapshot["focusNote"], "新加的须知");
        assert_eq!(after.snapshot["quadrant"], "q2");
        assert_eq!(after.summary, "不重要但紧急 · 未完成", "摘要也跟着重算");
        assert_eq!(after.snapshot["subtasks"].as_array().unwrap().len(), 1, "别的还是原样");
        assert_eq!(list(&store).unwrap()[0].snapshot["title"], "改过的名字", "改动确实落了盘");

        // patch 不是对象 / id 不存在 → 明白话
        assert!(patch_snapshot(&store, &entry.id, serde_json::json!("我不是对象")).is_err());
        assert!(patch_snapshot(&store, "不存在的 id", serde_json::json!({})).is_err());
    }

    #[test]
    fn 档案里改笔记正文_写回_archive_目录_快照跟着更新() {
        let store = temp_store("archive-note-save");
        let one = seed_note(&store, "老正文\n第二行");
        note::set_group(&store, &one.id, "密码学".to_string()).unwrap();
        let entry = put(&store, "note", &one.id, "先收着").unwrap();

        let after = save_archived_note(
            &store,
            &entry.id,
            "  改过的标题  ".to_string(),
            "新正文\n第二行也改了".to_string(),
        )
        .unwrap();
        assert_eq!(after.title, "改过的标题", "标题去首尾空白");
        assert_eq!(after.summary, "新正文");
        assert_eq!(after.snapshot["content"], "新正文\n第二行也改了");
        assert_eq!(after.snapshot["title"], "改过的标题");

        // ★ 磁盘上那份也真的改了（不然一取出全变回去）
        let on_disk: Value = atomic::read_json(&archived_note_path(&store, &one.id))
            .unwrap()
            .expect("档案目录里那份该在");
        assert_eq!(on_disk["content"], "新正文\n第二行也改了");
        assert_eq!(on_disk["title"], "改过的标题");
        assert_eq!(on_disk["id"], one.id);
        assert_eq!(on_disk["createdAt"], one.created_at, "★ 创建时间一个字不动");
        assert_eq!(on_disk["group"], "密码学", "★ 别的字段（分组）原样");
        assert!(on_disk["updatedAt"].as_str().unwrap().contains('T'), "真改过就盖一次时间");

        // 取出之后认知区看到的就该是改过的那份
        restore(&store, &after.id).unwrap();
        let back = note::get(&store, &one.id).unwrap().unwrap();
        assert_eq!(back.content, "新正文\n第二行也改了");
        assert_eq!(back.title, "改过的标题");
        assert_eq!(back.group, "密码学");

        // 标题空着 → 兜底成「未命名笔记」（和 note::save 一个待遇）
        let another = seed_note(&store, "另一篇");
        let entry2 = put(&store, "note", &another.id, "").unwrap();
        let blank = save_archived_note(&store, &entry2.id, "   ".to_string(), "正文".to_string()).unwrap();
        assert_eq!(blank.title, "未命名笔记");

        // 不是笔记的那些条目不许走这条路
        let info_one = seed_info(&store);
        let entry3 = put(&store, "info", &info_one.id, "").unwrap();
        assert!(save_archived_note(&store, &entry3.id, "标题".to_string(), "正文".to_string()).is_err());
        assert!(save_archived_note(&store, "不存在的 id", "标题".to_string(), "".to_string()).is_err());
    }

    #[test]
    fn 删一条_先留档_笔记文件一起清掉() {
        let store = temp_store("archive-delete");
        let one = seed_info(&store);
        let keep = seed_info(&store);
        let entry = put(&store, "info", &one.id, "").unwrap();
        put(&store, "info", &keep.id, "").unwrap();

        assert!(delete(&store, &entry.id).unwrap());
        let left = list(&store).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, keep.id, "★ 只删了指定的那条");

        let archives: Vec<String> = std::fs::read_dir(store.data_dir().join("backups"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("档案-删除前"))
            .collect();
        assert_eq!(archives.len(), 1, "真删之前必须留档：{archives:?}");
        let raw = std::fs::read_to_string(store.data_dir().join("backups").join(&archives[0])).unwrap();
        assert!(raw.contains("今天想到的一件事"), "留档里得有被删的那条：{raw}");
        assert!(raw.contains("主动冒出·突然想起"), "★ 留的是整条快照，不是光一个标题");

        // 笔记来源的：条目删了，notes/_archive/ 里那份也不该留成孤儿
        let note_one = seed_note(&store, "会被删掉的那篇");
        let note_entry = put(&store, "note", &note_one.id, "").unwrap();
        let archived = archived_note_path(&store, &note_one.id);
        assert!(archived.is_file());
        assert!(delete(&store, &note_entry.id).unwrap());
        assert!(!archived.is_file(), "★ 条目没了，文件也别留着");
        assert!(!note::note_path(&store, &note_one.id).is_file(), "★ 原位当然也没有");

        assert!(delete(&store, "不存在的 id").is_err(), "删不存在的要给个明白话");
    }

    #[test]
    fn 自由档案能新建能改但取不出来() {
        // 2026-10-11（v2.21.0 · 用户反馈第 2 条）：档案区要有"直接新建"这个门
        let store = temp_store("archive-free");
        let made = create(&store, "  一段随想  ", "第一行\n第二行").unwrap();
        assert_eq!(made.kind, KIND_FREE);
        assert_eq!(made.title, "一段随想", "标题要去首尾空白");
        assert_eq!(made.summary, "第一行", "摘要取正文首行");
        assert!(!made.id.is_empty(), "id 要是新生成的");
        assert_eq!(list(&store).unwrap().len(), 1, "落盘了");

        // 改标题 + 正文：走同一套 patch（自由档案的快照形状就是 { title, content }）
        let edited = patch_snapshot(
            &store,
            &made.id,
            serde_json::json!({ "title": "改过的标题", "content": "换了一行" }),
        )
        .unwrap();
        assert_eq!(edited.title, "改过的标题");
        assert_eq!(edited.summary, "换了一行");
        assert_eq!(list(&store).unwrap()[0].title, "改过的标题", "改动落了盘");

        // 🔴 没有原位 → 取不出来，而且**要给一句能看懂的话**（不是"来源不认识"）
        let err = restore(&store, &made.id).unwrap_err();
        assert!(err.contains("自由档案"), "错误里要说清是自由档案：{err}");

        // 标题空着 → 兜底成「未命名档案」（别在列表上留个空白行）
        let blank = create(&store, "   ", "").unwrap();
        assert_eq!(blank.title, "未命名档案");

        // 删的时候照样先留档（跟别的来源一条规矩）
        assert!(delete(&store, &made.id).unwrap());
        assert_eq!(list(&store).unwrap().len(), 1, "只删掉点名那条");
    }

    #[test]
    fn 旧文件缺字段也能读() {
        let store = temp_store("archive-legacy");
        // 手写一份"早期版本"：只有 id / kind，别的字段一个都没有
        let raw = r#"{"items":[{"id":"old-1","kind":"info"}]}"#;
        std::fs::write(path(&store), raw).unwrap();

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "old-1");
        assert_eq!(items[0].kind, "info");
        assert!(items[0].title.is_empty(), "缺的字段走默认");
        assert!(items[0].summary.is_empty());
        assert!(items[0].note.is_empty());
        assert!(items[0].archived_at.is_empty());
        assert_eq!(items[0].snapshot, Value::Null, "缺字段的快照是 Null");

        // 缺字段的老条目照样能改备注 / 标题（快照不是对象时退一步只改显示那一格）
        let fixed = set(&store, "old-1", Some("老档案".to_string()), Some("新标题".to_string())).unwrap();
        assert_eq!(fixed.note, "老档案");
        assert_eq!(fixed.title, "新标题");
        assert_eq!(list(&store).unwrap()[0].note, "老档案", "改动确实落了盘");

        // 但它的快照是空的 → 取出来要报明白话，不许 panic、也不许悄悄放个空壳回去
        let err = restore(&store, "old-1").unwrap_err();
        assert!(err.contains("快照"), "要指出是快照读不动：{err}");
        assert_eq!(list(&store).unwrap().len(), 1, "★ 取不出来就留在档案里，不许弄丢");

        // 备注传空串 = 清掉；标题传空串 = 拒绝
        let cleared = set(&store, "old-1", Some("   ".to_string()), None).unwrap();
        assert!(cleared.note.is_empty());
        assert_eq!(cleared.title, "新标题", "没传 title 就不许动它");
        assert!(set(&store, "old-1", None, Some("   ".to_string())).is_err());
        assert!(set(&store, "不存在的 id", None, None).is_err());

        // 完全空的文件也能读（第一次用）
        let empty = temp_store("archive-legacy-empty");
        assert!(list(&empty).unwrap().is_empty());
    }
}
