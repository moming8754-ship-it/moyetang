//! 暴露给前端的 `#[tauri::command]`。
//!
//! 规则：
//! - 所有数据读写都通过 `store::*`，前端不直接碰文件；
//! - **写操作成功后**统一 `emit("data-changed")`，前端据此重新拉数据；
//! - 返回 `Result<_, String>`，错误信息直接给前端弹 Toast（不静默吞掉）。

use crate::models::{
    now_iso, title_from_text, Annotation, ArchiveEntry, Award, Config, Countdown, Info, InfoStatus,
    Link, LinkTargetKind, Motto, MottoKind, Note, NoteKind, PomodoroExtra, Quadrant, Reminder,
    Repeat, Todo, TodoSource, TodoSourceKind, TreeNode,
};
use crate::store::{
    annotations, archive, assets, atomic, awards, backup, config, countdown, dailies, export, info,
    mottos, note, reminder, sync, sync_server, todo, tree, AppState, Store,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};

/// 写操作成功后广播：让所有页面重新拉数据
fn emit_data_changed(app: &tauri::AppHandle) {
    if let Err(e) = app.emit("data-changed", ()) {
        // 事件发不出去不影响数据本身，但要留痕，别无声无息
        eprintln!("[东方摩耶堂] 广播 data-changed 失败：{e}");
    }
}

/// 借出 Store（锁异常要给前端一个能看懂的说法）
fn with_store<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Store) -> Result<T, String>,
) -> Result<T, String> {
    let store = state
        .store
        .lock()
        .map_err(|e| format!("数据目录状态锁异常：{e}"))?;
    f(&store)
}

/// 取出数据目录路径字符串
fn data_dir_string(state: &State<'_, AppState>) -> Result<String, String> {
    with_store(state, |store| {
        Ok(store.data_dir().to_string_lossy().to_string())
    })
}

/// 联动到认知区后回给前端的简报（前端拿它跳转/提示）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedNote {
    pub note_id: String,
    pub note_title: String,
    pub note_kind: NoteKind,
}

// ───────────────────────────── 数据目录 ─────────────────────────────

/// 数据目录：`data_dir_get`
#[tauri::command]
pub fn data_dir_get(state: State<'_, AppState>) -> Result<String, String> {
    data_dir_string(&state)
}

/// 在系统文件管理器里打开数据目录：`data_dir_open`
#[tauri::command]
pub fn data_dir_open(state: State<'_, AppState>) -> Result<(), String> {
    let dir = data_dir_string(&state)?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| format!("打开数据目录失败：{e}"))
}

// ───────────────────────────── 设置 ─────────────────────────────

/// 读设置：`config_get`
#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> Result<Config, String> {
    with_store(&state, |store| config::load(store))
}

/// 保存设置：`config_save`
///
/// `dataDir` 与当前不同时会**切换数据目录**：先把现有数据**复制**过去
/// （目标已存在的文件不覆盖），原目录原样保留不删，再把新目录记到默认目录的
/// `config.json` 里供下次启动定位。
#[tauri::command]
pub fn config_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: Config,
) -> Result<Config, String> {
    let mut store = state
        .store
        .lock()
        .map_err(|e| format!("数据目录状态锁异常：{e}"))?;

    let mut config = config;
    config.data_dir = config.data_dir.trim().to_string();

    let switching = !config.data_dir.is_empty() && Path::new(&config.data_dir) != store.data_dir();
    if switching {
        let target = Path::new(&config.data_dir);
        if !target.is_absolute() {
            return Err(format!("数据目录必须是绝对路径：{}", config.data_dir));
        }
        let next = Store::at(target.to_path_buf());
        next.ensure_dirs()
            .map_err(|e| format!("创建新数据目录失败：{e}"))?;
        store
            .copy_data_to(next.data_dir())
            .map_err(|e| format!("复制数据到新目录失败（原目录未改动）：{e}"))?;
        config::record_data_dir(&config.data_dir)?;
        // 新目录也要放行给 asset 协议，否则新目录里的图片前端显示不出来
        if let Err(e) = app.asset_protocol_scope().allow_directory(next.data_dir(), true) {
            eprintln!("[东方摩耶堂] 放行新数据目录给 asset 协议失败：{e}");
        }
        *store = next;
        println!("[东方摩耶堂] 数据目录已切换到：{}", config.data_dir);
    }

    config.data_dir = store.data_dir().to_string_lossy().to_string();
    config::save(&store, &config)?;

    drop(store);

    // M6：唤起小窗的快捷键可能被改了 → 立刻重注册一次
    // （清空 = 用户想关掉这个功能；换键 = 旧键要注销，不然会越注册越多）
    // ⚠️ M17（2.0.0）：快捷键是桌面专属 —— 手机版**保存设置照常**，只是没有快捷键可注册。
    #[cfg(desktop)]
    {
        let accelerator = config.shortcuts.toggle_small_window.trim().to_string();
        if accelerator.is_empty() {
            crate::shortcuts::unregister_all(&app);
            println!("[东方摩耶堂] 唤起小窗的快捷键已关闭");
        } else if let Err(error) = crate::shortcuts::register(&app, &accelerator) {
            eprintln!("[东方摩耶堂] {error}");
        }
    }
    #[cfg(mobile)]
    let _ = &app;

    emit_data_changed(&app);
    Ok(config)
}

// ───────────────────────────── 附件 ─────────────────────────────

/// 导入图片：`asset_import`（把外部文件复制进 `assets/`，返回相对路径）
#[tauri::command]
pub fn asset_import(state: State<'_, AppState>, path: String) -> Result<String, String> {
    with_store(&state, |store| assets::import_file(store, Path::new(&path)))
}

/// 附件的绝对路径：`asset_abs_path`（前端拿它显示图片）
#[tauri::command]
pub fn asset_abs_path(state: State<'_, AppState>, rel_path: String) -> Result<String, String> {
    with_store(&state, |store| {
        Ok(assets::abs_path(store, &rel_path)?
            .to_string_lossy()
            .to_string())
    })
}

/// 把一段**图片字节**（base64）写进 `assets/`：`asset_write_image`
///
/// 用途：**从剪贴板粘贴图片**（用户 M4 反馈）。剪贴板给的是字节、不是磁盘路径，
/// 所以走不了 `asset_import`。格式按魔数认，认不出就报错。
/// 走 base64 而不是 `Vec<u8>`：一张 1 MB 的图变成 JSON 数字数组要 4 MB+，
/// base64 只有 1.33 倍，省得在 IPC 上白烧时间。
#[tauri::command]
pub fn asset_write_image(
    state: State<'_, AppState>,
    data_base64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let raw = data_base64.trim();
    // 前端可能顺手把 dataURL 前缀也带过来，容错一下
    let payload = raw.split_once(',').map(|(_, tail)| tail).unwrap_or(raw);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("剪贴板图片解码失败：{e}"))?;
    with_store(&state, |store| assets::write_image_bytes(store, &bytes))
}

// ───────────────────────────── 信息区 ─────────────────────────────

/// 信息列表（**新的在前**）：`info_list`
#[tauri::command]
pub fn info_list(state: State<'_, AppState>) -> Result<Vec<Info>, String> {
    with_store(&state, |store| info::list(store))
}

/// 新建信息：`info_create`
#[tauri::command]
pub fn info_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    kind: Option<crate::models::InfoKind>,
    categories: Option<Vec<String>>,
    asset_path: Option<String>,
) -> Result<Info, String> {
    let created = with_store(&state, |store| {
        info::create(
            store,
            kind.unwrap_or_default(),
            text,
            categories.unwrap_or_default(),
            asset_path,
        )
    })?;
    emit_data_changed(&app);
    Ok(created)
}

/// 更新信息：`info_update`（按 id 整条替换；分类、状态、联动都走它）
#[tauri::command]
pub fn info_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    info: Info,
) -> Result<Info, String> {
    let updated = with_store(&state, |store| info::update(store, info))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 删除信息：`info_delete`（顺便把它的提醒清掉）
#[tauri::command]
pub fn info_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let removed = with_store(&state, |store| {
        let removed = info::delete(store, &id)?;
        if removed {
            // 信息没了，挂着的提醒也别留着（否则点进去找不到东西）
            reminder::drop_for_ref(store, &id)?;
        }
        Ok(removed)
    })?;
    if removed {
        emit_data_changed(&app);
    }
    Ok(removed)
}

/// **联动 A**：把信息写进认知笔记（`note_id` 给了就用它，否则按标题新建）
#[tauri::command]
pub fn info_link_note(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    info_id: String,
    note_id: Option<String>,
    note_title: Option<String>,
    note_kind: Option<NoteKind>,
) -> Result<LinkedNote, String> {
    let linked = with_store(&state, |store| {
        let mut target =
            info::get(store, &info_id)?.ok_or_else(|| format!("信息不存在：{info_id}"))?;

        let chosen = match note_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => note::get(store, id)?.ok_or_else(|| format!("笔记不存在：{id}"))?,
            None => {
                let title = note_title
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| title_from_text(&note::display_text(&target), 20));
                note::create(store, note_kind.unwrap_or_default(), title)?
            }
        };

        let saved_note = note::link_info(store, &chosen.id, &target)?;

        // 原信息一律保留，只加"已联动 + 去向"标记
        target.status = InfoStatus::Linked;
        let already = target
            .links
            .iter()
            .any(|link| link.target_kind == LinkTargetKind::Note && link.target_id == saved_note.id);
        if !already {
            target.links.push(Link {
                target_kind: LinkTargetKind::Note,
                target_id: saved_note.id.clone(),
                title_snapshot: saved_note.title.clone(),
                at: now_iso(),
            });
        }
        info::update(store, target)?;

        // 用户已经处理了这条信息 → 它的提醒（含已经弹过的横幅）一并收掉
        reminder::dismiss_for_ref(store, &info_id)?;

        Ok(LinkedNote {
            note_id: saved_note.id,
            note_title: saved_note.title,
            note_kind: saved_note.kind,
        })
    })?;

    emit_data_changed(&app);
    Ok(linked)
}

/// **联动 B**：以信息标题建一条待办
#[tauri::command]
pub fn info_link_todo(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    info_id: String,
    planned_at: Option<String>,
) -> Result<Todo, String> {
    let created = with_store(&state, |store| {
        let mut target =
            info::get(store, &info_id)?.ok_or_else(|| format!("信息不存在：{info_id}"))?;

        let title = title_from_text(&note::display_text(&target), 40);
        let todo = todo::create(
            store,
            title,
            TodoSource {
                kind: TodoSourceKind::Info,
                info_id: Some(target.id.clone()),
                ..Default::default()
            },
            planned_at,
        )?;

        target.status = InfoStatus::Linked;
        let already = target
            .links
            .iter()
            .any(|link| link.target_kind == LinkTargetKind::Todo && link.target_id == todo.id);
        if !already {
            target.links.push(Link {
                target_kind: LinkTargetKind::Todo,
                target_id: todo.id.clone(),
                title_snapshot: todo.title.clone(),
                at: now_iso(),
            });
        }
        info::update(store, target)?;

        // 用户已经处理了这条信息 → 提醒一并收掉
        reminder::dismiss_for_ref(store, &info_id)?;

        Ok(todo)
    })?;

    emit_data_changed(&app);
    Ok(created)
}

// ───────────────────────────── 认知区 ─────────────────────────────

/// 笔记列表（最近改过的在前）：`note_list`
#[tauri::command]
pub fn note_list(state: State<'_, AppState>) -> Result<Vec<Note>, String> {
    with_store(&state, |store| note::list(store))
}

/// 新建笔记：`note_create`
#[tauri::command]
pub fn note_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: String,
    kind: Option<NoteKind>,
    content: Option<String>,
) -> Result<Note, String> {
    // ⚠️ **正文要在同一条命令里落盘**，不能"先 create 再 save"由前端分两次调。
    //
    // 小窗保存走的就是这条路：原来前端是 `note_create`（空正文）→ `note_save`（写正文）。
    // 而 `note_create` 会广播 `data-changed` → 认知区立刻刷新，**看到的是一篇空正文的笔记**；
    // 等第二次写完才又刷一次。用户的原话是"保存后进入认知区，结果就是直接没有正文了，
    // 只有标题是我写的那段话"（他以为是延迟，其实是中间态被看见了）。
    // 现在两次写都在命令内部完成，**只广播一次**，前端不可能看见中间态。
    //
    // ⚠️⚠️ 而且**必须补一次 `sync_markers`**：带正文建出来的笔记里可能就有 `-[]` 标记
    // （用户在小窗里随手写一条待办是很正常的事），漏了这一步待办就不会生成 ——
    // 2026-09-21 真踩到：m7.1 的验收脚本用这条路造"笔记里的待办"，结果 0 条。
    let had_content = content.as_ref().map(|text| !text.is_empty()).unwrap_or(false);
    let (created, sync) = with_store(&state, |store| match content {
        Some(text) if !text.is_empty() => {
            // 走 store 层那个"带正文 + 同步标记"的函数（它俩必须一起做，见它的注释）
            note::create_with_content(store, kind.unwrap_or_default(), title, text)
        }
        _ => {
            let created = note::create(store, kind.unwrap_or_default(), title)?;
            let sync = note::sync_markers(store, &created)?;
            Ok((created, sync))
        }
    })?;
    // 带了正文、或者真的动过待办 → 只在这里广播一次（前端不可能看见"空正文"的中间态）
    if had_content || sync.changed() {
        emit_data_changed(&app);
    }
    Ok(created)
}

/// 取一条笔记：`note_get`
#[tauri::command]
pub fn note_get(state: State<'_, AppState>, id: String) -> Result<Option<Note>, String> {
    with_store(&state, |store| note::get(store, &id))
}

/// 删除笔记：`note_delete`
#[tauri::command]
pub fn note_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let removed = with_store(&state, |store| {
        let removed = note::delete(store, &id)?;
        if removed {
            // M5-1：笔记连同它里面的 `-[]` 标记一起没了 → 那些待办标「来源已移除」。
            // **不删待办**：用户很可能早就在别处把这件事做完了，替他删掉就是丢东西。
            todo::mark_note_removed(store, &id)?;
        }
        Ok(removed)
    })?;
    if removed {
        emit_data_changed(&app);
    }
    Ok(removed)
}

/// 保存笔记（标题/正文）：`note_save`（M3 编辑器用）
///
/// 保存时顺手把正文里的 `-[]文字` 同步成待办（M3-4）。
///
/// ⚠️ 这里是「写操作后广播 `data-changed`」这条规矩的**一处有意例外**：
/// 编辑器是边打字边自动保存的，每停一下就全量重拉四个文件太浪费，
/// 所以**只有真的动过待办（新建/改标题）才广播**；正文本身的改动由返回的
/// `Note` 在前端就地更新（笔记列表/时间戳跟着走，不用等刷新）。
#[tauri::command]
pub fn note_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note: Note,
) -> Result<Note, String> {
    let (saved, sync) = with_store(&state, |store| {
        let saved = note::save(store, &note)?;
        let sync = note::sync_markers(store, &saved)?;
        Ok((saved, sync))
    })?;
    if sync.changed() {
        emit_data_changed(&app);
    }
    Ok(saved)
}

/// 勾选 / 取消勾选笔记里的一条 `-[]` 标记：`note_marker_toggle`（M3-4）
///
/// 状态记在**对应的待办**上（执行区据此显示变化），笔记正文一个字都不改。
/// 返回更新后的待办，前端拿它就地把勾选框点亮；同时广播 `data-changed`。
#[tauri::command]
pub fn note_marker_toggle(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    marker_key: String,
    text: Option<String>,
    checked: bool,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| {
        note::set_marker_checked(store, &note_id, &marker_key, text.as_deref(), checked)
    })?;
    emit_data_changed(&app);
    Ok(updated)
}

// ─────────────────────── 认知区 · 树状图节点（M4） ───────────────────────
//
// ⚠️ 这一族命令**有意不广播 `data-changed`**，理由与 `note_save` 的例外同源：
// 树状图是"点一下改一处"的密集操作，每次都让四个文件全量重拉太浪费；
// 前端拿返回的 `Note` 就地更新笔记列表（`updatedAt` 跟着走，排序与后端一致）。
//
// ⚠️ **M5 起这条前提变了一半**：树节点文字现在也参与 `-[]` 待办检测
// （用户 2026-09-21 拍板），于是"会不会改到待办"就成了这些命令要回答的问题。
// 处理办法：**可能改到节点文字的**那几个统一走 [`tree_op_syncing`] ——
// 笔记照旧就地更新，**只有真的动过待办才补一次广播**（和 `note_save` 一个套路）。
//
// 每条命令都是「**读盘拿最新** → 改一处 → `note::save`（走 `store::atomic`）」，
// **不是**"用前端传来的树覆盖文件" —— 所以不可能抹掉别人（比如 `info_link_note`）
// 刚写进去的节点。详见 `store::tree` 的模块注释。

/// 跑一个**可能改到节点文字或节点集合**的树操作，并顺手把树里的 `-[]` 同步成待办（M5）。
///
/// 要不要广播由 `MarkerSync::changed()` 决定：树操作是密集操作，
/// 没动待办就不该让四个文件全量重拉（这正是 M4 定下的那条例外）。
fn tree_op_syncing(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    run: impl FnOnce(&Store) -> Result<tree::TreeOpResult, String>,
) -> Result<tree::TreeOpResult, String> {
    let (result, sync) = with_store(state, |store| {
        let result = run(store)?;
        let sync = note::sync_markers(store, &result.note)?;
        Ok((result, sync))
    })?;
    if sync.changed() {
        emit_data_changed(app);
    }
    Ok(result)
}

/// 加子节点：`note_tree_add_child`
#[tauri::command]
pub fn note_tree_add_child(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    parent_id: String,
    text: Option<String>,
) -> Result<tree::TreeOpResult, String> {
    tree_op_syncing(&app, &state, |store| {
        tree::add_child_saved(store, &note_id, &parent_id, text)
    })
}

/// 加同级节点：`note_tree_add_sibling`（根节点会报错，前端也把 ⋮＋ 置灰）
#[tauri::command]
pub fn note_tree_add_sibling(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    node_id: String,
    text: Option<String>,
) -> Result<tree::TreeOpResult, String> {
    tree_op_syncing(&app, &state, |store| {
        tree::add_sibling_saved(store, &note_id, &node_id, text)
    })
}

/// 删除节点（**含整个分支**）：`note_tree_remove`（根节点会报错）
///
/// 删掉的分支里如果有 `-[]` 标记，对应的待办会被标成「来源已移除」而不是删掉。
#[tauri::command]
pub fn note_tree_remove(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    node_id: String,
) -> Result<tree::TreeOpResult, String> {
    tree_op_syncing(&app, &state, |store| {
        tree::remove_saved(store, &note_id, &node_id)
    })
}

/// 把一个节点（连同整枝）插回指定位置：`note_tree_insert`
///
/// 撤销「删掉整枝」用（用户反馈要 Ctrl+Z）。校验见 `store::tree::insert_at`：
/// 父节点要存在、id 不能和树上已有的相撞。
#[tauri::command]
pub fn note_tree_insert(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    parent_id: String,
    index: usize,
    subtree: TreeNode,
) -> Result<tree::TreeOpResult, String> {
    tree_op_syncing(&app, &state, |store| {
        tree::insert_saved(store, &note_id, &parent_id, index, subtree)
    })
}

/// 拖动改层级/顺序：`note_tree_move`（目标是自己的后代 → 报错，防环）
///
/// 只挪位置、不碰任何文字，所以**不会动待办** → 不需要 `app`，也就不用同步。
#[tauri::command]
pub fn note_tree_move(
    state: State<'_, AppState>,
    note_id: String,
    node_id: String,
    target_id: String,
    position: tree::DropPosition,
) -> Result<tree::TreeOpResult, String> {
    with_store(&state, |store| {
        tree::move_saved(store, &note_id, &node_id, &target_id, position)
    })
}

/// 改节点文字：`note_tree_set_text`
#[tauri::command]
pub fn note_tree_set_text(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    node_id: String,
    text: String,
) -> Result<tree::TreeOpResult, String> {
    tree_op_syncing(&app, &state, |store| {
        tree::set_text_saved(store, &note_id, &node_id, text)
    })
}

/// 折叠 / 展开一条分支：`note_tree_set_collapsed`
#[tauri::command]
pub fn note_tree_set_collapsed(
    state: State<'_, AppState>,
    note_id: String,
    node_id: String,
    collapsed: bool,
) -> Result<tree::TreeOpResult, String> {
    with_store(&state, |store| {
        tree::set_collapsed_saved(store, &note_id, &node_id, collapsed)
    })
}

/// 节点插图片 / 去掉图片：`note_tree_set_image`
///
/// `asset_path` 传 `None`（前端传 `null`）只是**解除引用**，
/// `assets/` 里的原文件不动（守「删除留后路」）。路径得先用 `asset_import` 换来。
#[tauri::command]
pub fn note_tree_set_image(
    state: State<'_, AppState>,
    note_id: String,
    node_id: String,
    asset_path: Option<String>,
) -> Result<tree::TreeOpResult, String> {
    with_store(&state, |store| {
        tree::set_image_saved(store, &note_id, &node_id, asset_path)
    })
}

/// 补救：给丢了根节点的坏树笔记补上「中心主题」：`note_tree_ensure_root`
///
/// 幂等（已经有根就原样返回）。前端只在打开的树笔记确实没有 `root` 时才露出这个入口。
#[tauri::command]
pub fn note_tree_ensure_root(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
) -> Result<Note, String> {
    let fixed = with_store(&state, |store| {
        let fixed = tree::ensure_root_saved(store, &note_id)?;
        // 顺带同步一次标记：这条命令也是验收脚本的"刷新开关"，
        // 顺手把树里的 `-[]` 对齐了，省得界面和磁盘不一致
        note::sync_markers(store, &fixed)?;
        Ok(fixed)
    })?;
    // 这条是"修文件"，不是日常编辑，广播一次让各处视图对齐
    emit_data_changed(&app);
    Ok(fixed)
}

/// 只改笔记标题：`note_title_set`
///
/// 树状图面板用它改标题（**不广播**，就地更新，理由同上）。
/// 文本笔记仍走 `note_save`，M3 的行为一个字不改。
#[tauri::command]
pub fn note_title_set(
    state: State<'_, AppState>,
    note_id: String,
    title: String,
) -> Result<Note, String> {
    with_store(&state, |store| note::set_title(store, &note_id, title))
}

/// 只改笔记的**标题 + 正文**：`note_set_text`（2026-10-06 加，P0-1 修）
///
/// 手机端认知区从「整篇覆盖的 note_save」改成调它 —— 这样手机上编辑树笔记**不会**
/// 把电脑侧的树节点覆盖掉（详见 store::note::set_text 的注释）。
/// 标记照样同步成待办（跟 note_save 一样调 sync_markers）；只有真的动过待办才广播 data-changed。
/// 🔴 P0-1（2026-10-06）：把树笔记**正文里还没成为节点**的整行文字补进树：`note_tree_append_text`
///
/// 手机版没有树编辑界面（点开树笔记是**文本页**），他打的字进 `content`；电脑侧树视图只看 `root`
/// → "树在、内容没了"。手机端保存树笔记时调它一次，把那些话补成根节点下的子节点。
/// **幂等**（已在树里的文字不重复加）、**非破坏**（只追加，不动已有节点）。
/// 返回新加的几个节点；前端拿返回的整篇 Note 就地更新（跟其它树操作一条路，所以不广播）。
#[tauri::command]
pub fn note_tree_append_text(
    state: State<'_, AppState>,
    note_id: String,
    text: String,
) -> Result<Note, String> {
    with_store(&state, |store| {
        crate::store::tree::append_text_saved(store, &note_id, &text)?;
        crate::store::note::get(store, &note_id)?.ok_or_else(|| format!("笔记不存在：{note_id}"))
    })
}
#[tauri::command]

pub fn note_set_text(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    title: String,
    content: String,
) -> Result<Note, String> {
    let (saved, sync) = with_store(&state, |store| {
        let saved = note::set_text(store, &note_id, title, content)?;
        let sync = note::sync_markers(store, &saved)?;
        Ok((saved, sync))
    })?;
    if sync.changed() {
        emit_data_changed(&app);
    }
    Ok(saved)
}
/// 把笔记移到某个分组（`group` 传空串 = 移出分组）：`note_set_group`（M8 方案 A）
///
/// 和 `note_title_set` 一样是**操作式**的（只改 `group` 这一个字段，不整篇覆盖），
/// 也**不广播** `data-changed` —— 前端拿返回的 `Note` 就地更新列表即可。
#[tauri::command]
pub fn note_set_group(
    state: State<'_, AppState>,
    note_id: String,
    group: String,
) -> Result<Note, String> {
    with_store(&state, |store| note::set_group(store, &note_id, group))
}

/// 现有分组名列表（去重排序）：`note_groups` —— 左栏和"移到分组"菜单用它
#[tauri::command]
pub fn note_groups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_store(&state, |store| note::groups(store))
}

// ───────────────────────────── 执行区 ─────────────────────────────
//
// ⚠️ M5 起待办**不许"整条覆盖"**：`todos.json` 会被后端自己改
// （`sync_markers` 同步标题与「来源已移除」、番茄钟往 `pomodoros` 里追加），
// 前端拿手里那份整条发回来，会把刚写进去的东西抹掉。
// 所以这一族命令一律**操作式**：读盘拿最新 → 只改这一处 → 原子写回。
// （M4 在树上踩过同一个坑，`note_tree_*` 就是因此改成操作式的。）

/// 待办列表（按 order 升序）：`todo_list`
#[tauri::command]
pub fn todo_list(state: State<'_, AppState>) -> Result<Vec<Todo>, String> {
    with_store(&state, |store| todo::list(store))
}

/// 新建待办：`todo_create`
#[tauri::command]
pub fn todo_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: String,
    planned_at: Option<String>,
) -> Result<Todo, String> {
    let created = with_store(&state, |store| {
        todo::create(store, title, TodoSource::default(), planned_at)
    })?;
    emit_data_changed(&app);
    Ok(created)
}

/// **标完成 / 取消完成**：`todo_set_done`（M5 第一件事，用户点名要）
///
/// 只碰状态，别的字段一律不动。信息区来的、笔记里 `-[]` 来的、手动的待办**都能勾** ——
/// M3 过渡期"信息区来的待办没法完成"那条死路到此为止。
#[tauri::command]
pub fn todo_set_done(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    done: bool,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_done(store, &id, done))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 改标题：`todo_set_title`（只碰标题）
#[tauri::command]
pub fn todo_set_title(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_title(store, &id, title))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 写这条待办的「须知」：`todo_set_focus_note`（M13-C；只碰这一个字段，**空串 = 清掉**）
///
/// 「须知」= 点开始专注时飘在小窗上的长期备注（"这件事要干什么 / 有什么规则"）。
/// 跟待办走、不跟番茄记录走；小窗和番茄钟面板两处都往这儿写。
///
/// ⚠️ 故意**不收整条 `Todo`**、只收 `id + text`：待办是操作式命令，
/// 整条覆盖会把后端刚写进去的番茄记录 / 同步过来的标题抹掉（原因见上面那一族命令的注释）。
#[tauri::command]
pub fn todo_set_focus_note(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_focus_note(store, &id, &text))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 设 / 清**这一条待办自己的番茄时长**：`todo_set_custom_minutes`（v1.15.0）
///
/// - `minutes` 传分钟数（1~999）→ 这条待办以后就用它；
/// - 传 `null` → **恢复跟随设置里的全局值**（`config.focus.customMinutes`）。
///
/// ⚠️ 跟 `todo_set_focus_note` 同一个道理：**只收 `id + minutes`、绝不收整条 `Todo`** ——
/// 整条覆盖会把后端刚写进去的番茄记录 / 同步过来的字段抹掉（那条族命令的注释里写透了）。
/// ⚠️ 越界（0 / 1000 / 负数）由 `store::todo::set_custom_minutes` 拒收，前端会拿到一条 Err。
#[tauri::command]
pub fn todo_set_custom_minutes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    minutes: Option<u32>,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_custom_minutes(store, &id, minutes))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 设定时间 / 清掉：`todo_set_planned`（`plannedAt` 传 `null` 或空串 = 清掉）
///
/// ⚠️ M5 的待办命令是**一个动作一条命令**，不是"传一个 patch 对象"。
/// 原因见 `todo.rs` 的 `记一笔_双层Option分不开不传和null_所以改用专用setter`：
/// serde 会把 `null` 吃成 `None`，"清空"和"不动"在 JSON 里根本分不开。
/// 拆成专用 setter 之后，**"调用了"本身就等于"要改这一项"**，没有歧义。
#[tauri::command]
pub fn todo_set_planned(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    planned_at: Option<String>,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_planned_at(store, &id, planned_at))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 设/清**截止日期**：`todo_set_due`（M9-1；传 `null` 或空串 = 清掉）///
/// 和 `todo_set_planned` 是两个字段、两个意思：
/// `plannedAt` = 我打算什么时候做（今日时间轴用）；`dueAt` = 最晚什么时候必须完成（逾期标红）。
#[tauri::command]
pub fn todo_set_due(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    due_at: Option<String>,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_due_at(store, &id, due_at))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 设/清**重复规则**：`todo_set_repeat`（M9-6；传 `null` = 不重复）
///
/// 真正"派下一条"的动作**不在这个命令里**，而是在 `todo_set_done`：
/// 用户心里想的是"我做完了这件事"，不是"请生成下一条"。
#[tauri::command]
pub fn todo_set_repeat(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    repeat: Option<Repeat>,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_repeat(store, &id, repeat))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 子任务：加一条（M9-2）：`todo_subtask_add`
#[tauri::command]
pub fn todo_subtask_add(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::subtask_add(store, &id, text))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 子任务：勾上/取消（M9-2）：`todo_subtask_toggle`
#[tauri::command]
pub fn todo_subtask_toggle(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    subtask_id: String,
    done: bool,
) -> Result<Todo, String> {
    let updated =
        with_store(&state, |store| todo::subtask_toggle(store, &id, &subtask_id, done))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 子任务：删掉一条（M9-2）：`todo_subtask_remove`
#[tauri::command]
pub fn todo_subtask_remove(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    subtask_id: String,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::subtask_remove(store, &id, &subtask_id))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 调整四象限分类：`todo_set_quadrant`（传 `null` = 拖出象限，回到"没分类"）
#[tauri::command]
pub fn todo_set_quadrant(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    quadrant: Option<Quadrant>,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| todo::set_quadrant(store, &id, quadrant))?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 把待办移到某个分组：`todo_set_group`（D 批，2026-10-04；传空串 = 移出分组）
///
/// 跟 `todo_set_quadrant` 同一族：**操作式、只改这一个字段**（理由见上面那一族命令的注释），
/// 但**不广播 `data-changed`** —— 跟 `note_set_group` 一样，前端拿返回的 `Todo` 就地更新列表就够了
/// （拖拽跨组时会连着 `todo_reorder` 一起调，广播两次反而会让列表闪）。
#[tauri::command]
pub fn todo_set_group(
    state: State<'_, AppState>,
    id: String,
    group: String,
) -> Result<Todo, String> {
    with_store(&state, |store| todo::set_group(store, &id, group))
}

/// 现有分组名列表（去重、按名字排序）：`todo_groups` —— 分组段和"移到分组"菜单用它
#[tauri::command]
pub fn todo_groups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_store(&state, |store| todo::groups(store))
}

/// 拖动排序：`todo_reorder`（按传入的 id 顺序重排 `order`）
#[tauri::command]
pub fn todo_reorder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<Vec<Todo>, String> {
    let items = with_store(&state, |store| todo::reorder(store, &ordered_ids))?;
    emit_data_changed(&app);
    Ok(items)
}

/// 删除待办（二次确认由前端做）：`todo_delete`
#[tauri::command]
pub fn todo_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let removed = with_store(&state, |store| {
        let removed = todo::delete(store, &id)?;
        if removed {
            // 它身上的提醒一并收掉，别留一条指向空气的提醒
            reminder::drop_for_ref(store, &id)?;
        }
        Ok(removed)
    })?;
    if removed {
        emit_data_changed(&app);
    }
    Ok(removed)
}

/// 记一次番茄钟：`todo_add_pomodoro`
///
/// `finish=true` 时顺手标完成 —— **只标完成，绝不删除**（PRD 5.3 / 10.4）。
///
/// M13-B 追加的 4 个参数全是**可选**（`focus_monitor_stop` 拿到的快照直接塞进来）：
/// 不传就当 0 / false。老调用方与老验收脚本**一个字都不用改**。
///
/// 🔴 **2026-10-05（v1.14.0）修的真 bug**：以前这两项就是 `unwrap_or(0)` —— 于是
/// **前端只要丢了手里那份数字（合盖睡一觉后主窗被挂起/重建、进程重启），
/// 后端明明算对过的"睡了多久"就被写成 0**（用户实测那条记录：`seconds:4`、`pausedSeconds:0`）。
///
/// 现在的规矩是「**两边的账各算各的，谁算出来的都不许丢**」：
/// - **后端那份**（锁屏 / 休眠，只有系统层拿得到）→ 从**实时会话**与**最近一次结算**里取最大的
///   （见 [`crate::focus::best_effort`]；两份说的是同一件事，相加会翻倍）；
/// - **前端那份**（用户在面板上按的手动暂停）→ 由新参数 `manual_paused_seconds` 单独传进来，
///   它跟后端那份**互不重叠**，所以是**相加**，不是取最大。
///
/// `paused_seconds` 保持"前端手里的暂停总数"这个老语义（= 后端类 + 手动）：
/// 它减去 `manual_paused_seconds` 就是前端眼里的"后端类"部分，再跟后端自己算的取最大。
#[tauri::command]
pub fn todo_add_pomodoro(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    mode: String,
    seconds: u32,
    note: String,
    finish: bool,
    interrupted_seconds: Option<u64>,
    interrupted_times: Option<u32>,
    paused_seconds: Option<u64>,
    voided: Option<bool>,
    manual_paused_seconds: Option<u64>,
) -> Result<Todo, String> {
    // 后端（系统层）算出来的那份：实时会话 + 最近一次结算。⚠️ 只认"是这个待办"的那一份
    let (backend_paused, backend_interrupted, backend_times) = crate::focus::best_effort(
        &id,
        &[
            Some(crate::focus::snapshot()),
            crate::focus::settled_snapshot(),
        ],
    );

    let manual = manual_paused_seconds.unwrap_or(0);
    // 前端那份"总数"里属于后端类的部分 = 总数 − 手动（手动是前端自己数的，后端拿不到）
    let incoming_backend = paused_seconds.unwrap_or(0).saturating_sub(manual);

    let extra = PomodoroExtra {
        paused_seconds: incoming_backend.max(backend_paused) + manual,
        interrupted_seconds: interrupted_seconds.unwrap_or(0).max(backend_interrupted),
        interrupted_times: interrupted_times.unwrap_or(0).max(backend_times),
        voided: voided.unwrap_or(false),
    };
    let updated = with_store(&state, |store| {
        todo::add_pomodoro(store, &id, mode, seconds, note, finish, extra)
    })?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 「再次设定时间提醒」：`todo_schedule_remind`
///
/// 排一条 `Reminder{kind: todo-remind}`；到点由后台调度线程弹出来，
/// **首页动态区**随即出现（PRD 5.3 / 10.4）。
///
/// C 批（2026-10-02）起**一条待办可以排多条提醒** —— 靠 `key` 区分身份
/// （`at:<时间>` 手动那条、`early:<分钟>` 提前提醒；**老数据空 key 一律当手动那条**）。
/// 同一条待办的**同一个 key** 再设一次仍然是"改时间"，不会越排越多。
#[tauri::command]
pub fn todo_schedule_remind(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    fire_at: String,
    key: Option<String>,
    note: Option<String>,
) -> Result<Todo, String> {
    let updated = with_store(&state, |store| {
        let target = todo::list(store)?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("要提醒的待办不存在：{id}"))?;
        let made = reminder::schedule_todo_remind(
            store,
            &target,
            key.clone().unwrap_or_default(),
            fire_at.clone(),
            note.clone().unwrap_or_default(),
        )?;
        // ⚠️ 待办上那个 `reminderAt` 只留**最靠前**的那条（多条提醒的真源在 `reminders.json`，
        //    ⚙ 弹窗直接读它）—— 改 `reminderAt` 的语义会牵动别的界面，不值当。
        let soonest = made
            .iter()
            .map(|r| r.fire_at.clone())
            .min_by(|a, b| crate::models::iso_cmp(a, b).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or(fire_at);
        todo::set_reminder_at(store, &id, Some(soonest))
    })?;
    emit_data_changed(&app);
    Ok(updated)
}

/// 删掉**某一条**提醒：`reminder_delete`（C 批新增：多条提醒就得能一条一条删）
///
/// ⚠️ 只按 id 精确删那一条，**不碰**同一条待办上的其他提醒。
#[tauri::command]
pub fn reminder_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let removed = with_store(&state, |store| reminder::delete_one(store, &id))?;
    if removed {
        emit_data_changed(&app);
    }
    Ok(removed)
}

/// 这条待办现在排着哪些提醒：`reminder_for_todo`（C 批新增）
///
/// 前端 ⚙ 弹窗要画一张"已排的提醒"清单（每条一个 ✕），直接调它 ——
/// 省得前端自己去 `reminder_list` 里按 `refId` 过滤、还得自己判 `status`。
#[tauri::command]
pub fn reminder_for_todo(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<crate::models::Reminder>, String> {
    with_store(&state, |store| reminder::list_for_todo(store, &id))
}

/// 清掉所有「来源已移除」的待办：`todo_purge_removed`
///
/// 给用户一个收账的入口 —— 重复跑验收脚本会攒下一堆来源已经没了的待办，
/// 在那之前只能手工去改 `todos.json`（M4/M4.1 各手工清过一次）。
#[tauri::command]
pub fn todo_purge_removed(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let removed = with_store(&state, |store| todo::purge_removed(store))?;
    if removed > 0 {
        emit_data_changed(&app);
    }
    Ok(removed)
}

// ───────────────────────────── 同步数据层（M21 / v2.11.0） ─────────────────────────────

/// 设备状态（设备 id / 上次同步时间 / 协议版本）：`sync_state_get`
///
/// ⚠️ 第一次调用会**生成设备 id 并落盘**（`sync/state.json`）—— 手机和电脑各有一份，
/// 同步时用它区分"这份是谁的"（M23 用）。
#[tauri::command]
pub fn sync_state_get(state: State<'_, AppState>) -> Result<sync::SyncState, String> {
    with_store(&state, |store| sync::state_get(store))
}

/// **手机端发起一次同步**：`sync_client_now`
///
/// `target` 可以是二维码里那串（`moye-sync://IP:端口/令牌`），也可以是手输的 `IP:端口`；
/// 后者要配 `code`（6 位短码）。返回账单（补过来 / 传过去 / 冲突 / 删掉）。
///
/// ⚠️ 整条路都在**同一个 WiFi 的局域网**里走（协议 §3.2），不碰公网。
#[tauri::command]
pub fn sync_client_now(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: String,
    code: Option<String>,
) -> Result<crate::store::sync_proto::ClientOutcome, String> {
    // 🔴 2026-10-20（用户反馈「正文延迟」）：这一侧是**主动去拉**的一方，拉完自己就落地了 ——
    // 落地之后必须让界面重拉，否则"手机上改完、电脑上要重启才看见"。
    // （服务端那一侧的通知在 `store/sync_server.rs` 的 `/data` 分支里，走同一个回调。）
    let outcome = with_store(&state, |store| {
        let (base, cred) = crate::store::sync_proto::parse_manual(&target, code.as_deref())?;
        crate::store::sync_proto::run_client(store, &base, &cred)
    })?;
    emit_data_changed(&app);
    Ok(outcome)
}

/// 删除记录（墓碑）列表，新的在前：`sync_graves_list`
///
/// 每条只有 `id / deletedAt / kind`（**不含内容**）—— 界面与诊断用；真正的同步在 M23。
#[tauri::command]
pub fn sync_graves_list(state: State<'_, AppState>) -> Result<Vec<sync::Grave>, String> {
    with_store(&state, |store| sync::list(store))
}

/// 清空删除记录，返回清掉几条：`sync_graves_purge`
///
/// ⚠️ 这是**真删** → 照规矩先留档（`backups/同步-删除记录清空前-*.json`），留档失败就中止。
/// ⚠️ 清掉之后，"另一边已经删过的东西"可能被重新传回来 —— M23 的同步界面上要把这句写清楚。
#[tauri::command]
pub fn sync_graves_purge(state: State<'_, AppState>) -> Result<usize, String> {
    with_store(&state, |store| sync::purge(store))
}

// ───────────────────────────── 提醒 ─────────────────────────────

/// 提醒列表（新的在前）：`reminder_list`
#[tauri::command]
pub fn reminder_list(state: State<'_, AppState>) -> Result<Vec<Reminder>, String> {
    with_store(&state, |store| reminder::list(store))
}

/// 不再提醒：`reminder_dismiss`
#[tauri::command]
pub fn reminder_dismiss(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let done = with_store(&state, |store| reminder::dismiss(store, &id))?;
    if done {
        emit_data_changed(&app);
    }
    Ok(done)
}

/// 稍后提醒：`reminder_snooze`（默认 15 分钟）
#[tauri::command]
pub fn reminder_snooze(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    minutes: Option<u32>,
) -> Result<Option<Reminder>, String> {
    let updated =
        with_store(&state, |store| reminder::snooze(store, &id, minutes.unwrap_or(15)))?;
    if updated.is_some() {
        emit_data_changed(&app);
    }
    Ok(updated)
}

// ─────────────────────── 快捷小窗（M6） ───────────────────────
//
// 窗口的创建/显示/隐藏都在 Rust（`crate::window`），前端只发命令。
// 理由：全局快捷键的回调在 Rust 侧；而且前端直接调 `getCurrentWindow().hide()`
// 需要显式 ACL 权限（草笺踩过"漏配权限 → 点了没反应"）。
//
// ⚠️⚠️ **这几个命令必须是 `async fn`，不能是同步的**（M6 踩到的死锁，很值得记住）：
// Tauri 的**同步命令跑在主线程**上，而 `WebviewWindowBuilder::build()` 内部要
// `run_on_main_thread` 再**等主线程执行** —— 主线程正卡在这条命令里等 build 返回，
// build 又等主线程空出来，于是**互相等死**。
// 症状极具迷惑性：窗口对象建了一半（CDP 里能看到一个 `about:blank` 的 target）、
// 页面 JS 照跑（`Runtime.evaluate` 不走 IPC），但**从此所有 Tauri 命令都不再响应**
// （连只读的 `small_window_visible` 都超时），看起来像"应用整个卡死"。
// 改成 `async fn` 之后命令跑在 async runtime 线程上，投递到主线程就能被执行。
//
// ⚠️ M17（2.0.0）：小窗是**桌面专属**（手机上不建浮动窗）。下面的命令**函数保留、体内分平台**：
//    手机版调用会拿到一句明确中文错误，而不是"命令不存在"（前端不会因此整页报红）。

/// 唤起小窗：`small_window_show`
#[tauri::command]
pub async fn small_window_show(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::window::show_small_window(&app)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版没有「快捷小窗」".into())
    }
}

/// 收起**发这条命令的那个**小窗（**不销毁**，里面的草稿留着）：`small_window_hide`
///
/// 🔴 **2026-10-20 修用户反馈 #4「多开之后关不掉」**：这条命令原来收的是**写死的 1 号窗**
/// （`hide_small_window` 里 `get_webview_window(SMALL_LABEL)`），于是小窗自己的 Esc / ✕
/// 在 `small-2` 上按下去，收的是隔壁的 `small` —— 1 号早收起来了就「怎么按都不动」。
/// 现在改成收**调用方自己**：Tauri 会把发命令的那个 `WebviewWindow` 注进来，
/// **前端一个字都不用改**（`SmallWindow.tsx` 的 `close()` 照旧调 `smallWindowHide()`）。
/// ⚠️ `crate::window::hide_one_small_window` 里还有一道闸：**只认速记窗的 label**，
///    绝不会把主窗 / 专注窗 / 挂件收起来。
///
/// 收之前只给这个窗发 `small-window-hide`，它自己先把没保存的内容存掉。
#[tauri::command]
pub async fn small_window_hide(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let label = window.label().to_string();
        if crate::window::small_index_of(&label).is_some() {
            // 小窗自己按 Esc / ✕ → **只收它自己**
            crate::window::hide_one_small_window(&app, &label)
        } else {
            // 调用者不是小窗（主窗 / 专注窗 / 挂件，或**验收脚本从主窗调来清残留**）
            // → 收掉**所有**速记窗。老语义只收 1 号，多开之后「收全部」才是这句话的意思，
            // 也顺手把残留清干净。（2026-10-20：m6 的前置就是从主窗调这条来清窗的，
            // 那时如果直接报错，整套会崩在 ①。）
            crate::window::hide_all_small_windows(&app);
            Ok(())
        }
    }
    #[cfg(mobile)]
    {
        let _ = (app, window);
        Err("手机版没有「快捷小窗」".into())
    }
}

/// 🔴 **用户按一下快捷键 / 点一下 ⧉ / 点托盘那一项，统一走这里**：`small_window_bring_up`
///
/// 用户原话（2026-10-11）：「电脑版，发现快捷小窗无法多开……我点按 f9 出来一个小窗，再次点按，
/// 居然就把这小窗给删了」＋（问他时）「**想同时开好几个**」；
/// 2026-10-13 他实测后又补两条：① 「**多开小窗依旧失败**」② 「**我可以按好多次 f9，
/// 同时也出好多个小窗**」（还说明 `Ctrl+Space` 常年被「花笺」占着、他只能按 F9）。
///
/// ⇒ 所以规则统一成一条（三条入口不再分叉）：
/// 1. 有「藏着但还在」的速记窗 → 先把号最小的那个拉出来（**草稿还在**）；
/// 2. 没有藏着的 → 再开一个新的（1→[`crate::window::SMALL_MAX`] 号）；
/// 3. 号满了 → 把最后一个拿到最前。
/// 返回那个窗的 label（`small` / `small-2` / …），前端拿它做提示。
///
/// ⚠️ 老命令 `small_window_toggle`（开着就收、没开就弹）**已删** —— 它只碰 1 号窗，
/// 正是"按了没多开"的根源。
#[tauri::command]
pub async fn small_window_new(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        crate::window::bring_up_small_window(&app)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版没有「快捷小窗」".into())
    }
}

/// **把所有速记窗一次收起**：`small_window_hide_all`（2026-10-13 新增，托盘菜单用）
///
/// 快捷键语义改成「再给一个」之后，得补一条"怎么一次全收起来"的路 —— 不然用户按了 5 下
/// 想出 5 个窗、想收的时候只能一个个按 Esc。
/// ⚠️ **只收不销毁**：草稿都还在，再按快捷键会原样拉回来。
#[tauri::command]
pub async fn small_window_hide_all(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::window::hide_all_small_windows(&app);
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版没有「快捷小窗」".into())
    }
}

/// 小窗现在是不是可见：`small_window_visible`（**只读**，给验收脚本与设置页用）
///
/// 单独开一条只读命令，是因为"验证快捷键真的把小窗叫出来了"这件事
/// **不能靠 toggle 的返回值**（那会把窗口切走）。验收脚本要先发真实 Ctrl+Space，
/// 再来问一次"它现在可见吗"。
#[tauri::command]
pub fn small_window_visible(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        Ok(crate::window::small_visible(&app))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(false)
    }
}

/// 唤起小窗的快捷键状态：`shortcut_status`（**只读**，给设置页与验收脚本用）
///
/// 返回 `{ accelerator, registered, default }`。
/// `registered=false` 意味着"**这个键现在根本按不出来**"（被输入法或别的程序占了）——
/// 而这件事用户是看不见的，他只知道自己按了没反应，只会以为程序坏了。
/// 所以设置页要把它显示出来，验收脚本也拿它区分
/// "键没注册上"和"注册上了但没触发"（这是完全不同的两件事）。
#[tauri::command]
pub fn shortcut_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // 快捷键是**桌面专属**：手机版返回 `registered=false`（设置页据实显示"手机上没有这个键"），
    // 而不是报错 —— 设置页读到 JSON 就不会因为我们抛错而整块红掉。
    #[cfg(desktop)]
    {
        let accelerator = with_store(&state, |store| {
            Ok(config::load(store)
                .map(|cfg| cfg.shortcuts.toggle_small_window)
                .unwrap_or_else(|_| crate::shortcuts::DEFAULT_TOGGLE.to_string()))
        })?;
        let registered = crate::shortcuts::is_registered(&app, &accelerator);
        Ok(serde_json::json!({
            "accelerator": accelerator,
            "registered": registered,
            "default": crate::shortcuts::DEFAULT_TOGGLE,
        }))
    }
    #[cfg(mobile)]
    {
        let _ = (app, state);
        Ok(serde_json::json!({
            "accelerator": "",
            "registered": false,
            "default": "",
            "mobile": true,
        }))
    }
}

/// 清空回收站：`trash_purge`（**唯一真删笔记的地方**，界面上有二次确认兜着）
///
/// 返回删掉的文件个数。
#[tauri::command]
pub fn trash_purge(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let removed = with_store(&state, |store| note::purge_trash(store))?;
    if removed > 0 {
        emit_data_changed(&app);
    }
    Ok(removed)
}

// ─────────────────────── 备份导出 / 导入（M7） ───────────────────────

/// 导出备份：`backup_export`
///
/// `dest` 不传就用默认位置（`<数据目录>/backups/笔记备份-YYYY-MM-DD.zip`）；
/// 前端用文件对话框选过路径就传进来。
#[tauri::command]
pub fn backup_export(
    state: State<'_, AppState>,
    dest: Option<String>,
) -> Result<backup::BackupReport, String> {
    with_store(&state, |store| {
        let path = match dest.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => std::path::PathBuf::from(text),
            None => store
                .data_dir()
                .join("backups")
                .join(backup::default_file_name()),
        };
        backup::export(store, &path)
    })
}

/// 导入备份：`backup_import`
///
/// ⚠️ **会覆盖当前数据**，但导入的第一步就是**先把当前数据备份到 `backups/`**
/// （那一步失败就直接中止，宁可不导入也不冒丢数据的险）。
/// 前端必须先做二次确认再调它。
#[tauri::command]
pub fn backup_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    src: String,
) -> Result<backup::ImportReport, String> {
    let report = with_store(&state, |store| {
        backup::import(store, std::path::Path::new(src.trim()))
    })?;
    // 数据整个换了：让所有页面重新拉一遍
    emit_data_changed(&app);
    Ok(report)
}

// ─────────────────── 笔记导出 / 导入（M27 / v2.18.0）───────────────────
//
// 需求（用户 2026-10-07）：「欠着的 2、3 可以开干了」＋「电脑端也做导入导出功能吧」——
// ② 手机设置页的备份导入/导出（原来走 `plugin-dialog`，安卓上点了没反应）
// ③ 手机单篇导出只能复制到剪贴板 → 现在真的存成文件
// ④ 电脑端也有单篇导出 / 批量导出 / 导入 md
//
// 分平台的路子：
// - **电脑端**：`plugin-dialog` 的「另存为 / 打开」是好的 → 前端拿到路径，命令按路径读写；
// - **手机端**：dialog 在安卓上没实现 → 导出走 [`crate::android::save_to_downloads`]
//   （MediaStore 写进「下载/东方摩耶堂/」），导入走 `<input type=file>` + base64 传字节。
//
// 纯逻辑（文件名、树大纲、链接改写、导入解析）全在 [`crate::store::export`]，那边有单测。

/// 导出报告（前端拿它弹一句人话）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteExportReport {
    /// 主文件落到哪儿了（给人看的路径）
    pub file: String,
    /// 文件名主干
    pub stem: String,
    /// 一共写了几个文件（1 = 只有正文；>1 = 连图片一起）
    pub files: usize,
    /// 其中图片几张
    pub images: usize,
}

/// 批量导出报告
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesExportReport {
    pub dir: String,
    pub notes: usize,
    pub files: usize,
    pub images: usize,
    /// 导出的标题（前端列个摘要）
    pub titles: Vec<String>,
    /// 没导成的（标题 + 原因）—— 不许静默吞掉
    pub failed: Vec<String>,
}

/// 导入报告
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesImportReport {
    /// 导进来的笔记标题
    pub notes: Vec<String>,
    /// 连同收进来的图片张数
    pub images: usize,
    pub failed: Vec<String>,
}

/// 把一份内存里的 Markdown / 纯文本落成新笔记（Android 文件管理器打开时走这条）。
fn import_doc_bytes(store: &Store, fallback: &str, bytes: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| format!("文件不是 UTF-8 文本：{e}"))?;
    let (title, body) = export::parse_import(text, fallback);
    note::create_with_content(store, NoteKind::Doc, title.clone(), body)?;
    Ok(title)
}

/// 把 bundle 里的图片写到 `dir/<asset_dir>/` 下，返回（写了几张, 用到的图片名）
fn write_bundle_images(
    dir: &Path,
    asset_dir: &str,
    images: &[crate::store::export::OutFile],
) -> Result<(usize, Vec<String>), String> {
    if images.is_empty() {
        return Ok((0, Vec::new()));
    }
    let target = dir.join(asset_dir);
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("建图片目录失败（{}）：{e}", target.display()))?;
    let mut names = Vec::new();
    for image in images {
        let file_name = image
            .name
            .rsplit('/')
            .next()
            .unwrap_or("图片")
            .to_string();
        std::fs::write(target.join(&file_name), &image.bytes)
            .map_err(|e| format!("写图片失败（{}）：{e}", file_name))?;
        names.push(file_name);
    }
    Ok((images.len(), names))
}

/// 导出**一篇**到指定文件（电脑端「另存为」给的完整路径）：`note_export_file`
///
/// `format` 传 "md" / "txt"；`with_images` 为真时把用到的图复制到
/// **主文件旁边**的 `<文件名>.assets/`，并把正文里的链接改成相对路径（导出即自包含）。
#[tauri::command]
pub fn note_export_file(
    state: State<'_, AppState>,
    note_id: String,
    dest: String,
    format: String,
    with_images: bool,
) -> Result<NoteExportReport, String> {
    let format = export::Format::parse(&format)?;
    let dest = PathBuf::from(dest.trim());
    if dest.as_os_str().is_empty() {
        return Err("没有给导出路径".to_string());
    }
    with_store(&state, |store| {
        let note = note::get(store, &note_id)?
            .ok_or_else(|| "这篇笔记已经不在了（可能刚被删过）".to_string())?;
        let bundle = export::build_bundle(store, &note, format, with_images)?;
        let dir = dest
            .parent()
            .filter(|one| !one.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("建导出目录失败（{}）：{e}", dir.display()))?;

        // 用户可能在「另存为」里改了文件名 → 附件文件夹和正文链接都跟着改
        let stem = dest
            .file_stem()
            .map(|one| one.to_string_lossy().to_string())
            .filter(|one| !one.trim().is_empty())
            .unwrap_or_else(|| bundle.stem.clone());
        let asset_dir = format!("{stem}.assets");
        let (images, names) = write_bundle_images(&dir, &asset_dir, &bundle.images)?;
        let mut text = String::from_utf8_lossy(&bundle.main.bytes).to_string();
        if !names.is_empty() && asset_dir != bundle.asset_dir {
            text = export::rewrite_in(&text, &bundle.asset_dir, &names);
            text = export::rewrite_out(&text, &asset_dir, &names);
        }
        std::fs::write(&dest, text.as_bytes())
            .map_err(|e| format!("写文件失败（{}）：{e}", dest.display()))?;
        Ok(NoteExportReport {
            file: dest.to_string_lossy().to_string(),
            stem,
            files: 1 + images,
            images,
        })
    })
}

/// 批量导出到**一个文件夹**：`notes_export_dir`
///
/// `note_ids` 不传 = 整个认知区。每篇一个 `<标题>.md`（重名会加 `-2`），
/// 图片放各自的 `<标题>.assets/`（和单篇导出同一套规则）。
#[tauri::command]
pub fn notes_export_dir(
    state: State<'_, AppState>,
    note_ids: Option<Vec<String>>,
    dir: String,
    format: String,
    with_images: bool,
) -> Result<NotesExportReport, String> {
    let format = export::Format::parse(&format)?;
    let dir = PathBuf::from(dir.trim());
    if dir.as_os_str().is_empty() {
        return Err("没有给导出文件夹".to_string());
    }
    with_store(&state, |store| {
        let picked: Vec<Note> = match note_ids.as_ref().filter(|one| !one.is_empty()) {
            Some(ids) => {
                let mut out = Vec::new();
                for id in ids {
                    if let Some(note) = note::get(store, id)? {
                        out.push(note);
                    }
                }
                out
            }
            None => note::list(store)?,
        };
        if picked.is_empty() {
            return Err("没有可导出的笔记".to_string());
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("建导出文件夹失败（{}）：{e}", dir.display()))?;

        let mut titles = Vec::new();
        let mut failed = Vec::new();
        let mut files = 0usize;
        let mut images = 0usize;
        let mut used: Vec<String> = Vec::new();

        for note in &picked {
            let label = if note.title.trim().is_empty() {
                "未命名笔记".to_string()
            } else {
                note.title.trim().to_string()
            };
            let bundle = match export::build_bundle(store, note, format, with_images) {
                Ok(one) => one,
                Err(e) => {
                    failed.push(format!("{label}：{e}"));
                    continue;
                }
            };
            // 重名（两篇都叫「随手记」）→ 加 -2 / -3，别互相覆盖
            let mut stem = bundle.stem.clone();
            let mut index = 2;
            while used.contains(&stem) {
                stem = format!("{}-{index}", bundle.stem);
                index += 1;
            }
            used.push(stem.clone());

            let asset_dir = format!("{stem}.assets");
            let (wrote_images, names) = match write_bundle_images(&dir, &asset_dir, &bundle.images) {
                Ok(pair) => pair,
                Err(e) => {
                    failed.push(format!("{label}：{e}"));
                    continue;
                }
            };
            let mut text = String::from_utf8_lossy(&bundle.main.bytes).to_string();
            if !names.is_empty() && asset_dir != bundle.asset_dir {
                text = export::rewrite_in(&text, &bundle.asset_dir, &names);
                text = export::rewrite_out(&text, &asset_dir, &names);
            }
            let target = dir.join(format!("{stem}.{}", format.ext()));
            if let Err(e) = std::fs::write(&target, text.as_bytes()) {
                failed.push(format!("{label}：写文件失败（{e}）"));
                continue;
            }
            files += 1 + wrote_images;
            images += wrote_images;
            titles.push(label);
        }

        Ok(NotesExportReport {
            dir: dir.to_string_lossy().to_string(),
            notes: titles.len(),
            files,
            images,
            titles,
            failed,
        })
    })
}

/// 导入若干 `.md` / `.txt`（电脑端「打开」对话框给的是路径）：`notes_import_files`
///
/// 每个文件 → **一篇新笔记**（标题取第一行 `# `，没有就用文件名；正文原样存，
/// 里面的 `-[]` 行会被后端顺手同步成待办）。
/// 如果文件旁边有同名附件夹 `<文件名>.assets/`（就是导出时生成的那种），
/// 里面的图会**收进数据目录的 `assets/`** 并把链接改回去 —— 导出再导入能原样回来。
#[tauri::command]
pub fn notes_import_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<NotesImportReport, String> {
    if paths.is_empty() {
        return Err("没有选文件".to_string());
    }
    let report = with_store(&state, |store| {
        let mut titles = Vec::new();
        let mut failed = Vec::new();
        let mut images = 0usize;

        for raw in &paths {
            let path = PathBuf::from(raw.trim());
            let fallback = export::title_from_file_name(&path.to_string_lossy());
            let text = match std::fs::read_to_string(&path) {
                Ok(one) => one,
                Err(e) => {
                    failed.push(format!("{fallback}：读不了这个文件（{e}）"));
                    continue;
                }
            };
            let (title, mut body) = export::parse_import(&text, &fallback);

            // 旁边的同名附件夹（导出时生成的 `<文件名>.assets/`）→ 收进 assets/
            let stem = path
                .file_stem()
                .map(|one| one.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut got: Vec<String> = Vec::new();
            if !stem.is_empty() {
                let sibling = path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(format!("{stem}.assets"));
                if sibling.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(&sibling) {
                        for entry in entries.flatten() {
                            let file = entry.path();
                            if !file.is_file() {
                                continue;
                            }
                            let name = file
                                .file_name()
                                .map(|one| one.to_string_lossy().to_string())
                                .unwrap_or_default();
                            if !assets::name_ok(&name) {
                                continue;
                            }
                            match std::fs::read(&file)
                                .map_err(|e| e.to_string())
                                .and_then(|bytes| assets::save_incoming(store, &name, &bytes))
                            {
                                Ok(_) => {
                                    got.push(name);
                                    images += 1;
                                }
                                Err(e) => {
                                    failed.push(format!("{title}：图片 {name} 没收进来（{e}）"))
                                }
                            }
                        }
                    }
                    if !got.is_empty() {
                        body = export::rewrite_in(&body, &format!("{stem}.assets"), &got);
                    }
                }
            }

            match note::create_with_content(store, NoteKind::Doc, title.clone(), body) {
                Ok(_) => titles.push(title),
                Err(e) => failed.push(format!("{title}：{e}")),
            }
        }

        Ok(NotesImportReport {
            notes: titles,
            images,
            failed,
        })
    })?;
    if !report.notes.is_empty() {
        emit_data_changed(&app);
    }
    Ok(report)
}

/// Android 文件管理器「用东方摩耶堂打开」：读取 Kotlin 队列里的文本内容并导入。
///
/// Kotlin 侧在 `onCreate` / `onNewIntent` 抓到文件后先放进内存队列；前端定时调这个命令取走，
/// 所以无论应用原来没启动、在后台、还是已经开着，都能导入。每个文件仍是一篇**新笔记**。
#[tauri::command]
pub fn notes_import_android_pending(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<NotesImportReport, String> {
    let raw = crate::android::take_pending_imports()?;
    let pending: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| format!("安卓导入队列格式不对：{e}"))?;
    if pending.is_empty() {
        return Ok(NotesImportReport {
            notes: Vec::new(),
            images: 0,
            failed: Vec::new(),
        });
    }

    use base64::Engine;
    let report = with_store(&state, |store| {
        let mut titles = Vec::new();
        let mut failed = Vec::new();
        for one in &pending {
            let name = one
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("导入的笔记.md");
            let encoded = one
                .get("dataBase64")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let fallback = export::title_from_file_name(name);
            match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(bytes) => match import_doc_bytes(store, &fallback, &bytes) {
                    Ok(title) => titles.push(title),
                    Err(e) => failed.push(format!("{fallback}：{e}")),
                },
                Err(e) => failed.push(format!("{fallback}：文件内容解码失败（{e}）")),
            }
        }
        Ok(NotesImportReport {
            notes: titles,
            images: 0,
            failed,
        })
    })?;
    if !report.notes.is_empty() {
        emit_data_changed(&app);
    }
    Ok(report)
}

/// 手机：导出**一篇**到「下载/东方摩耶堂/」：`note_export_downloads`
#[tauri::command]
pub fn note_export_downloads(
    state: State<'_, AppState>,
    note_id: String,
    format: String,
    with_images: bool,
) -> Result<NoteExportReport, String> {
    let format = export::Format::parse(&format)?;
    with_store(&state, |store| {
        let note = note::get(store, &note_id)?
            .ok_or_else(|| "这篇笔记已经不在了（可能刚被删过）".to_string())?;
        let bundle = export::build_bundle(store, &note, format, with_images)?;
        let file = crate::android::save_to_downloads(
            "",
            &bundle.main.name,
            &bundle.main.mime,
            &bundle.main.bytes,
        )?;
        let mut images = 0usize;
        for image in &bundle.images {
            let name = image.name.rsplit('/').next().unwrap_or("图片");
            crate::android::save_to_downloads(&bundle.asset_dir, name, &image.mime, &image.bytes)?;
            images += 1;
        }
        Ok(NoteExportReport {
            file,
            stem: bundle.stem,
            files: 1 + images,
            images,
        })
    })
}

/// 手机：把整库备份导出到「下载/东方摩耶堂/」：`backup_export_downloads`
///
/// 先在临时目录打 zip（复用 [`backup::export`] 那条成熟的路），再把字节交给安卓出口。
#[tauri::command]
pub fn backup_export_downloads(state: State<'_, AppState>) -> Result<NoteExportReport, String> {
    with_store(&state, |store| {
        let name = backup::default_file_name();
        let tmp = std::env::temp_dir().join(&name);
        let report = backup::export(store, &tmp)?;
        let bytes = std::fs::read(&tmp).map_err(|e| format!("读临时备份失败：{e}"))?;
        let _ = std::fs::remove_file(&tmp);
        let file = crate::android::save_to_downloads("", &name, "application/zip", &bytes)?;
        Ok(NoteExportReport {
            file,
            stem: name,
            files: report.files,
            images: 0,
        })
    })
}

/// 手机：从字节导入备份（`<input type=file>` 选 zip → base64）：`backup_import_bytes`
///
/// ⚠️ **会覆盖当前数据** —— 前端必须先二次确认；`backup::import` 自己第一步就把
/// 当前数据留档到 `backups/`（那一步失败就中止，宁可不导入也不冒丢数据的险）。
#[tauri::command]
pub fn backup_import_bytes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    data_base64: String,
) -> Result<backup::ImportReport, String> {
    use base64::Engine as _;
    let raw = data_base64.trim();
    // 前端可能顺手把 dataURL 前缀也带过来，容错一下（和 asset_write_image 一个写法）
    let payload = raw.split_once(',').map(|(_, tail)| tail).unwrap_or(raw);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("备份文件解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("这个备份文件是空的".to_string());
    }
    // 落到临时文件再走成熟的那条 import（不为了省一个临时文件去改它）
    let tmp = std::env::temp_dir().join(format!(
        "moyetang-import-{}-{}.zip",
        std::process::id(),
        chrono::Local::now().format("%H%M%S")
    ));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
    let result = with_store(&state, |store| backup::import(store, &tmp));
    let _ = std::fs::remove_file(&tmp);
    let report = result?;
    // 数据整个换了：让所有页面重新拉一遍
    emit_data_changed(&app);
    Ok(report)
}

// ─────────────────────── 关于 / 数据统计（M7） ───────────────────────

/// 关于：版本 + 数据统计：`app_info`
///
/// PRD §5.5 的「关于」要三样东西：版本、信息/笔记/待办条数。
/// 版本从 `package_info()` 拿（就是 `tauri.conf.json` 的 version），
/// 不在前端硬编码 —— 免得改了版本号两边对不上。
#[tauri::command]
pub fn app_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let info = app.package_info();
    let (infos, notes, todos, assets) = with_store(&state, |store| {
        let infos = info::read_all(store)?.len();
        let notes = note::list(store)?.len();
        let todos = todo::list(store)?.len();
        // 附件个数与占用：顺手统计，用户关心"图片占多少空间"（PRD §8 风险表提过）
        let assets_dir = store.data_dir().join("assets");
        let mut count = 0usize;
        let mut bytes = 0u64;
        if let Ok(entries) = std::fs::read_dir(&assets_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        count += 1;
                        bytes += meta.len();
                    }
                }
            }
        }
        Ok((infos, notes, todos, (count, bytes)))
    })?;

    Ok(serde_json::json!({
        "name": info.name,
        "version": info.version.to_string(),
        "infoCount": infos,
        "noteCount": notes,
        "todoCount": todos,
        "assetCount": assets.0,
        "assetBytes": assets.1,
        "dataDir": data_dir_string(&state)?,
    }))
}

// ───────────────────────────── 其它 ─────────────────────────────

/// 退出程序：`quit_app`
///
/// 为什么不直接让前端调 `getCurrentWindow().close()`：
/// Tauri 2 的 `core:default` 只含只读的窗口权限，`close()` 需要显式声明
/// `core:window:allow-close`，漏配就会被 ACL 拒绝（表现为"点 quit 没反应"）。
/// 走 Rust 的 `exit` 不依赖窗口权限，而且以后要"退出前先保存"也在这里做。
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ─────────────────────── 开机自启（M10-6） ───────────────────────
//
// ⚠️ M17（2.0.0）：**开机自启是桌面专属**（手机上没有"注册表 Run 项"这种东西，
//    应用的启停由系统管）。下面两条函数保留、体内分平台：手机版读状态返回 false
//    （设置页据此显示成"关"），设定直接给一句明确错误。

/// 现在有没有设开机自启：`autostart_get`
///
/// 读的是系统里的真实状态（Windows 是注册表的 Run 项），不是我们自己的配置 ——
/// 用户可能在"任务管理器 → 启动"里把它关掉，界面上要如实显示。
#[tauri::command]
pub fn autostart_get(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|e| format!("读开机自启状态失败：{e}"))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(false)
    }
}

/// 开/关开机自启：`autostart_set`（返回设置完之后的真实状态，让界面据实显示）
#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        let done = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        done.map_err(|e| format!("设置开机自启失败：{e}"))?;
        manager
            .is_enabled()
            .map_err(|e| format!("设置完读回状态失败：{e}"))
    }
    #[cfg(mobile)]
    {
        let _ = (app, enabled);
        Err("手机版没有「开机自启」这个设置（应用启停由系统管）".into())
    }
}

// ─────────────────────── 每日报告（M11-A） ───────────────────────
//
// ⚠️ 这三条**有意不广播 `data-changed`**：日报只在一个页面（日程）里显示，
//    命令把最新的 `DailyReport` 直接返回来、页面就地更新就好。
//    广播会把六个页面全部重拉一遍（`info_list` / `note_list` / `todo_list` …），白白多跑一趟 ——
//    和 `note_save` 那个"有意放宽"是同一个理由（见进度.md 第四节）。

/// 读某一天的日报（**只含用户手写的那部分**）：`daily_get`
///
/// 「完成了哪些 / 设计了哪些 / 填写了哪些」三类是前端从 `todos` / `infos` **实时算**的，
/// 不在这里存（同一个事实两个来源，迟早对不上）。
/// 没写过也返回空壳（`notes: []`），前端不用判 `null`。
#[tauri::command]
pub fn daily_get(state: State<'_, AppState>, date: String) -> Result<dailies::DailyReport, String> {
    with_store(&state, |store| dailies::load(store, &date))
}

/// 写 / 改某一天的一条说明：`daily_note_set`
///
/// `text` 去掉首尾空白后为空 = **把这一条删掉**。
/// `key` 是 `todo:<待办 id>` / `info:<信息 id>` / `day`（当天小结），见 `dailies::DailyNote`。
#[tauri::command]
pub fn daily_note_set(
    state: State<'_, AppState>,
    date: String,
    key: String,
    text: String,
) -> Result<dailies::DailyReport, String> {
    with_store(&state, |store| dailies::set_note(store, &date, &key, &text))
}

/// 导出某一天的日报成 txt：`daily_export`
///
/// 正文由**前端**拼好传进来（它手上才有算好的三类内容 + 手写说明），这里只管落盘。
/// `dest` 不传就写到 `<数据目录>/dailies/<日期>-日报.txt`。
/// 返回最终写出的路径，前端拿它显示"导出到哪了"。
#[tauri::command]
pub fn daily_export(
    state: State<'_, AppState>,
    date: String,
    content: String,
    dest: Option<String>,
) -> Result<String, String> {
    with_store(&state, |store| {
        let path = match dest.as_deref().map(str::trim).filter(|one| !one.is_empty()) {
            Some(text) => std::path::PathBuf::from(text),
            None => {
                let day = dailies::normalize_date(&date)?;
                dailies::dir(store).join(format!("{day}-日报.txt"))
            }
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败：{e}"))?;
        }
        // 写文件一律走原子写（临时文件 → fsync → 替换），别直接 fs::write
        atomic::atomic_write_str(&path, &content).map_err(|e| format!("写日报失败：{e}"))?;
        Ok(path.to_string_lossy().to_string())
    })
}

// ─────────────────────── 奖状 / 证书（M12-A） ───────────────────────
//
// ⚠️ 和日报那三条一样，**有意不广播 `data-changed`**：奖状只在技能区一个页面里显示，
//    命令把最新的对象返回来、页面就地更新就够了（广播会让六个页面全部重拉一遍）。
//    和 `note_save` 那个"有意放宽"同一个理由（见进度.md 第四节）。

/// 全部奖状：`award_list`
///
/// **原样按文件顺序**返回（= 加入顺序）；"按年份分段 + 置顶最前"是界面自己的事
/// （`features/skills/awards.ts`），排序只放在一处做。
#[tauri::command]
pub fn award_list(state: State<'_, AppState>) -> Result<Vec<Award>, String> {
    with_store(&state, awards::list)
}

/// 新建一张：`award_create`（**只要一个标题就能建** —— 没图也能建，这是这块"轻松上手"的核心）
#[tauri::command]
pub fn award_create(state: State<'_, AppState>, title: String) -> Result<Award, String> {
    with_store(&state, |store| awards::create(store, title))
}

/// 改一张：`award_set`
///
/// **不传的字段一律不动**（`Option`）；这几个字段传**空串 = 清空**那一格。
/// 没有"整条覆盖"——和 `todo` / `tree` 一样是操作式的。
#[tauri::command]
pub fn award_set(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    issuer: Option<String>,
    date: Option<String>,
    note: Option<String>,
    asset_path: Option<String>,
    pinned: Option<bool>,
) -> Result<Award, String> {
    let patch = awards::AwardPatch {
        title,
        issuer,
        date,
        note,
        asset_path,
        pinned,
    };
    with_store(&state, |store| awards::set(store, &id, patch))
}

/// 删一张：`award_delete`（**真删**；先留档，留档失败就中止删除）
#[tauri::command]
pub fn award_delete(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    with_store(&state, |store| awards::delete(store, &id))
}

// ─────────────────────── 格言与原则（M12-C） ───────────────────────
//
// ⚠️ 同奖状 / 日报：**有意不广播 `data-changed`**（只在一个页面里显示，命令直接返回最新对象就地更新）。

/// 全部格言 / 原则：`motto_list`（原样按文件顺序 = 加入顺序）
#[tauri::command]
pub fn motto_list(state: State<'_, AppState>) -> Result<Vec<Motto>, String> {
    with_store(&state, mottos::list)
}

/// 新建一条：`motto_create`（**只要那句话**；`kind` 不传就当"自己的原则"）
#[tauri::command]
pub fn motto_create(
    state: State<'_, AppState>,
    text: String,
    kind: Option<MottoKind>,
) -> Result<Motto, String> {
    with_store(&state, |store| mottos::create(store, text, kind))
}

/// 改一条：`motto_set`（**不传的字段一律不动**；`from` 传空串 = 清掉出处）
#[tauri::command]
pub fn motto_set(
    state: State<'_, AppState>,
    id: String,
    text: Option<String>,
    from: Option<String>,
    kind: Option<MottoKind>,
) -> Result<Motto, String> {
    let patch = mottos::MottoPatch { text, from, kind };
    with_store(&state, |store| mottos::set(store, &id, patch))
}

/// 删一条：`motto_delete`（**真删**；先留档，留档失败就中止删除）
#[tauri::command]
pub fn motto_delete(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    with_store(&state, |store| mottos::delete(store, &id))
}

// ─────────────────────── 倒计时（2026-10-04 · V2 打磨） ───────────────────────
//
// ⚠️ 这一族**要广播 `data-changed`**（跟 mottos / awards 那种"只在一个页面显示"的不一样）：
//    倒计时同时出现在**日程页的月视图**和**桌面挂件**两个窗口里，不广播的话挂件不会跟着变。

/// 全部倒计时：`countdown_list`（原样按文件顺序；"按日期从近到远"是界面的事）
#[tauri::command]
pub fn countdown_list(state: State<'_, AppState>) -> Result<Vec<Countdown>, String> {
    with_store(&state, |store| countdown::list(store))
}

/// 新建一个倒计时：`countdown_create`（`date` 必须是 `YYYY-MM-DD` 的真日子）
#[tauri::command]
pub fn countdown_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: String,
    date: String,
    note: Option<String>,
) -> Result<Countdown, String> {
    let one = with_store(&state, |store| countdown::create(store, title, date, note))?;
    emit_data_changed(&app);
    Ok(one)
}

/// 改一个：`countdown_update`（**不传的字段一律不动**；`onWidget=false` = 从挂件上拿掉）
#[tauri::command]
pub fn countdown_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    date: Option<String>,
    note: Option<String>,
    on_widget: Option<bool>,
) -> Result<Countdown, String> {
    let patch = countdown::CountdownPatch {
        title,
        date,
        note,
        on_widget,
    };
    let one = with_store(&state, |store| countdown::set(store, &id, patch))?;
    emit_data_changed(&app);
    Ok(one)
}

/// 删一个：`countdown_delete`（**真删**；先留档，留档失败就中止删除）
#[tauri::command]
pub fn countdown_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let done = with_store(&state, |store| countdown::delete(store, &id))?;
    emit_data_changed(&app);
    Ok(done)
}

// ─────────────────────── 批注（M14-B） ───────────────────────
//
// ⚠️ 批注跟着**某一篇笔记的正文**走：认知区那边要跟着刷新，所以这四条**照常广播
//    `data-changed`**（和 `motto_*` / `award_*` 那种"只在一个页面里显示"的不一样）。

/// 全部批注：`anno_list`（原样按文件顺序；按哪篇筛是前端的事）
#[tauri::command]
pub fn anno_list(state: State<'_, AppState>) -> Result<Vec<Annotation>, String> {
    with_store(&state, annotations::list)
}

/// 新建一条批注：`anno_create`
///
/// `quote` = 引的那句原文（照原样传，别 trim）、`prefix` / `suffix` = 原句前后各 12 字、
/// `hash` = 句子内容的哈希 —— 这三样就是锚点，**由前端算好传进来**（后端不解析正文）。
/// `id` / `createdAt` 由后端生成。`quote` 与 `text` 都不能是空的。
#[tauri::command]
pub fn anno_create(
    state: State<'_, AppState>,
    note_id: String,
    quote: String,
    prefix: String,
    suffix: String,
    hash: String,
    text: String,
) -> Result<Annotation, String> {
    let one = with_store(&state, |store| {
        annotations::create(store, note_id, quote, prefix, suffix, hash, text)
    })?;
    // ⚠️ **有意不广播 `data-changed`**：批注与 `motto_*` / `award_*` / `daily_*` 同族
    //    （那一族不广播，见第四节），认知区侧栏自己管自己的刷新。
    Ok(one)
}

/// 改一条批注的正文：`anno_set`
///
/// ⚠️ **只允许改正文**，别的一律不许动 —— 锚点（`quote` / `prefix` / `suffix` / `hash`）
/// 与 `noteId` 都是算出来的，改它们等于把批注指到别处去。
/// `text` 不传 = 不动；传空串 = **拒绝**（批注不能没有正文，要删就删掉这条）。
#[tauri::command]
pub fn anno_set(
    state: State<'_, AppState>,
    id: String,
    text: Option<String>,
) -> Result<Annotation, String> {
    let patch = annotations::AnnotationPatch { text };
    // 同上一族：不广播（侧栏自己刷新）
    with_store(&state, |store| annotations::set(store, &id, patch))
}

/// 删一条批注：`anno_delete`（**真删**；先留档，留档失败就中止删除）
#[tauri::command]
pub fn anno_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    // 同上一族：不广播（侧栏自己刷新）
    with_store(&state, |store| annotations::delete(store, &id))
}
// ─────────────────────── 隐藏档案库（M15） ───────────────────────
//
// ⚠️ 同 `motto_*` / `award_*` / `daily_*` / `anno_*` 那一族：**有意不广播 `data-changed`**
//    （档案库只在自己那个页面里显示，命令把最新的对象返回来、页面就地更新就够了；
//    广播会让六个页面全部重拉一遍）。见第四节那条"广播的例外"。
//
// ⚠️ 入口受 `config.archive.enabled` 控制（M14-B 已经建好的开关，**默认 false**）：
//    关着时侧栏没有「档案库」，这七条命令也不会被调到。
//
// ⚠️ 为什么就地改内容**不复用** `info_update` / `todo_*`：那些命令动的是**原区的文件**
//    （`info.jsonl` / `todos.json`），而收进档案库的那条**已经不在原区了** ——
//    所以就地改走 `archive_patch` / `archive_note_save`（改的是档案里那一份快照）。

/// 读整个档案库：`archive_list`
///
/// 量小，一次全读完（原样按文件顺序 = 收纳顺序）；搜索 / 筛选 / 排序是界面自己的事。
#[tauri::command]
pub fn archive_list(state: State<'_, AppState>) -> Result<Vec<ArchiveEntry>, String> {
    with_store(&state, archive::list)
}

/// 把一条东西**收进档案库**：`archive_put`（`kind` = `info` / `note` / `todo`）
///
/// **收走后原位就没了**（收纳 = 从原位拿走）：信息从 `info.jsonl` 里删、待办从 `todos.json`
/// 里删、笔记的文件挪进 `notes/_archive/`。存进去的是**整条快照**（不是光一个标题）。
/// `note` 是给这条档案写的一句话（可空）。
#[tauri::command]
pub fn archive_put(
    state: State<'_, AppState>,
    kind: String,
    source_id: String,
    note: String,
) -> Result<ArchiveEntry, String> {
    with_store(&state, |store| archive::put(store, &kind, &source_id, &note))
}

/// **新建一条自由档案**：`archive_create`（2026-10-11 · 用户反馈第 2 条，v2.21.0）
///
/// 「打开档案区后，没有创建档案的选项」＋「两个方案都要有」→ 除了"从别处收进来"（`archive_put`），
/// 再加"直接在档案库里新建"。建出来的这条**没有原位**，所以 `archive_restore` 会拒绝它
/// （拿不出来），但能就地改（`archive_patch`）与删（`archive_delete`）。
#[tauri::command]
pub fn archive_create(
    state: State<'_, AppState>,
    title: String,
    content: String,
) -> Result<ArchiveEntry, String> {
    with_store(&state, |store| archive::create(store, &title, &content))
}

/// **取出**：按快照放回原来的区（**原 id 与时间原样保留**），并从档案库里删掉这条：`archive_restore`
#[tauri::command]
pub fn archive_restore(state: State<'_, AppState>, id: String) -> Result<ArchiveEntry, String> {
    with_store(&state, |store| archive::restore(store, &id))
}

/// 改这条档案的**备注 / 标题**：`archive_set`（**不传的不动**；备注传空串 = 清掉那一格）
#[tauri::command]
pub fn archive_set(
    state: State<'_, AppState>,
    id: String,
    note: Option<String>,
    title: Option<String>,
) -> Result<ArchiveEntry, String> {
    with_store(&state, |store| archive::set(store, &id, note, title))
}

/// **就地改**档案里那条的内容：`archive_patch`
///
/// `patch` 是**快照里的字段 patch**（一个 JSON 对象），只改传进来的键、别的键一个不动；
/// `title` / `summary` 跟着新快照重算。用户 2026-09-27 拍板：「档案里能直接改」。
#[tauri::command]
pub fn archive_patch(
    state: State<'_, AppState>,
    id: String,
    patch: serde_json::Value,
) -> Result<ArchiveEntry, String> {
    with_store(&state, |store| archive::patch_snapshot(store, &id, patch))
}

/// 档案里那篇笔记的标题 / 正文保存：`archive_note_save`（写回 `notes/_archive/<id>.json`）
///
/// 正文**一个字都不改**（用户手写的，照原样存）；`root` / `group` / `sourceInfoIds`
/// 这些别的字段一个不动。
#[tauri::command]
pub fn archive_note_save(
    state: State<'_, AppState>,
    id: String,
    title: String,
    content: String,
) -> Result<ArchiveEntry, String> {
    with_store(&state, |store| {
        archive::save_archived_note(store, &id, title, content)
    })
}

/// 彻底删掉一条档案：`archive_delete`（**真删**；先留档，留档失败就中止）
#[tauri::command]
pub fn archive_delete(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    with_store(&state, |store| archive::delete(store, &id))
}

// ─────────────────────── 专注小窗（M13-A） ───────────────────────
//
// 🔴 建窗的这两条**必须是 `async fn`** —— 同步命令跑在主线程，而 `WebviewWindowBuilder::build()`
//    要把活投递到主线程再等结果，**互相等死**（M6 那次"应用看起来整个卡死"就是这么来的）。

/// 弹出专注小窗（待办点「开始」时调）：`focus_window_open`
///
/// `tooltip` 是同时写到托盘上的那行字（例如「东方摩耶堂 · 专注中：把设计稿定下来」）。
#[tauri::command]
pub async fn focus_window_open(
    app: tauri::AppHandle,
    tooltip: Option<String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::window::show_focus_window(&app)?;
        crate::tray::set_tooltip(&app, tooltip.as_deref());
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (app, tooltip);
        Err("手机版没有「置顶专注小窗」（专注界面在应用内）".into())
    }
}

/// 收起专注小窗（结束 / 取消时调）：`focus_window_close`；托盘 tooltip 复原
#[tauri::command]
pub async fn focus_window_close(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::window::hide_focus_window(&app)?;
        crate::tray::set_tooltip(&app, None);
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版没有「置顶专注小窗」".into())
    }
}

/// 专注小窗现在开着吗：`focus_window_visible`（只读，验收脚本用）
#[tauri::command]
pub fn focus_window_visible(app: tauri::AppHandle) -> bool {
    #[cfg(desktop)]
    {
        crate::window::focus_visible(&app)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        false
    }
}

/// 换托盘的那行字（专注中 / 暂停中 / 疑似离开）：`focus_tray_set`
#[tauri::command]
pub fn focus_tray_set(app: tauri::AppHandle, tooltip: Option<String>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::tray::set_tooltip(&app, tooltip.as_deref());
        Ok(())
    }
    #[cfg(mobile)]
    {
        // 手机版没有托盘 → 这行字没地方显示。**不报错**：它是"顺手更新一下"的调用，
        // 失败会把专注流程打断（前端 await 着它）。
        let _ = (app, tooltip);
        Ok(())
    }
}

// ─────────────────────── 桌面挂件（E 批，2026-10-03） ───────────────────────
//
// 🔴 建窗这两条也**必须是 `async fn`**，理由同上面专注小窗那两条（同步会互相等死）。

/// 显示桌面挂件（设置里打开开关 / 托盘菜单点「显示挂件」）：`widget_open`
#[tauri::command]
pub async fn widget_open(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::window::show_widget_window(&app)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版没有「桌面挂件」".into())
    }
}

/// 收起桌面挂件（挂件上的 ✕ 或托盘菜单）：`widget_close`
///
/// ⚠️ 只收窗口、**不改配置**：开关状态只由设置页那一处管 ——
/// 这样"我先把挂件收一下"不会被记成"我把这个功能关了"。
#[tauri::command]
pub async fn widget_close(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::window::hide_widget_window(&app)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("手机版没有「桌面挂件」".into())
    }
}

/// 唤回主窗口（挂件点了条目时调）：`main_show`
///
/// 复用 `tray::show_main`（show + unminimize + set_focus 三步都在里面）——
/// 挂件可能盖在主窗上面，用户点了当然是**想看主窗**。
#[tauri::command]
pub fn main_show(app: tauri::AppHandle) {
    #[cfg(desktop)]
    {
        // 桌面：复用 `tray::show_main`（show + unminimize + set_focus 三步都在里面）
        crate::tray::show_main(&app);
    }
    #[cfg(mobile)]
    {
        // 手机版没有托盘、也没有"最小化到托盘"这回事 —— 应用已经在前台，什么都不用做。
        let _ = app;
    }
}

/// 挂件现在开着吗：`widget_visible`（只读，验收脚本用）
#[tauri::command]
pub fn widget_visible(app: tauri::AppHandle) -> bool {
    #[cfg(desktop)]
    {
        crate::window::widget_visible(&app)
    }
    #[cfg(mobile)]
    {
        let _ = app;
        false
    }
}

/// 按最新配置**重新摆一次**挂件：`widget_apply`
/// （设置里改了开关 / 尺寸 / 置顶 / 显示哪几格之后调）
///
/// 语义一句话：配置里 `enabled=false` → 收起来；`true` → 显示（位置记忆照旧）。
#[tauri::command]
pub async fn widget_apply(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // ⚠️ 这里是 `async fn`（建窗必须异步，理由见上面专注小窗那段），
        //    所以拿不到 `State<'_, AppState>` 那种借用 —— 从 `app` 里取 state 再用。
        let state = app.state::<AppState>();
        let enabled = with_store(&state, |store| {
            Ok(config::load(store)
                .map(|cfg| cfg.widget.enabled)
                .unwrap_or(false))
        })?;
        if enabled {
            crate::window::show_widget_window(&app)
        } else {
            crate::window::hide_widget_window(&app)
        }
    }
    #[cfg(mobile)]
    {
        // 手机版没有桌面挂件：配置照存（同步到电脑后那边照它摆），这边什么都不做。
        let _ = app;
        Ok(())
    }
}

// ─────────────────── 专注 ·「意外中断」判定（M13-B） ───────────────────
//
// 前端点「开始」→ `focus_monitor_start` 开会话；后台线程（`focus::spawn_monitor`）
// 每秒采一次样并广播 `focus-tick`；结束时 `focus_monitor_stop` 拿回**最终快照**，
// 连中断数字一起交给 `todo_add_pomodoro` 记账。
// 托盘 tooltip 由前端调 `focus_tray_set` 自己给（标题在前端手边）。

/// 开一次专注会话：`focus_monitor_start`
///
/// `threshold_seconds` 不传就读设置里的 `focus.awayThresholdSeconds`（默认 90）。
/// `pause_on_lock` 也一并从设置里取（用户 2026-09-26 定：锁屏 / 休眠才自动暂停）。
#[tauri::command]
pub fn focus_monitor_start(
    state: State<'_, AppState>,
    todo_id: String,
    threshold_seconds: Option<u64>,
) -> Result<crate::focus::FocusSnapshot, String> {
    let cfg = with_store(&state, |store| config::load(store))?;
    let threshold = threshold_seconds.unwrap_or(cfg.focus.away_threshold_seconds);
    crate::focus::start(todo_id, threshold, cfg.focus.pause_on_lock);
    Ok(crate::focus::snapshot())
}

/// 结束会话并拿回**最终快照**：`focus_monitor_stop`（返回的 `active` 是 false，
/// 但 `todoId` 与各项计数留着 —— 它就是这一笔番茄要记中断数字的来源）。
#[tauri::command]
pub fn focus_monitor_stop() -> Result<crate::focus::FocusSnapshot, String> {
    Ok(crate::focus::stop())
}

/// 只读当前状态：`focus_monitor_state`（验收脚本用；没会话时全 0、`todoId` 为空串）
#[tauri::command]
pub fn focus_monitor_state() -> crate::focus::FocusSnapshot {
    crate::focus::snapshot()
}


// ─────────────────────── M22：电脑端「同步入口」的临时服务 ───────────────────────
// 照《同步协议》§3：只在"点开始 → 结束"之间活着 · 一次性令牌 5 分钟 · 只监听局域网 ·
// **先留同步前快照**（留档失败就中止，宁可不做也不冒丢数据的险）· 二维码由代码生成。

/// 点「开始同步」：先留快照，再起临时服务，返回二维码等状态
///
/// `qrSvg` 是**代码生成**的 SVG（`qrcode` crate）——协议里写死了不许拿图片顶替（那样扫不出来）。
#[tauri::command]
pub fn sync_server_start(state: State<'_, AppState>) -> Result<sync_server::SyncServerStatus, String> {
    with_store(&state, |store| sync_server::start(store))
}

/// 现在什么状态（界面每秒来问一次）：`idle`/`waiting`/`connected`/… + 剩余秒数 + 日志
#[tauri::command]
pub fn sync_server_status(state: State<'_, AppState>) -> Result<sync_server::SyncServerStatus, String> {
    with_store(&state, |store| Ok(sync_server::status(store)))
}

/// 取消：把服务关掉、令牌立刻作废（端口随之释放）
#[tauri::command]
pub fn sync_server_cancel(state: State<'_, AppState>) -> Result<sync_server::SyncServerStatus, String> {
    with_store(&state, |store| sync_server::cancel(store))
}
