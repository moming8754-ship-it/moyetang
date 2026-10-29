//! 认知笔记：一条一个文件 `notes/<id>.json`。
//!
//! 为什么要一条一个文件（而不是一个大 json）：笔记会长、会频繁改，
//! 一条一个文件坏掉只坏一条，而且天然就是原子的（走 [`atomic`] 覆盖写）。
//!
//! M2 做了「建笔记 + 把联动信息写进去」；M3 补上编辑器要用的两块：
//! 保存时把正文里的 `-[]文字` 同步成待办（[`sync_markers`]）、勾选状态写回
//! （[`set_marker_checked`]）。树状图的完整交互在 M4。

use crate::models::{
    now_iso, title_from_text, Info, Note, NoteKind, Todo, TodoSource, TodoSourceKind, TodoStatus,
    TreeNode,
};
use crate::store::{atomic, todo, Store};
use std::fs;
use std::path::PathBuf;

/// 笔记目录名
pub const NOTES_DIR: &str = "notes";
/// 回收站目录名（删除的笔记挪到这里，不硬删）
pub const TRASH_DIR: &str = "_trash";

/// `<数据目录>/notes`
pub fn notes_dir(store: &Store) -> PathBuf {
    store.data_dir().join(NOTES_DIR)
}

/// `<数据目录>/notes/<id>.json`
pub fn note_path(store: &Store, id: &str) -> PathBuf {
    notes_dir(store).join(format!("{id}.json"))
}

/// 笔记列表：**最近改过的在前**
pub fn list(store: &Store) -> Result<Vec<Note>, String> {
    let dir = notes_dir(store);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut notes = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取笔记目录失败（{}）：{e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取笔记目录失败：{e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match atomic::read_json::<Note>(&path)? {
            Some(note) => notes.push(note),
            None => continue,
        }
    }

    notes.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.cmp(&b.title))
    });
    Ok(notes)
}

/// 取一条笔记
pub fn get(store: &Store, id: &str) -> Result<Option<Note>, String> {
    if id.trim().is_empty() {
        return Err("缺少笔记 id".to_string());
    }
    atomic::read_json(&note_path(store, id))
}

/// 新建笔记
pub fn create(store: &Store, kind: NoteKind, title: String) -> Result<Note, String> {
    let title = title.trim().to_string();
    let title = if title.is_empty() {
        "未命名笔记".to_string()
    } else {
        title
    };
    let note = Note::new(kind, title);
    save(store, &note)?;
    Ok(note)
}

/// 新建一篇**带正文**的笔记，并且**顺手把 `-[]` 标记同步成待办**。
///
/// 存在的理由（两个都是真踩出来的）：
/// 1. **别让前端拆成"先 create 再 save"**：`note_create` 会广播 `data-changed`，
///    认知区会先看到一篇**空正文**的笔记 —— 小窗保存时用户就报过"保存后只有标题没正文"；
/// 2. **别漏掉 `sync_markers`**：正文里可能就有 `-[]` 标记（在小窗里随手写一条待办太正常了），
///    只写盘不同步的话待办不会生成 —— 2026-09-21 的 m7.1 验收就是用这条路造数据，结果 0 条。
///
/// 返回（存好的笔记, 同步报告），调用方按 `sync.changed()` 决定要不要广播。
pub fn create_with_content(
    store: &Store,
    kind: NoteKind,
    title: String,
    content: String,
) -> Result<(Note, MarkerSync), String> {
    let created = create(store, kind, title)?;
    let saved = if content.is_empty() {
        created
    } else {
        let mut next = created;
        next.content = content;
        save(store, &next)?
    };
    let sync = sync_markers(store, &saved)?;
    Ok((saved, sync))
}

/// 保存笔记（`updatedAt` 由后端盖章）
pub fn save(store: &Store, note: &Note) -> Result<Note, String> {
    if note.id.trim().is_empty() {
        return Err("缺少笔记 id，无法保存".to_string());
    }

    let mut next = note.clone();
    next.updated_at = now_iso();
    if next.title.trim().is_empty() {
        next.title = "未命名笔记".to_string();
    }
    // 新建时可能没盖创建时间（前端造的对象）→ 补上
    if next.created_at.trim().is_empty() {
        next.created_at = next.updated_at.clone();
    }

    atomic::atomic_write_json(&note_path(store, &next.id), &next)?;
    Ok(next)
}

/// 只改标题：`note_title_set`
///
/// 为什么不复用 [`save`]（整篇覆盖）：树笔记会被后端自己改（[`link_info`] 往根节点下
/// 加联动节点），前端握着一份旧 Note 整篇写回会把那个节点抹掉。
/// 标题只是一个字段，单独改就完全避开了这条竞态。
///
/// **文本笔记仍然走 `note_save`**（M3 已验收的行为不动）。
pub fn set_title(store: &Store, id: &str, title: String) -> Result<Note, String> {
    let mut note = get(store, id)?.ok_or_else(|| format!("笔记不存在：{id}"))?;
    let title = title.trim().to_string();
    // 空标题交给 `save` 里的兜底（会变成"未命名笔记"），保持与新建时一致
    note.title = title;
    save(store, &note)
}

/// 只改"分组名"：`note_set_group`（M8 方案 A）
///
/// 分组就是**一个字符串**（空串 = 未分组）—— 用户拍板选了方案 A（分组+折叠），
/// 不做文件夹树。
///
/// 和 [`set_title`] 一样的道理：**只改这一个字段**，读盘拿最新、写回，
/// 绝不整篇覆盖（树笔记会被后端自己改，整篇写回会抹掉别人刚加的东西）。
///
/// 名字会 `trim`；超过 24 个字符截断（分组名是一行标签，太长会把左栏撑坏）。
/// 只改「标题 + 正文」：`note_set_text`（2026-10-06 加，P0-1 修）
///
/// # 为什么非要有它（真事故）
/// 手机端认知区原本用 `note_save` 保存，而那是**整篇覆盖**（`save` 里是 `note.clone()`）；
/// 手机手上那份 Note 的 root 是**同步过来的旧副本** —— 只要在手机上打开并保存过电脑侧那篇
/// 树笔记，整篇写回就会把电脑侧**更新过的树节点抹掉**。这正是 `set_title` 注释里写的那条竞态，
/// 电脑版一直用操作式命令避开它，而手机端踩了进去。
///
/// 这里照 `set_title` / `set_group` 的路子：**读盘拿最新 → 只改这两个字段 → 写回**；
/// root / kind / group / sourceInfoIds / createdAt 一个字节都不碰。
pub fn set_text(store: &Store, id: &str, title: String, content: String) -> Result<Note, String> {
    let mut note = get(store, id)?.ok_or_else(|| format!("笔记不存在：{id}"))?;
    note.title = title.trim().to_string();
    note.content = content;
    save(store, &note)
}
pub fn set_group(store: &Store, id: &str, group: String) -> Result<Note, String> {
    let mut note = get(store, id)?.ok_or_else(|| format!("笔记不存在：{id}"))?;
    let group = group.trim();
    let group: String = group.chars().take(24).collect();
    note.group = group;
    save(store, &note)
}

/// 全部用过的分组名（去重、按名字排序）—— 左栏渲染和"移到分组"菜单都要用
pub fn groups(store: &Store) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = list(store)?
        .into_iter()
        .map(|note| note.group.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 删除笔记：不是硬删，而是**移到 `notes/_trash/`**（用户最在意数据不能丢，留个后路）。///
/// ⚠️ 必须连上一版 `.bak` 一起挪走：`atomic::read_to_string` 在"正式文件不存在"时
/// 会拿 `.bak` 救回来（那是为了防止写坏），如果只挪走正式文件，下次 `get()` 就会
/// 把删掉的笔记又"复活"出来。
pub fn delete(store: &Store, id: &str) -> Result<bool, String> {
    let path = note_path(store, id);
    let bak = atomic::bak_path(&path);
    if !path.is_file() && !bak.is_file() {
        return Ok(false);
    }

    let trash = notes_dir(store).join(TRASH_DIR);
    fs::create_dir_all(&trash)
        .map_err(|e| format!("创建回收站目录失败（{}）：{e}", trash.display()))?;

    let mut moved = false;
    for (from, name) in [
        (path.clone(), format!("{id}.json")),
        (bak.clone(), format!("{id}.json.bak")),
    ] {
        if !from.is_file() {
            continue;
        }
        let mut to = trash.join(&name);
        if to.exists() {
            // 回收站里已有同名（以前删过一次）→ 加个 uuid 后缀，绝不覆盖
            to = trash.join(format!("{name}.{}", uuid::Uuid::new_v4()));
        }
        fs::rename(&from, &to).map_err(|e| {
            format!(
                "挪到回收站失败（{} → {}）：{e}",
                from.display(),
                to.display()
            )
        })?;
        moved = true;
    }
    // M21（《同步协议》§5.3）：删笔记（挪进回收站）也要留删除记录 —— 语义是"用户删了它"，
    // 对面不该因为文件还在 _trash 里就把这篇又传回来。
    if moved {
        if let Err(e) = crate::store::sync::bury(store, id, "note") {
            eprintln!("[东方摩耶堂] 删除记录没写成功（{id}）：{e}");
        }
    }
    Ok(moved)
}

/// 清空回收站（`notes/_trash/`），返回删掉的文件个数（M7）
///
/// 回收站是"删除留后路"的产物，平时只会越堆越多 —— 给用户一个明确的清理入口。
/// ⚠️ 这是**唯一真删笔记的地方**，所以：
/// - 由界面上的二次确认兜着（用户明确点了才走到这儿）；
/// - **删之前把回收站里每个文件的原文存一份到 `backups/`**
///   （`回收站-清空前-<时间>-N个文件.json`，只留最近 20 份）——
///   二次确认挡的是"手滑"，挡不了"确认完就后悔"；
/// - 只删**文件**，不递归删子目录（回收站里本来只该有被挪进来的笔记文件）。
///
/// 备份（`backup::export`）**不含**回收站，所以清掉它不影响任何已有备份。
pub fn purge_trash(store: &Store) -> Result<usize, String> {
    let trash = notes_dir(store).join(TRASH_DIR);
    if !trash.is_dir() {
        return Ok(0);
    }

    // 先**只看不动**：把要删的文件列出来、内容读进内存
    let mut doomed: Vec<(std::path::PathBuf, String)> = Vec::new();
    let entries = fs::read_dir(&trash)
        .map_err(|e| format!("读取回收站失败（{}）：{e}", trash.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取回收站失败：{e}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // 笔记文件是 JSON，正常都是 UTF-8；万一有读不动的字节，用 lossy 也要留一份
        // （宁可留一份"大体对"的，也不要因为它不是 UTF-8 就整批不留档）
        let text = fs::read(&path)
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_else(|e| format!("（这个文件读不动：{e}）"));
        let name = path
            .file_name()
            .map(|one| one.to_string_lossy().to_string())
            .unwrap_or_else(|| "（名字取不到）".to_string());
        doomed.push((path, format!("【{name}】\n{text}")));
    }
    if doomed.is_empty() {
        return Ok(0);
    }

    // 留档失败就**不删**（宁可不清理，也不冒丢数据的险）
    let files: Vec<(String, String)> = doomed
        .iter()
        .map(|(path, text)| {
            (
                path.file_name()
                    .map(|one| one.to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                text.clone(),
            )
        })
        .collect();
    let label = format!("清空回收站（{} 个文件）", files.len());
    crate::store::safety::archive_many(
        store,
        "回收站-清空前",
        &format!("{}个文件", files.len()),
        &label,
        files,
    )?;

    let mut removed = 0usize;
    for (path, _) in doomed {
        fs::remove_file(&path).map_err(|e| format!("删除失败（{}）：{e}", path.display()))?;
        removed += 1;
    }
    Ok(removed)
}

/// 把一条信息**联动**进笔记（信息区 → 认知区，单向可见）。
///
/// - 文本笔记：正文里追加一段「引用块 + 斜体 + 来源标记」；
/// - 树状图：根节点下加一个子节点（M4 会做完整交互）；
/// - 两种都会把信息 id 记进 `sourceInfoIds`。
///
/// 重复联动同一条信息不会写两遍。
pub fn link_info(store: &Store, note_id: &str, info: &Info) -> Result<Note, String> {
    let mut note = get(store, note_id)?.ok_or_else(|| format!("笔记不存在：{note_id}"))?;

    if note.source_info_ids.iter().any(|id| id == &info.id) {
        return Ok(note); // 幂等：已经联动过就不重复插
    }

    let shown = display_text(info);
    match note.kind {
        NoteKind::Tree => {
            // 节点带上 `sourceInfoId`：画布靠它在卡片上显示「〔联动信息〕」来源标记，
            // 点标记能跳回信息区（M4-6）。信息区那边依然看不到节点文字（单向可见）。
            let mut node = TreeNode::new(shown.clone());
            node.asset_path = info.asset_path.clone();
            node.source_info_id = Some(info.id.clone());
            match note.root.as_mut() {
                Some(root) => root.children.push(node),
                None => {
                    // 坏文件兜底：没有根就补一个（正常流程 `Note::new(Tree)` 已经建过根）
                    let mut root = TreeNode::new("中心主题");
                    root.children.push(node);
                    note.root = Some(root);
                }
            }
        }
        NoteKind::Doc => {
            if !note.content.is_empty() && !note.content.ends_with('\n') {
                note.content.push('\n');
            }
            if !note.content.is_empty() {
                note.content.push('\n');
            }
            note.content.push_str(&format!("> *〔联动信息〕{shown}*\n"));
        }
    }

    note.source_info_ids.push(info.id.clone());
    save(store, &note)
}

/// 信息在笔记里怎么显示（图片类没有正文，用备注兜底）
pub fn display_text(info: &Info) -> String {
    let text = info.text.trim();
    if !text.is_empty() {
        return text.to_string();
    }
    match &info.asset_path {
        Some(path) => format!("（图片）{}", title_from_text(path, 24)),
        None => "（空信息）".to_string(),
    }
}

/// 标记同步的结果（决定要不要广播 `data-changed`，也方便排查）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerSync {
    /// 正文 / 树节点里扫到几条 `-[]` 标记
    pub scanned: usize,
    /// 新生成了几条待办
    pub created: usize,
    /// 有几条待办跟着改了（标题、行号、节点、"来源已移除"的加减都算）
    pub updated: usize,
    /// 有几条被标上「来源已移除」（M5-1）
    pub removed: usize,
}

impl MarkerSync {
    /// 有没有真的动过待办
    pub fn changed(&self) -> bool {
        self.created > 0 || self.updated > 0 || self.removed > 0
    }
}

/// 一条"活着的"标记：正文里的一行，或者树里的一个节点
#[derive(Debug, Clone)]
struct LiveMarker {
    /// 去重键（正文 `noteId#文字`；树 `noteId#nodeId#文字`）
    key: String,
    /// `-[]` 后面的文字
    text: String,
    /// 正文行号（**树节点是 `None`**）
    line: Option<usize>,
    /// 树节点 id（**正文是 `None`**）
    node_id: Option<String>,
}

/// 扫出这篇笔记当前所有活着的标记。
///
/// - **文本笔记**：扫正文的每一行（M3 的行为）；
/// - **树状图**：走整棵树的每一个节点，**含被折叠的**
///   （折叠只是"看不见"，节点和它的文字都还在，标记当然还算数）。
///
/// 树节点文字当成"一行"来判：同样只认行首、`-[]` 后面必须有文字。
fn collect_markers(note: &Note) -> Vec<LiveMarker> {
    match note.kind {
        NoteKind::Doc => crate::marker::scan(&note.id, &note.content)
            .into_iter()
            .map(|one| LiveMarker {
                key: one.key,
                text: one.text,
                line: Some(one.line),
                node_id: None,
            })
            .collect(),
        NoteKind::Tree => {
            let mut found = Vec::new();
            if let Some(root) = &note.root {
                walk_nodes(root, &note.id, &mut found);
            }
            found
        }
    }
}

/// 递归收节点上的标记（前序，父节点在子节点前面）
fn walk_nodes(node: &TreeNode, note_id: &str, out: &mut Vec<LiveMarker>) {
    if let Some(text) = crate::marker::strip_marker(&node.text) {
        out.push(LiveMarker {
            key: crate::marker::node_marker_key(note_id, &node.id, text),
            text: text.to_string(),
            line: None,
            node_id: Some(node.id.clone()),
        });
    }
    for child in &node.children {
        walk_nodes(child, note_id, out);
    }
}

/// 把笔记里的 `-[]文字` 同步成待办（M3-4 做的，M5-1 补完）。
///
/// 规则：
/// - **幂等**：同一条标记只有一条待办（按 `markerKey` 认人），反复保存不会翻倍；
/// - 文字改了 → 待办标题跟着改，**勾选状态不动**；
/// - **标记被删掉 → 待办标「来源已移除」，但绝不删除**（M5-1）：
///   用户很可能已经照着做完了，程序替他删掉等于丢东西。留还是删由他在执行区决定。
/// - **树节点文字也参与**（M5，用户 2026-09-21 拍板）：树里写 `-[]吃饭` 一样生成待办。
///
/// ⚠️ 一个必须知道的坑：**去重键里带着文字**（DEV-PLAN §4.3 定的），
/// 所以「买牛奶」改成「买牛奶和鸡蛋」在键上看起来就是"删一条 + 加一条"。
/// 编辑器是边打字边自动保存的，照字面执行的话，打一句话能生成一串待办
/// （「买」、「买牛」、「买牛奶」…）。所以这里多一条规则：
/// **键没了、但同一行（或同一节点、或老文字是新文字的前缀）的那条待办还在 → 就地改名**，
/// 保证「一行 / 一个节点 = 一条待办」。
///
/// 为什么勾选状态不写回正文（比如把 `-[]` 改成 `-[x]`）：正文是用户手写的东西，
/// 程序不替他改字；状态存在 `todos.json`，`-[]` 那一行永远保持原样。
pub fn sync_markers(store: &Store, note: &Note) -> Result<MarkerSync, String> {
    let mut result = MarkerSync::default();

    let live = collect_markers(note);
    result.scanned = live.len();

    // ⚠️ 这里**故意不早退**（M3 那版是 `if markers.is_empty() { return }`，M5-1 修掉）：
    //    `live` 为空恰恰就是「用户把标记全删光了」的那一刻，
    //    也正是「来源已移除」最该生效的时候。早退等于永久漏标。
    let alive: Vec<&str> = live.iter().map(|one| one.key.as_str()).collect();

    let mut file = todo::load(store)?;
    let mut next_order = file.items.iter().map(|item| item.order).max().unwrap_or(-1) + 1;
    // 本轮已经认领过的待办（一条待办只服务一个标记）
    let mut claimed: Vec<String> = Vec::new();

    for one in &live {
        // 待办标题太长会把列表撑爆；`title_from_text` 顺手把空白压平（跟 key 的归一化一致）
        let title = title_from_text(&one.text, 80);

        // ① 同一条标记（键一样）→ 跟进标题、行号 / 节点
        if let Some(existing) = file
            .items
            .iter_mut()
            .find(|item| item.source.marker_key.as_deref() == Some(one.key.as_str()))
        {
            // ⚠️ `renamed` 的（用户在执行区手工改过名的）**不许覆盖标题** —— 名字归执行区
            //    （M11 前置 2026-09-26，方案①）。链接、行号、节点照旧跟进。
            if existing.title != title && !existing.source.renamed {
                existing.title = title;
                result.updated += 1;
            }
            existing.source.marker_text = Some(one.text.clone());
            existing.source.node_id = one.node_id.clone();
            if existing.source.marker_line != one.line {
                existing.source.marker_line = one.line;
                result.updated += 1;
            }
            // 标记又回来了（用户把那行 / 那个节点改回来了）→ 撤掉「来源已移除」
            if existing.source.source_removed {
                existing.source.source_removed = false;
                result.updated += 1;
            }
            claimed.push(existing.id.clone());
            continue;
        }

        // ② 键没了、但看着就是"同一条被改了" → 就地改名
        //    （勾选状态、番茄钟记录、四象限都留着，只是换个名字）
        let renamed = file.items.iter().position(|item| {
            if item.source.kind != TodoSourceKind::Note {
                return false;
            }
            if item.source.note_id.as_deref() != Some(note.id.as_str()) {
                return false;
            }
            if claimed.contains(&item.id) {
                return false;
            }
            // 键还活着的说明它名花有主，不能抢
            if item
                .source
                .marker_key
                .as_deref()
                .map(|key| alive.contains(&key))
                .unwrap_or(false)
            {
                return false;
            }
            match (&one.node_id, &item.source.node_id) {
                // 树：node_id 是稳定的 —— 同一个节点上的文字改了，一定是它
                //     （树里改文字是"提交那一刻写一次盘"，所以只会来一次，不存在
                //       正文那种边打字边存的一串中间态）
                (Some(want), Some(have)) => want == have,
                // 正文：同一行，或者新文字是老文字的续写（编辑器边打字边存）
                (None, None) => {
                    item.source.marker_line == one.line
                        || looks_like_edit(item.source.marker_text.as_deref().unwrap_or(""), &one.text)
                }
                // 一边是正文的待办、一边是树节点的标记 —— 同一个 noteId 不可能两者兼有
                _ => false,
            }
        });
        if let Some(index) = renamed {
            let item = &mut file.items[index];
            // ⚠️ 改过名的**只续链接、不动名字**（M11 前置 2026-09-26，方案①）：
            //    名字归执行区，但这一条还是笔记那行文字对应的待办 —— 键必须续上，
            //    否则同步会把它当成"新标记"另建一条（重复），并把这条标成来源已移除。
            if !item.source.renamed {
                item.title = title;
            }
            item.source.marker_key = Some(one.key.clone());
            item.source.marker_text = Some(one.text.clone());
            item.source.marker_line = one.line;
            item.source.node_id = one.node_id.clone();
            item.source.source_removed = false;
            claimed.push(item.id.clone());
            result.updated += 1;
            continue;
        }

        // ③ 真·新标记 → 建一条待办
        file.items.push(Todo {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            order: next_order,
            planned_at: None,
            due_at: None,
            status: TodoStatus::Open,
            done_at: None,
            quadrant: None,
            source: TodoSource {
                kind: TodoSourceKind::Note,
                note_id: Some(note.id.clone()),
                marker_key: Some(one.key.clone()),
                marker_text: Some(one.text.clone()),
                marker_line: one.line,
                node_id: one.node_id.clone(),
                info_id: None,
                source_removed: false,
                // 刚从笔记里新建出来的，名字当然还归笔记管
                renamed: false,
            },
            reminder_at: None,
            pomodoros: Vec::new(),
            subtasks: Vec::new(),
            // 笔记标记出来的待办天生不重复；重复规则只能手动设（M9-6）
            repeat: None,
            repeat_from: None,
            // 「须知」（M13-C）不从笔记正文拿：标记那行文字只是标题，
            // 须知是用户在专注小窗 / 番茄钟面板上单独写的
            focus_note: String::new(),
            // 分组（D 批）：从笔记标记建出来的待办一律"未分组"（要进组去执行区点 ⋮）
            group: String::new(),
            // 番茄时长（v1.15.0）：从 `-[]` 标记建出来的待办**跟随设置里的全局值**
            // （笔记正文里没有"这条要做多久"这种信息，不该替用户编一个）
            custom_minutes: None,
            // M21：从笔记标记建出来的待办也是"新记录" → 最后改动时间 = 创建时间
            updated_at: now_iso(),
            created_at: now_iso(),
        });
        next_order += 1;
        result.created += 1;
    }

    // ④ M5-1「来源已移除」：本篇产生的、这一轮没被认领、键也不在正文/树里的待办 → 标上。
    //
    //    ★ **只标，不删，也不改完成状态**：用户很可能已经照着那条标记做完了这件事，
    //      程序顺手删掉就是替他丢东西（这条约定在 `TodoSource::source_removed` 的注释里）。
    //
    //    `marker_key` **故意保留**：万一把那行字加回来，键就又能对上，
    //    「来源已移除」会自动撤掉，还是原来那条待办（带着它的勾选状态和番茄钟）。
    for item in file.items.iter_mut() {
        if item.source.kind != TodoSourceKind::Note {
            continue;
        }
        if item.source.note_id.as_deref() != Some(note.id.as_str()) {
            continue;
        }
        if claimed.contains(&item.id) {
            continue;
        }
        if item
            .source
            .marker_key
            .as_deref()
            .map(|key| alive.contains(&key))
            .unwrap_or(false)
        {
            continue; // 键还在（只是被别的标记认领了），不算移除
        }
        if !item.source.source_removed {
            item.source.source_removed = true;
            result.removed += 1;
        }
    }

    if result.changed() {
        todo::save(store, &file)?;
    }
    Ok(result)
}

/// 老文字与新文字像不像「同一句话被接着改」（一边是另一边的前缀）
///
/// 「买牛奶」→「买牛奶和鸡蛋」在去重键上看着像删一条加一条，但人心里那是同一件事。
fn looks_like_edit(old: &str, new: &str) -> bool {
    let old = crate::marker::normalize(old);
    let new = crate::marker::normalize(new);
    !old.is_empty() && (new.starts_with(&old) || old.starts_with(&new))
}

/// 勾选 / 取消勾选一条标记（PRD 10.3：勾上 → 状态被记录，执行区能看到）。
///
/// 认人用 `key`（前端解析出来的 `markerKey`）；万一对不上，用 `text` 兜底再找一次
/// —— 前端 `markers.ts` 是这里的镜像实现，两边规则一致时不会走到兜底，
/// 但真有出入时也要能点得动，而不是静默失败。
pub fn set_marker_checked(
    store: &Store,
    note_id: &str,
    key: &str,
    text: Option<&str>,
    checked: bool,
) -> Result<Todo, String> {
    let note = get(store, note_id)?.ok_or_else(|| format!("笔记不存在：{note_id}"))?;
    let markers = crate::marker::scan(&note.id, &note.content);

    let target = markers
        .iter()
        .find(|one| one.key == key)
        .or_else(|| {
            let wanted = crate::marker::normalize(text?);
            markers
                .iter()
                .find(|one| crate::marker::normalize(&one.text) == wanted)
        })
        .ok_or_else(|| format!("这篇笔记里找不到这条标记了（可能刚被改掉）：{key}"))?;

    // 先保证待办存在（幂等），再改状态
    sync_markers(store, &note)?;

    let mut file = todo::load(store)?;
    let item = file
        .items
        .iter_mut()
        .find(|item| item.source.marker_key.as_deref() == Some(target.key.as_str()))
        .ok_or_else(|| format!("标记对应的待办没建成：{}", target.key))?;

    if checked {
        item.status = TodoStatus::Done;
        item.done_at = Some(now_iso());
    } else {
        item.status = TodoStatus::Open;
        item.done_at = None;
    }
    let updated = item.clone();
    todo::save(store, &file)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{InfoKind, InfoStatus};
    use crate::store::temp_store;

    fn an_info(id: &str, text: &str) -> Info {
        Info {
            id: id.to_string(),
            kind: InfoKind::Text,
            text: text.to_string(),
            asset_path: None,
            created_at: now_iso(),
            updated_at: now_iso(),
            categories: vec!["主动冒出".into()],
            status: InfoStatus::Pending,
            links: Vec::new(),
        }
    }

    #[test]
    fn 分组只改一个字段_而且旧文件缺字段也能读() {
        // M8 方案 A：`group` 是**后加的字段**，两条底线：
        // ① 老笔记文件里没有它 → 必须还能读出来（serde default）；
        // ② 改分组**绝不能碰别的字段**（标题、正文、联动来源都得原样）。
        let store = temp_store("note-group");
        let note = create(&store, NoteKind::Doc, "分组测试".into()).unwrap();
        let mut with_body = note.clone();
        with_body.content = "正文别动我".to_string();
        with_body.source_info_ids = vec!["info-1".to_string()];
        let saved = save(&store, &with_body).unwrap();
        assert_eq!(saved.group, "", "新建的笔记默认未分组");

        let moved = set_group(&store, &note.id, "  密码学  ".into()).unwrap();
        assert_eq!(moved.group, "密码学", "分组名要 trim");
        let back = get(&store, &note.id).unwrap().unwrap();
        assert_eq!(back.group, "密码学");
        assert_eq!(back.title, "分组测试", "标题不许被碰");
        assert_eq!(back.content, "正文别动我", "正文不许被碰");
        assert_eq!(back.source_info_ids, vec!["info-1".to_string()], "联动来源不许被碰");
        assert_eq!(back.updated_at, moved.updated_at, "更新时间由 save 盖章，读回来要一致");

        // 移出分组 = 传空串
        let out = set_group(&store, &note.id, String::new()).unwrap();
        assert_eq!(out.group, "");

        // 分组名太长要截断（一行标签，别把左栏撑坏）
        let long = set_group(&store, &note.id, "一".repeat(40)).unwrap();
        assert_eq!(long.group.chars().count(), 24, "超长分组名截到 24 个字");

        // 分组名清单：去重、排序、去掉空的
        let store2 = temp_store("note-group-list");
        let a = create(&store2, NoteKind::Doc, "A".into()).unwrap();
        let b = create(&store2, NoteKind::Doc, "B".into()).unwrap();
        let c = create(&store2, NoteKind::Doc, "C".into()).unwrap();
        set_group(&store2, &a.id, "乙".into()).unwrap();
        set_group(&store2, &b.id, "甲".into()).unwrap();
        set_group(&store2, &c.id, "甲".into()).unwrap();
        // 顺序是**按名字的 Unicode 码点**排的（不是拼音，Rust 不做 locale 排序）——
        // 「乙」(U+4E59) 在「甲」(U+7532) 前面。规则简单、**稳定不变**，
        // 想让顺序听自己的就用 `01 密码学` 这种带序号的名字。
        assert_eq!(groups(&store2).unwrap(), vec!["乙".to_string(), "甲".to_string()]);

        // ★ 老文件（完全没有 group 字段）照样读得出来
        let store3 = temp_store("note-group-legacy");
        let legacy = r#"{"id":"old-1","kind":"doc","title":"老笔记","createdAt":"2026-09-01T00:00:00.000+08:00","updatedAt":"2026-09-01T00:00:00.000+08:00","content":"老正文"}"#;
        std::fs::create_dir_all(notes_dir(&store3)).unwrap();
        std::fs::write(note_path(&store3, "old-1"), legacy).unwrap();
        let old = get(&store3, "old-1").unwrap().unwrap();
        assert_eq!(old.title, "老笔记");
        assert_eq!(old.group, "", "缺字段 → 默认未分组");
        assert_eq!(old.content, "老正文");
    }

    #[test]
    fn 新建后能读回来且最近改的在前() {
        let store = temp_store("note-crud");
        let a = create(&store, NoteKind::Doc, "第一条".into()).unwrap();
        let b = create(&store, NoteKind::Doc, "第二条".into()).unwrap();

        let items = list(&store).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, b.id, "最近更新的在前");

        let got = get(&store, &a.id).unwrap().unwrap();
        assert_eq!(got.title, "第一条");
        assert_eq!(got.kind, NoteKind::Doc);
        assert_eq!(got.content, "");
    }

    #[test]
    fn 空标题给个默认名并盖章时间() {
        let store = temp_store("note-title");
        let note = create(&store, NoteKind::Doc, "   ".into()).unwrap();
        assert_eq!(note.title, "未命名笔记");
        assert!(!note.created_at.is_empty());
        assert!(!note.updated_at.is_empty());
    }

    #[test]
    fn 联动信息写进正文并记_source_info_ids() {
        let store = temp_store("note-link");
        let note = create(&store, NoteKind::Doc, "收进来的想法".into()).unwrap();
        let info = an_info("info-1", "突然想到一个点子");

        let linked = link_info(&store, &note.id, &info).unwrap();
        assert!(linked.content.contains("突然想到一个点子"));
        assert!(linked.content.contains('*'), "要有斜体标记");
        assert!(linked.content.trim_start().starts_with('>'), "要有引用块=左边线");
        assert!(linked.content.contains("〔联动信息〕"), "要有来源标记");
        assert_eq!(linked.source_info_ids, vec!["info-1".to_string()]);

        // 重复联动不写两遍
        let again = link_info(&store, &note.id, &info).unwrap();
        assert_eq!(again.content, linked.content);
        assert_eq!(again.source_info_ids.len(), 1);
    }

    #[test]
    fn 联动进树状图会加一个子节点() {
        let store = temp_store("note-tree");
        let note = create(&store, NoteKind::Tree, "知识树".into()).unwrap();
        assert!(note.root.is_some(), "树状图笔记要有根节点");

        let info = an_info("info-2", "一条树节点内容");
        let linked = link_info(&store, &note.id, &info).unwrap();
        let root = linked.root.as_ref().unwrap();
        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].text, "一条树节点内容");
        assert_eq!(linked.source_info_ids, vec!["info-2".to_string()]);

        // M4-6：节点要记住"我是从哪条信息联动进来的"，画布靠它显示来源标记
        assert_eq!(
            root.children[0].source_info_id.as_deref(),
            Some("info-2"),
            "联动节点必须带来源 id"
        );
    }

    #[test]
    fn 旧格式树节点没有来源字段也能读出来() {
        // 「加字段必须带 #[serde(default)]」这条约定的守门测试：
        // M4 之前写下的 notes/*.json 里没有 sourceInfoId，读出来要是 None 而不是报错。
        let store = temp_store("note-tree-legacy");
        let note = create(&store, NoteKind::Tree, "老树".into()).unwrap();
        let legacy = format!(
            r#"{{"id":"{}","kind":"tree","title":"老树","createdAt":"2026-01-01T00:00:00.000+08:00","updatedAt":"2026-01-01T00:00:00.000+08:00","root":{{"id":"r1","text":"中心主题","collapsed":false,"children":[{{"id":"c1","text":"老节点","collapsed":false,"children":[]}}]}}}}"#,
            note.id
        );
        fs::write(note_path(&store, &note.id), legacy).unwrap();

        let got = get(&store, &note.id).unwrap().expect("旧文件要能读出来");
        let child = &got.root.as_ref().unwrap().children[0];
        assert_eq!(child.text, "老节点");
        assert!(child.source_info_id.is_none(), "缺字段读成 None");
        assert!(child.asset_path.is_none());
    }

    #[test]
    fn 树笔记没有根时联动也会补一个根() {
        let store = temp_store("note-tree-noroot");
        let mut note = create(&store, NoteKind::Tree, "坏树".into()).unwrap();
        note.root = None;
        save(&store, &note).unwrap();

        let info = an_info("info-9", "坏文件里也要能联动");
        let linked = link_info(&store, &note.id, &info).unwrap();
        let root = linked.root.as_ref().expect("要补出根节点");
        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].text, "坏文件里也要能联动");
    }

    #[test]
    fn 图片信息联动时用备注或路径兜底() {
        let store = temp_store("note-image");
        let note = create(&store, NoteKind::Doc, "图".into()).unwrap();
        let mut info = an_info("info-3", "");
        info.kind = InfoKind::Image;
        info.asset_path = Some("assets/abc.png".into());

        let linked = link_info(&store, &note.id, &info).unwrap();
        assert!(linked.content.contains("assets/abc.png"), "实际：{}", linked.content);
    }

    #[test]
    fn 删除笔记是挪进回收站而不是硬删() {
        let store = temp_store("note-delete");
        let note = create(&store, NoteKind::Doc, "要删的".into()).unwrap();
        save(&store, &note).unwrap(); // 再存一次，制造一个 .bak

        assert!(delete(&store, &note.id).unwrap());
        assert!(!delete(&store, &note.id).unwrap(), "重复删返回 false");
        assert!(get(&store, &note.id).unwrap().is_none(), "正式文件必须不在");
        assert!(list(&store).unwrap().is_empty(), "列表里不能再出现");

        let trash = notes_dir(&store).join(TRASH_DIR);
        assert!(
            trash.join(format!("{}.json", note.id)).is_file(),
            "回收站里要有原件"
        );
        assert!(
            trash.join(format!("{}.json.bak", note.id)).is_file(),
            "上一版 .bak 也要一起挪走，否则会被 atomic 的救回逻辑复活"
        );
    }

    #[test]
    fn 只改标题不会动树上的节点() {
        // 树笔记改标题不能走"整篇覆盖"，否则会把联动进来的节点抹掉
        let store = temp_store("note-title-only");
        let note = create(&store, NoteKind::Tree, "旧标题".into()).unwrap();
        let info = an_info("info-t", "联动节点");
        link_info(&store, &note.id, &info).unwrap();
        let before = get(&store, &note.id).unwrap().unwrap();
        let root_id = before.root.as_ref().unwrap().id.clone();

        let renamed = set_title(&store, &note.id, "  新标题  ".into()).unwrap();
        assert_eq!(renamed.title, "新标题", "首尾空白要去掉");
        assert_eq!(renamed.root.as_ref().unwrap().id, root_id, "根节点不能换");
        assert_eq!(
            renamed.root.as_ref().unwrap().children.len(),
            1,
            "联动进来的节点必须还在"
        );
        assert_eq!(renamed.root.as_ref().unwrap().children[0].text, "联动节点");

        // 空标题走兜底，和新建时一个规则
        let blank = set_title(&store, &note.id, "   ".into()).unwrap();
        assert_eq!(blank.title, "未命名笔记");
    }

    #[test]
    fn 带正文建笔记也要把减号方括号同步成待办() {
        // 2026-09-21 踩出来的坑：小窗保存改成"一次调用带正文建出来"之后，
        // 命令里只写了盘、漏了 `sync_markers` —— 于是"在小窗里写一条 -[]待办"
        // 根本不会生成待办（m7.1 的验收脚本用这条路造数据，造出 0 条才发现）。
        let store = temp_store("note-create-with-content");
        let (note, sync) = create_with_content(
            &store,
            NoteKind::Doc,
            "小窗里写的".into(),
            "随手记一句\n-[]买酱油\n-[]给妈妈打电话\n".into(),
        )
        .unwrap();

        assert!(sync.changed(), "有两条标记，同步必须报告「变了」");
        let todos = crate::store::todo::list(&store).unwrap();
        let titles: Vec<&str> = todos.iter().map(|one| one.title.as_str()).collect();
        assert!(titles.contains(&"买酱油"), "待办得生成：{titles:?}");
        assert!(titles.contains(&"给妈妈打电话"), "待办得生成：{titles:?}");
        assert!(
            todos
                .iter()
                .all(|one| one.source.note_id.as_deref() == Some(note.id.as_str())),
            "来源要指向这篇笔记"
        );

        // 正文也得真的在盘上（不能只有标题）
        let back = get(&store, &note.id).unwrap().unwrap();
        assert!(back.content.contains("买酱油"), "正文没落盘：{:?}", back.content);
    }

    #[test]
    fn 带空正文建笔记不报错也不生成待办() {
        let store = temp_store("note-create-empty-content");
        let (note, sync) =
            create_with_content(&store, NoteKind::Doc, "空的".into(), String::new()).unwrap();
        assert!(!sync.changed(), "没标记就不该动待办");
        assert_eq!(note.content, "");
        assert!(crate::store::todo::list(&store).unwrap().is_empty());
    }

    #[test]
    fn 清空回收站之前会把里面留下的原文存档() {
        // 2026-09-21 加的：清空回收站是**唯一真删笔记**的地方，删之前必须留一份档 ——
        // 二次确认挡的是手滑，挡不了"确认完就后悔"。
        let store = temp_store("note-purge-archive");
        let gone = create(&store, NoteKind::Doc, "要清的".into()).unwrap();
        assert!(delete(&store, &gone.id).unwrap());

        let removed = purge_trash(&store).unwrap();
        assert!(removed >= 1, "至少删掉挪进去的那个：{removed}");

        let dir = store.data_dir().join("backups");
        let archived: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("回收站-清空前-") && name.ends_with(".json"))
            .collect();
        assert_eq!(archived.len(), 1, "应该留一份档：{archived:?}");
        let text = fs::read_to_string(dir.join(&archived[0])).unwrap();
        assert!(text.contains("要清的"), "留档里得有被清掉那篇的内容：{text}");
    }

    #[test]
    fn 清空回收站只删回收站里的东西() {
        let store = temp_store("note-purge-trash");
        let keep = create(&store, NoteKind::Doc, "留下的".into()).unwrap();
        let gone = create(&store, NoteKind::Doc, "要删的".into()).unwrap();
        assert!(delete(&store, &gone.id).unwrap());

        let trash = notes_dir(&store).join(TRASH_DIR);
        assert!(trash.is_dir(), "删笔记应该把文件挪进回收站");

        let removed = purge_trash(&store).unwrap();
        assert!(removed >= 1, "至少要删掉挪进去的那个文件：{removed}");
        let left = fs::read_dir(&trash).unwrap().filter_map(|e| e.ok()).count();
        assert_eq!(left, 0, "回收站该空了");

        // ★ 没被删的笔记一根毫毛都不能动
        let notes = list(&store).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, keep.id);
        assert_eq!(notes[0].title, "留下的");
    }

    #[test]
    fn 回收站不存在时清空不报错() {
        let store = temp_store("note-purge-noop");
        assert_eq!(purge_trash(&store).unwrap(), 0);
    }

    #[test]
    fn 坏掉的笔记文件会报错() {
        let store = temp_store("note-bad");
        let note = create(&store, NoteKind::Doc, "会坏".into()).unwrap();
        fs::write(note_path(&store, &note.id), "{不是 JSON").unwrap();
        let err = list(&store).unwrap_err();
        assert!(err.contains(&note.id), "要指出是哪个文件：{err}");
    }

    // ─────────────────── M5-1：来源已移除 / 树节点也参与 ───────────────────

    /// 造一棵树：根 + 若干子节点，返回 (落盘后的 note, 子节点 id 列表)
    fn tree_with_children(store: &Store, texts: &[&str]) -> (Note, Vec<String>) {
        let mut note = create(store, NoteKind::Tree, "树的待办".into()).unwrap();
        {
            let root = note.root.as_mut().unwrap();
            for text in texts {
                root.children.push(TreeNode::new(*text));
            }
        }
        let saved = save(store, &note).unwrap();
        let ids = saved
            .root
            .as_ref()
            .unwrap()
            .children
            .iter()
            .map(|child| child.id.clone())
            .collect();
        (saved, ids)
    }

    #[test]
    fn 树节点文字里的标记也建待办() {
        let store = temp_store("note-tree-marker");
        let (note, ids) = tree_with_children(&store, &["-[]写方案", "普通节点", "-[]买咖啡"]);

        let result = sync_markers(&store, &note).unwrap();
        assert_eq!(result.scanned, 2, "两个节点带标记，普通节点不算");
        assert_eq!(result.created, 2);

        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 2);
        let first = items.iter().find(|t| t.title == "写方案").unwrap();
        assert_eq!(first.source.kind, TodoSourceKind::Note);
        assert_eq!(first.source.note_id.as_deref(), Some(note.id.as_str()));
        assert_eq!(
            first.source.node_id.as_deref(),
            Some(ids[0].as_str()),
            "要记住是哪个节点（树里改文字靠它认出'还是同一个'）"
        );
        assert_eq!(first.source.marker_line, None, "树节点没有行号");
        assert_eq!(
            first.source.marker_key.as_deref(),
            Some(crate::marker::node_marker_key(&note.id, &ids[0], "写方案").as_str())
        );

        // 再存一次不翻倍
        let again = sync_markers(&store, &note).unwrap();
        assert_eq!(again.created, 0);
        assert!(!again.changed());
        assert_eq!(todo::list(&store).unwrap().len(), 2);
    }

    #[test]
    fn 同一个树节点改文字_就地改名不翻倍() {
        let store = temp_store("note-tree-rename");
        let (mut note, ids) = tree_with_children(&store, &["-[]写方案", "-[]买咖啡"]);
        sync_markers(&store, &note).unwrap();

        // 改第一个节点的文字（树是"提交那一刻写一次盘"，所以只会来一次）
        note.root.as_mut().unwrap().children[0].text = "-[]写方案（v2）".into();
        let result = sync_markers(&store, &note).unwrap();

        assert_eq!(result.created, 0, "★ 改了措辞不该多出一条待办");
        assert_eq!(result.removed, 0, "★ 也不该把原来那条标成来源已移除");
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 2);
        let renamed = items.iter().find(|t| t.title == "写方案（v2）").unwrap();
        assert_eq!(renamed.source.node_id.as_deref(), Some(ids[0].as_str()));
        assert!(!renamed.source.source_removed);
    }

    #[test]
    fn 树节点被删_待办标来源已移除但不删() {
        let store = temp_store("note-tree-node-gone");
        let (mut note, _) = tree_with_children(&store, &["-[]写方案", "-[]买咖啡"]);
        sync_markers(&store, &note).unwrap();
        assert_eq!(todo::list(&store).unwrap().len(), 2);

        // 删掉第一个节点（连同它的分支）
        note.root.as_mut().unwrap().children.remove(0);
        let result = sync_markers(&store, &note).unwrap();

        assert_eq!(result.removed, 1);
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 2, "★ 待办一条都不许少");
        let gone = items.iter().find(|t| t.title == "写方案").unwrap();
        assert!(gone.source.source_removed);
        let alive = items.iter().find(|t| t.title == "买咖啡").unwrap();
        assert!(!alive.source.source_removed);
    }

    #[test]
    fn 折叠起来的节点照样算数() {
        // 折叠只是"看不见"，节点和文字都还在，标记当然还算数
        let store = temp_store("note-tree-collapsed");
        let (mut note, _) = tree_with_children(&store, &["-[]藏在折叠里的"]);
        sync_markers(&store, &note).unwrap();
        assert_eq!(todo::list(&store).unwrap().len(), 1);

        note.root.as_mut().unwrap().collapsed = true;
        let again = sync_markers(&store, &note).unwrap();
        assert_eq!(again.removed, 0, "折叠不算删除");
        assert!(!todo::list(&store).unwrap()[0].source.source_removed);
    }

    /// **M4.2 挖出来的那个早退 bug**：M3 那版 `sync_markers` 开头就是
    /// `if markers.is_empty() { return }`，于是"把标记全删光"这个**最常见**的动作
    /// 反而永远不会标「来源已移除」。这条测试专门钉住它。
    #[test]
    fn 标记全删光也要标来源已移除() {
        let store = temp_store("note-marker-all-gone");
        let mut note = create(&store, NoteKind::Doc, "写满了标记".into()).unwrap();
        note.content = "-[]甲\n-[]乙\n-[]丙".into();
        sync_markers(&store, &note).unwrap();
        assert_eq!(todo::list(&store).unwrap().len(), 3);

        // 全删光
        note.content = "什么都没了".into();
        let result = sync_markers(&store, &note).unwrap();
        assert_eq!(result.scanned, 0);
        assert_eq!(
            result.removed, 3,
            "★ 全删光也必须标上 —— 早退漏的就是这一种"
        );

        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 3, "★ 只标不删");
        assert!(items.iter().all(|t| t.source.source_removed));
    }

    #[test]
    fn 标记加回来会撤销来源已移除且还是同一条() {
        let store = temp_store("note-marker-revive");
        let mut note = create(&store, NoteKind::Doc, "来回改".into()).unwrap();
        note.content = "-[]买牛奶".into();
        // ⚠️ 必须落盘：`set_marker_checked` 是**重新从磁盘读笔记**再找标记的
        //    （真实调用路径就是这样，编辑器每次保存都先写盘），
        //    只在内存里改 content 的话它扫不到标记，会报"找不到这条标记"
        let mut note = save(&store, &note).unwrap();
        sync_markers(&store, &note).unwrap();

        // 记下 id，并把它勾上（模拟"用户照着做完了"）
        let key = crate::marker::marker_key(&note.id, "买牛奶");
        let id = todo::list(&store).unwrap()[0].id.clone();
        set_marker_checked(&store, &note.id, &key, None, true).unwrap();

        // 把那行删掉 → 标来源已移除，但 id 与完成状态都不动
        note.content = "先不做了".into();
        sync_markers(&store, &note).unwrap();
        let gone = todo::list(&store).unwrap();
        assert_eq!(gone.len(), 1);
        assert!(gone[0].source.source_removed);
        assert_eq!(gone[0].id, id, "★ 还是同一条待办");
        assert_eq!(gone[0].status, TodoStatus::Done, "完成状态要留着");

        // 把那行加回来 → 撤销"来源已移除"
        note.content = "-[]买牛奶".into();
        let back = sync_markers(&store, &note).unwrap();
        assert_eq!(back.created, 0, "★ 不该新建一条");
        assert_eq!(back.removed, 0);
        let revived = todo::list(&store).unwrap();
        assert_eq!(revived.len(), 1);
        assert_eq!(revived[0].id, id, "★ 还是原来那条");
        assert!(!revived[0].source.source_removed);
        assert_eq!(revived[0].status, TodoStatus::Done, "勾选状态也还在");
    }

    #[test]
    fn 标记同步成待办且重复保存不翻倍() {
        let store = temp_store("note-marker-sync");
        let mut note = create(&store, NoteKind::Doc, "写作中".into()).unwrap();
        note.content = "-[]我一定要学会做饭\n随便写一句\n-[]买牛奶".into();

        let first = sync_markers(&store, &note).unwrap();
        assert_eq!(first.scanned, 2);
        assert_eq!(first.created, 2);
        assert!(first.changed());

        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "我一定要学会做饭");
        assert_eq!(items[0].source.kind, TodoSourceKind::Note);
        assert_eq!(items[0].source.note_id.as_deref(), Some(note.id.as_str()));
        assert_eq!(
            items[0].source.marker_key.as_deref(),
            Some(crate::marker::marker_key(&note.id, "我一定要学会做饭").as_str()),
            "去重键要按 noteId + '#' + 归一化文本 记账"
        );

        // 再存一次：不新增
        let again = sync_markers(&store, &note).unwrap();
        assert_eq!(again.created, 0);
        assert!(!again.changed(), "什么都没变就不该广播刷新");
        assert_eq!(todo::list(&store).unwrap().len(), 2);

        // 同一行改字 → 就地改名，还是两条（编辑器边打字边保存，绝不能一条变一串）
        note.content = note.content.replace("买牛奶", "买牛奶和鸡蛋");
        let third = sync_markers(&store, &note).unwrap();
        assert_eq!(third.created, 0, "同一行的文字被改，应该就地改名而不是新建");
        assert_eq!(third.updated, 1);
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 2, "改了文字不该多出一条");
        assert!(items.iter().any(|item| item.title == "买牛奶和鸡蛋"));
        assert!(!items.iter().any(|item| item.title == "买牛奶"));

        // 整行删掉 → **待办不删，标「来源已移除」**（M5-1 的行为）
        note.content = "-[]我一定要学会做饭".into();
        let fourth = sync_markers(&store, &note).unwrap();
        assert_eq!(fourth.created, 0);
        assert_eq!(fourth.removed, 1, "「买牛奶和鸡蛋」那行没了，要标来源已移除");
        assert!(fourth.changed(), "标了来源已移除就算动过待办，要广播刷新");

        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 2, "★ 一条都不许删");
        let gone = items.iter().find(|t| t.title == "买牛奶和鸡蛋").unwrap();
        assert!(gone.source.source_removed, "被删那行的待办要标来源已移除");
        assert_eq!(gone.status, TodoStatus::Open, "标来源已移除不改完成状态");
        let alive = items.iter().find(|t| t.title == "我一定要学会做饭").unwrap();
        assert!(!alive.source.source_removed, "还在正文里的不该被标");

        // 再存一次：已经标过了，不该反复标（幂等，不然每次打字都广播）
        let fifth = sync_markers(&store, &note).unwrap();
        assert_eq!(fifth.removed, 0);
        assert!(!fifth.changed(), "标过之后就不算变化了");
    }

    #[test]
    fn 同一行改字保留勾选状态() {
        let store = temp_store("note-marker-rename");
        let mut note = create(&store, NoteKind::Doc, "边打边存".into()).unwrap();
        note.content = "-[]买牛奶".into();
        let saved = save(&store, &note).unwrap();
        sync_markers(&store, &saved).unwrap();

        let key = crate::marker::marker_key(&saved.id, "买牛奶");
        set_marker_checked(&store, &saved.id, &key, None, true).unwrap();

        // 接着往下打字（模拟自动保存）
        let mut grown = saved.clone();
        grown.content = "-[]买牛奶和鸡蛋".into();
        let result = sync_markers(&store, &grown).unwrap();

        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 1);
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 1, "一行只该有一条待办");
        assert_eq!(items[0].title, "买牛奶和鸡蛋");
        assert_eq!(items[0].status, TodoStatus::Done, "改名不该把勾选弄丢");
    }

    #[test]
    fn 换了行的不相干标记是新的一条() {
        let store = temp_store("note-marker-newline");
        let mut note = create(&store, NoteKind::Doc, "换行".into()).unwrap();
        note.content = "-[]旧任务".into();
        let saved = save(&store, &note).unwrap();
        sync_markers(&store, &saved).unwrap();

        let mut moved = saved.clone();
        moved.content = "先写点别的\n\n-[]新任务".into();
        let result = sync_markers(&store, &moved).unwrap();

        assert_eq!(result.created, 1, "行号不同、文字也不像，就是新的一条");
        assert_eq!(todo::list(&store).unwrap().len(), 2);
    }

    #[test]
    fn 勾选状态写在待办上正文一个字不改() {
        let store = temp_store("note-marker-check");
        let mut note = create(&store, NoteKind::Doc, "要做的事".into()).unwrap();
        note.content = "-[]倒垃圾".into();
        let saved = save(&store, &note).unwrap();
        sync_markers(&store, &saved).unwrap();

        let key = crate::marker::marker_key(&saved.id, "倒垃圾");
        let done = set_marker_checked(&store, &saved.id, &key, Some("倒垃圾"), true).unwrap();
        assert_eq!(done.status, TodoStatus::Done);
        assert!(done.done_at.is_some());

        let after = get(&store, &saved.id).unwrap().unwrap();
        assert_eq!(
            after.content, "-[]倒垃圾",
            "正文是用户手写的，程序不该替他改字（勾选状态存在待办里）"
        );

        let open = set_marker_checked(&store, &saved.id, &key, None, false).unwrap();
        assert_eq!(open.status, TodoStatus::Open);
        assert!(open.done_at.is_none());
        assert_eq!(todo::list(&store).unwrap().len(), 1, "来回勾不该多出待办");
    }

    #[test]
    fn 前台先点勾选框也能补上待办() {
        // 场景：正文刚改完还没走 sync_markers，用户已经点了勾选框
        let store = temp_store("note-marker-late");
        let mut note = create(&store, NoteKind::Doc, "晚勾".into()).unwrap();
        note.content = "-[]补上的待办".into();
        let saved = save(&store, &note).unwrap();
        assert!(todo::list(&store).unwrap().is_empty());

        let key = crate::marker::marker_key(&saved.id, "补上的待办");
        let done = set_marker_checked(&store, &saved.id, &key, None, true).unwrap();
        assert_eq!(done.status, TodoStatus::Done);
        assert_eq!(todo::list(&store).unwrap().len(), 1);
    }

    #[test]
    fn 键对不上时用文字兜底找回来() {
        let store = temp_store("note-marker-fallback");
        let mut note = create(&store, NoteKind::Doc, "兜底".into()).unwrap();
        note.content = "-[]  学会   做饭".into();
        let saved = save(&store, &note).unwrap();

        // 故意给一个错的 key（模拟前端归一化规则有出入），靠 text 兜底
        let done =
            set_marker_checked(&store, &saved.id, "错的键", Some("学会 做饭"), true).unwrap();
        assert_eq!(done.status, TodoStatus::Done);
        assert_eq!(
            done.source.marker_key.as_deref(),
            Some(crate::marker::marker_key(&saved.id, "学会   做饭").as_str()),
            "写回要用后端算出来的键"
        );
    }

    #[test]
    fn 标记没了就报错而不是乱勾() {
        let store = temp_store("note-marker-gone");
        let note = create(&store, NoteKind::Doc, "空的".into()).unwrap();
        let err = set_marker_checked(&store, &note.id, "不存在的键", None, true).unwrap_err();
        assert!(err.contains("找不到这条标记"), "要给人话，别静默失败：{err}");
    }

    #[test]
    fn 树状图笔记不参与标记同步() {
        let store = temp_store("note-marker-tree");
        let mut note = create(&store, NoteKind::Tree, "树".into()).unwrap();
        note.content = "-[]树里写的标记先不管".into();
        let result = sync_markers(&store, &note).unwrap();
        assert_eq!(result.scanned, 0);
        assert!(todo::list(&store).unwrap().is_empty(), "M4 再定树状图怎么标待办");
    }

    // ── M11 前置（2026-09-26）：在执行区改过名的待办，名字归执行区 ──

    #[test]
    fn 执行区改过名的待办_笔记同步不再把名字改回去() {
        let store = temp_store("note-renamed-keeps");
        let mut note = create(&store, NoteKind::Doc, "清单".into()).unwrap();
        note.content = "-[]买牛奶".into();
        let note = save(&store, &note).unwrap();
        sync_markers(&store, &note).unwrap();

        let id = todo::list(&store).unwrap()[0].id.clone();
        // 用户在**执行区**改名 → 走的就是 `todo::set_title`
        let renamed = todo::set_title(&store, &id, "买牛奶和面包".into()).unwrap();
        assert_eq!(renamed.title, "买牛奶和面包");
        assert!(renamed.source.renamed, "★ 改过名要留痕，不然同步会把它改回去");

        // 笔记再保存一次（正文一个字没动）→ 名字必须**还是**执行区那个
        let again = sync_markers(&store, &note).unwrap();
        assert_eq!(again.created, 0, "★ 不许另建一条");
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 1, "★ 还是一条，不能变两条");
        assert_eq!(items[0].id, id, "★ 还是同一条待办");
        assert_eq!(items[0].title, "买牛奶和面包", "★ 名字归执行区，不许被改回去");
    }

    #[test]
    fn 改过名之后_笔记里那行改了_链接续上但名字不动() {
        let store = temp_store("note-renamed-relink");
        let mut note = create(&store, NoteKind::Doc, "清单".into()).unwrap();
        note.content = "-[]买牛奶".into();
        let mut note = save(&store, &note).unwrap();
        sync_markers(&store, &note).unwrap();

        let id = todo::list(&store).unwrap()[0].id.clone();
        todo::set_title(&store, &id, "买牛奶和面包".into()).unwrap();

        // 用户把笔记里那行改了一个字（键就变了）→ 必须**就地续链接**，不许另建
        note.content = "-[]买牛奶（超市）".into();
        let result = sync_markers(&store, &note).unwrap();
        assert_eq!(result.created, 0, "★ 不许当成新标记另建一条");
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 1, "★ 还是一条");
        assert_eq!(items[0].id, id, "★ 还是同一条待办");
        assert_eq!(items[0].title, "买牛奶和面包", "★ 名字一个字都不许动");
        assert_eq!(
            items[0].source.marker_key.as_deref(),
            Some(crate::marker::marker_key(&note.id, "买牛奶（超市）").as_str()),
            "★ 键要续成新的，不然下次同步就认不出它了"
        );
        assert!(!items[0].source.source_removed, "★ 不该被标成来源已移除");
    }

    #[test]
    fn 改过名之后_笔记里那行删了_照样标来源已移除但名字不动() {
        let store = temp_store("note-renamed-then-gone");
        let mut note = create(&store, NoteKind::Doc, "清单".into()).unwrap();
        note.content = "-[]买牛奶".into();
        let mut note = save(&store, &note).unwrap();
        sync_markers(&store, &note).unwrap();

        let id = todo::list(&store).unwrap()[0].id.clone();
        todo::set_title(&store, &id, "买牛奶和面包".into()).unwrap();

        note.content = "先不买了".into();
        sync_markers(&store, &note).unwrap();
        let items = todo::list(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].source.source_removed, "★ 标记没了还是要标「来源已移除」");
        assert_eq!(items[0].title, "买牛奶和面包", "★ 名字照样不动");
    }
}
