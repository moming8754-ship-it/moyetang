/**
 * 前端 → Rust 的唯一通道。
 * 约定（DEV-PLAN §5）：数据读写全部在 Rust，前端不直接碰文件。
 * 浏览器里直接跑 vite（非 Tauri 环境）时给出安全兜底，方便调样式而不崩。
 */
import { invoke } from "@tauri-apps/api/core";
import { isDaytime } from "../shared/daytime";
import { defaultConfig } from "./types";
import type {
  Annotation,
  AppInfo,
  ArchiveEntry,
  Award,
  BackupReport,
  Config,
  DailyReport,
  DropPosition,
  ExportFormat,
  FocusTick,
  ImportReport,
  Info,
  InfoKind,
  LinkedNote,
  Countdown,
  Motto,
  MottoKind,
  Note,
  NoteExportReport,
  NoteKind,
  NotesExportReport,
  NotesImportReport,
  Quadrant,
  Reminder,
  ShortcutStatus,
  Todo,
  TodoRepeat,
  TreeNode,
  TreeOpResult,
} from "./types";

/** 当前是否运行在 Tauri 窗口里 */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ───────────────────────── 数据目录 ─────────────────────────

/** 数据目录路径 */
export async function dataDirGet(): Promise<string> {
  if (!inTauri()) return "（浏览器预览模式：数据目录不可用）";
  return invoke<string>("data_dir_get");
}

// ───────────────────────── 开机自启（M10-6） ─────────────────────────

/** 现在有没有设开机自启（读的是系统里的真实状态） */
export async function autostartGet(): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("autostart_get");
}

/** 开/关开机自启，返回设置完之后的真实状态 */
export async function autostartSet(enabled: boolean): Promise<boolean> {
  if (!inTauri()) return enabled;
  return invoke<boolean>("autostart_set", { enabled });
}

/** 在系统文件管理器里打开数据目录 */
export async function dataDirOpen(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("data_dir_open");
}

// ───────────────────────── 设置 ─────────────────────────

/** 读设置（文件坏了会抛错，调用方要弹 Toast） */
export async function configGet(): Promise<Config> {
  if (!inTauri()) return defaultConfig();
  return invoke<Config>("config_get");
}

/** 保存设置；返回真正落盘后的配置（dataDir 以后端实际生效的为准） */
export async function configSave(config: Config): Promise<Config> {
  if (!inTauri()) return config;
  return invoke<Config>("config_save", { config });
}

// ───────────────────────── 信息区 ─────────────────────────

/** 信息列表（后端已按时间倒序，新的在前） */
export async function infoList(): Promise<Info[]> {
  if (!inTauri()) return [];
  return invoke<Info[]>("info_list");
}

/** 新建一条信息（createdAt 由后端盖章；图片类传 kind=image + assetPath） */
export async function infoCreate(
  text: string,
  kind: InfoKind = "text",
  categories: string[] = [],
  assetPath?: string,
): Promise<Info> {
  if (!inTauri()) throw new Error("浏览器预览模式不能保存");
  return invoke<Info>("info_create", { text, kind, categories, assetPath });
}

/** 整条更新（M2 分类/联动会用到） */
export async function infoUpdate(info: Info): Promise<Info> {
  if (!inTauri()) throw new Error("浏览器预览模式不能保存");
  return invoke<Info>("info_update", { info });
}

/** 删除一条；返回是否真的删到了 */
export async function infoDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删除");
  return invoke<boolean>("info_delete", { id });
}

// ───────────────────────── 附件（图片） ─────────────────────────

/** 把外部图片复制进 `assets/`，返回相对路径（`assets/xxxx.png`） */
export async function assetImport(path: string): Promise<string> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导入图片");
  return invoke<string>("asset_import", { path });
}

/** 附件的绝对路径（配合 convertFileSrc 显示图片） */
export async function assetAbsPath(relPath: string): Promise<string> {
  if (!inTauri()) return relPath;
  return invoke<string>("asset_abs_path", { relPath });
}

// ───────────────────────── 联动 ─────────────────────────

/** 联动 A：把信息写进认知笔记（`noteId` 给了就用它，否则按标题新建） */
export async function infoLinkNote(
  infoId: string,
  options: { noteId?: string; noteTitle?: string; noteKind?: NoteKind } = {},
): Promise<LinkedNote> {
  if (!inTauri()) throw new Error("浏览器预览模式不能联动");
  return invoke<LinkedNote>("info_link_note", {
    infoId,
    noteId: options.noteId,
    noteTitle: options.noteTitle,
    noteKind: options.noteKind,
  });
}

/** 联动 B：以信息标题建一条待办 */
export async function infoLinkTodo(infoId: string, plannedAt?: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能联动");
  return invoke<Todo>("info_link_todo", { infoId, plannedAt });
}

// ───────────────────────── 认知区 ─────────────────────────

export async function noteList(): Promise<Note[]> {
  if (!inTauri()) return [];
  return invoke<Note[]>("note_list");
}

/**
 * 新建笔记。`content` 给了就**在同一条命令里连正文一起落盘**。
 *
 * ⚠️ 别在调用方"先 create 再 save"：`note_create` 会广播 `data-changed`，
 * 认知区会先看到一篇**空正文**的笔记（小窗保存时就这么坑过用户）。
 */
export async function noteCreate(
  title: string,
  kind: NoteKind = "doc",
  content?: string,
): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能新建笔记");
  return invoke<Note>("note_create", { title, kind, content });
}

export async function noteGet(id: string): Promise<Note | null> {
  if (!inTauri()) return null;
  return invoke<Note | null>("note_get", { id });
}

/** 把笔记移到某个分组（空串 = 移出分组）；操作式，只改 `group` 这一个字段 */
export async function noteSetGroup(noteId: string, group: string): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改分组");
  return invoke<Note>("note_set_group", { noteId, group });
}

/** 现有的分组名（去重、按名字排序）—— 左栏和「移到分组」菜单用 */
export async function noteGroups(): Promise<string[]> {
  if (!inTauri()) return [];
  return invoke<string[]>("note_groups");
}

/**
 * 只改笔记的**标题 + 正文**（2026-10-06 加，P0-1 修）。
 *
 * 🔴 手机端**必须**用这个，**不要用 `noteSave`**：那是整篇覆盖（后端 `save` 是 `note.clone()`），
 * 会把手机手上那份**旧的 `root`（树节点）**写回电脑，抹掉电脑侧更新过的树 —— 这是真事故
 * （用户报的「树在、内容没了」，见 进度.md P0-1）。后端只动 title/content。
 */
/**
 * 🔴 P0-1（2026-10-06）：把树笔记**正文里还没成为节点**的整行文字补进树。
 *
 * 手机版没有树编辑界面（点开树笔记是**文本页**），他打的字进 `content`；电脑侧树视图只看 `root`
 * → 现象就是"树在、内容没了"。手机端保存树笔记时调它一次，把那些话补成根节点下的子节点。
 * **幂等**（已在树里的文字不重复加）、**非破坏**（只追加，绝不动已有节点）。
 */
export async function noteTreeAppendText(noteId: string, text: string): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<Note>("note_tree_append_text", { noteId, text });
}

export async function noteSetText(noteId: string, title: string, content: string): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能保存笔记");
  return invoke<Note>("note_set_text", { noteId, title, content });
}

export async function noteDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删除笔记");
  return invoke<boolean>("note_delete", { id });
}

/**
 * 保存笔记（标题 / 正文）。
 *
 * 后端在保存时会顺手把正文里的 `-[]文字` 同步成待办（M3-4）：
 * 同一条标记只会有一条待办，改字是"就地改名"，不会越存越多。
 */
export async function noteSave(note: Note): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能保存笔记");
  return invoke<Note>("note_save", { note });
}

/**
 * 勾选 / 取消勾选一条 `-[]` 标记。
 *
 * 状态记在**对应的待办**上（执行区据此显示变化），笔记正文一个字都不改。
 * `text` 是兜底：万一前端算出来的 markerKey 和后端对不上，后端还能按文字找到那条标记。
 */
export async function noteMarkerToggle(
  noteId: string,
  markerKey: string,
  text: string | undefined,
  checked: boolean,
): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能勾选");
  return invoke<Todo>("note_marker_toggle", { noteId, markerKey, text, checked });
}

// ─────────────────── 认知区 · 树状图（M4） ───────────────────
//
// 这一族是**操作式**的：每个动作一条命令，Rust 侧「读盘拿最新 → 改一处 →
// `note::save`（走 store::atomic）」。
//
// ⚠️ 为什么不跟文本笔记一样"前端改完整篇 note_save 写回"：
// 树笔记会被后端自己改（`info_link_note` 往根节点下加联动节点）。
// 前端握着一份旧树整篇写回，会把刚联动进来的节点抹掉 —— 那是数据丢失。
// 操作式读的是盘上最新版，结构上不可能覆盖掉别人写的东西。

/** 只改标题（树状图面板用，避开整篇覆盖） */
export async function noteTitleSet(noteId: string, title: string): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能保存");
  return invoke<Note>("note_title_set", { noteId, title });
}

/** 加子节点；`focusNodeId` 是新建出来的那个节点 */
export async function noteTreeAddChild(
  noteId: string,
  parentId: string,
  text?: string,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_add_child", { noteId, parentId, text });
}

/** 加同级节点（根节点会报错：它没有同级） */
export async function noteTreeAddSibling(
  noteId: string,
  nodeId: string,
  text?: string,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_add_sibling", { noteId, nodeId, text });
}

/** 删除节点**和它的整个分支**（根节点会报错） */
export async function noteTreeRemove(noteId: string, nodeId: string): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_remove", { noteId, nodeId });
}

/** 拖动改层级/顺序（目标是自己的后代会报错，防环） */
export async function noteTreeMove(
  noteId: string,
  nodeId: string,
  targetId: string,
  position: DropPosition,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_move", { noteId, nodeId, targetId, position });
}

/** 改节点文字 */
export async function noteTreeSetText(
  noteId: string,
  nodeId: string,
  text: string,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_set_text", { noteId, nodeId, text });
}

/** 折叠 / 展开一条分支 */
export async function noteTreeSetCollapsed(
  noteId: string,
  nodeId: string,
  collapsed: boolean,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_set_collapsed", { noteId, nodeId, collapsed });
}

/** 节点插图片 / 去掉图片（传 `null` 只解除引用，`assets/` 里的原文件不动） */
export async function noteTreeSetImage(
  noteId: string,
  nodeId: string,
  assetPath: string | null,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_set_image", { noteId, nodeId, assetPath });
}

/** 补救：给丢了根节点的坏树笔记补上「中心主题」（幂等） */
export async function noteTreeEnsureRoot(noteId: string): Promise<Note> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<Note>("note_tree_ensure_root", { noteId });
}

/**
 * 把一个节点（连同整枝）插回指定位置 —— **撤销「删掉整枝」用**。
 *
 * 为什么不"整篇覆盖写回"：见 `store::tree` 的模块注释（覆盖会把别处刚写进去的节点抹掉）。
 * 后端会校验 id 不撞车、父节点存在。
 */
export async function noteTreeInsert(
  noteId: string,
  parentId: string,
  index: number,
  subtree: TreeNode,
): Promise<TreeOpResult> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改树");
  return invoke<TreeOpResult>("note_tree_insert", { noteId, parentId, index, subtree });
}

/**
 * 把一段图片字节（base64）写进 `assets/`，返回相对路径。
 *
 * 用途：**从剪贴板粘贴图片** —— 剪贴板给的是字节、不是磁盘路径，走不了 `asset_import`。
 * 图片格式由后端按文件头魔数判断。
 */
export async function assetWriteImage(dataBase64: string): Promise<string> {
  if (!inTauri()) throw new Error("浏览器预览模式不能写图片");
  return invoke<string>("asset_write_image", { dataBase64 });
}

// ───────────────────────── 执行区 ─────────────────────────

export async function todoList(): Promise<Todo[]> {
  if (!inTauri()) return [];
  return invoke<Todo[]>("todo_list");
}

export async function todoCreate(title: string, plannedAt?: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能新建待办");
  return invoke<Todo>("todo_create", { title, plannedAt });
}

// ── M5：待办是"一个动作一条命令" ──
//
// ⚠️ 为什么不做一个通用的 `todo_update(patch)`：`todos.json` 会被后端自己改
// （`sync_markers` 同步标题与「来源已移除」、番茄钟往 `pomodoros` 里追加），
// 前端拿手里那份整条发回去会把刚写进去的抹掉。而且 serde 反序列化 `null` 时
// **外层 `Option` 会直接把它吃成 `None`**，"清空"和"不动"在 JSON 里分不开
// （见 `src-tauri/src/store/todo.rs` 里那条翻车记录的单测）。
// 拆成专用命令后：**调用了 = 要改这一项**，没有歧义，也不会误伤别的字段。

/** **标完成 / 取消完成**（M5 第一件事）：只改状态，别的字段一律不动 */
export async function todoSetDone(id: string, done: boolean): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能标完成");
  return invoke<Todo>("todo_set_done", { id, done });
}

/** 改标题（只碰标题） */
export async function todoSetTitle(id: string, title: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_title", { id, title });
}

/** 设定时间；传 `null` 表示**清掉**（清掉后就不进今日时间轴了） */
export async function todoSetPlanned(id: string, plannedAt: string | null): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_planned", { id, plannedAt });
}

/** 截止日期（M9-1）；传 `null` = 清掉 */
export async function todoSetDue(id: string, dueAt: string | null): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_due", { id, dueAt });
}

/** 重复规则（M9-6）；传 `null` = 不重复 */
export async function todoSetRepeat(id: string, repeat: TodoRepeat | null): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_repeat", { id, repeat });
}

/** 子任务：加一条（M9-2） */
export async function todoSubtaskAdd(id: string, text: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_subtask_add", { id, text });
}

/** 子任务：勾上/取消 */
export async function todoSubtaskToggle(
  id: string,
  subtaskId: string,
  done: boolean,
): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_subtask_toggle", { id, subtaskId, done });
}

/** 子任务：删掉一条 */
export async function todoSubtaskRemove(id: string, subtaskId: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_subtask_remove", { id, subtaskId });
}

/** 四象限归属；传 `null` 表示**拖出象限**（回到"没分类"） */
export async function todoSetQuadrant(id: string, quadrant: Quadrant | null): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_quadrant", { id, quadrant });
}

/** 拖动排序：按传入的 id 顺序重排；没提到的排后面、相对顺序不变 */
export async function todoReorder(orderedIds: string[]): Promise<Todo[]> {
  if (!inTauri()) throw new Error("浏览器预览模式不能排序");
  return invoke<Todo[]>("todo_reorder", { orderedIds });
}

/** 把待办移到某个分组（空串 = 移出分组）；操作式，只改 `group` 这一个字段（D 批） */
export async function todoSetGroup(id: string, group: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改分组");
  return invoke<Todo>("todo_set_group", { id, group });
}

/** 现有的待办分组名（去重、按名字排序）—— 分组段与「移到分组」菜单用（D 批） */
export async function todoGroups(): Promise<string[]> {
  if (!inTauri()) return [];
  return invoke<string[]>("todo_groups");
}

/** 删除待办（二次确认由界面做） */
export async function todoDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删待办");
  return invoke<boolean>("todo_delete", { id });}

/** M13-B：记番茄时一起带上「意外中断」那几个数字（不传就按 0 / false 记） */
export interface PomodoroExtra {
  interruptedSeconds?: number;
  interruptedTimes?: number;
  /**
   * **暂停总秒数** = 后端那份（锁屏 / 休眠）+ 手动那份。
   *
   * ⚠️ 2026-10-05（v1.14.0）起还要同时传 [`PomodoroExtra.manualPausedSeconds`]：
   * 后端得拿"总数 − 手动"才能跟它自己算的那份比对，否则前端丢数字时后端没法把账捡回来。
   */
  pausedSeconds?: number;
  /**
   * 2026-10-05（v1.14.0）：上面那个总数里**用户手动暂停**的部分（只有前端知道，后端拿不到）。
   * 后端规则：`max(前端那份的后端类部分, 后端自己算的) + 手动` —— 互不重叠，相加不会翻倍。
   */
  manualPausedSeconds?: number;
  /** 用户选了「作废」：不计入有效专注，但记录照留 */
  voided?: boolean;
}

/** 记一次番茄钟；`finish` 为真时顺手标完成 —— **只标完成，绝不删除** */
export async function todoAddPomodoro(
  id: string,
  mode: string,
  seconds: number,
  note: string,
  finish: boolean,
  extra?: PomodoroExtra,
): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能记番茄钟");
  return invoke<Todo>("todo_add_pomodoro", {
    id,
    mode,
    seconds,
    note,
    finish,
    // ⚠️ 显式传 null：Rust 那边是 `Option<…>`，缺参数和传 null 是两种待遇
    interruptedSeconds: extra?.interruptedSeconds ?? null,
    interruptedTimes: extra?.interruptedTimes ?? null,
    pausedSeconds: extra?.pausedSeconds ?? null,
    manualPausedSeconds: extra?.manualPausedSeconds ?? null,
    voided: extra?.voided ?? null,
  });
}

/**
 * M13-C：写这条待办的「须知」（长期备注，跟待办走）。
 * **操作式**：后端只改 `focusNote` 这一个字段；**空串 = 清掉**。
 */
export async function todoSetFocusNote(id: string, text: string): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_focus_note", { id, text });
}

/**
 * v1.15.0：设 / 清**这一条待办自己的番茄时长**（卡片 ⚙ 里那一行）。
 *
 * - `minutes` = 分钟数（1~999）→ 这条待办以后就用它；
 * - `minutes` = `null` → **恢复跟随设置里的全局值**（`config.focus.customMinutes`）。
 *
 * **操作式**：后端只改 `customMinutes` 这一个字段（绝不整条覆盖，
 * 否则会把后端刚写进去的番茄记录抹掉）。
 */
export async function todoSetCustomMinutes(id: string, minutes: number | null): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改待办");
  return invoke<Todo>("todo_set_custom_minutes", { id, minutes });
}

/**
 * 「再次设定时间提醒」：排一条 `todo-remind`，到点在首页动态区出现。
 *
 * C 批（2026-10-02）：**一条待办可以排多条** —— 靠 `key` 区分身份：
 * - 不传 / `at:…` 手动那条（**老数据同待遇**，再设一次仍然是"改时间"）
 * - `early:<分钟>` 提前提醒（时间由前端按 `dueAt - N 分钟` 算好传进来）
 */
export async function todoScheduleRemind(
  id: string,
  fireAt: string,
  key?: string,
  note?: string,
): Promise<Todo> {
  if (!inTauri()) throw new Error("浏览器预览模式不能排提醒");
  return invoke<Todo>("todo_schedule_remind", { id, fireAt, key, note });
}

// ─────────────────────── 桌面挂件（E 批，2026-10-03） ───────────────────────

/** 显示桌面挂件 */
export async function widgetOpen(): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>("widget_open");
}

/** 收起桌面挂件（**只收窗口，不改配置** —— 开关状态只由设置页管） */
export async function widgetClose(): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>("widget_close");
}

/** 唤回主窗口（挂件点了条目时调） */
export async function mainShow(): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>("main_show");
}

/** 挂件现在开着吗（只读，验收脚本用） */
export async function widgetVisible(): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("widget_visible");
}

/** 按最新配置重新摆一次（设置里改了开关/尺寸/置顶/格子之后调） */
export async function widgetApply(): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>("widget_apply");
}

/** C 批：删掉**某一条**提醒（只删点名那条，同一条待办的其他提醒一条不动） */
export async function reminderDelete(id: string): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("reminder_delete", { id });
}

/** C 批：这条待办现在排着哪些提醒（⚙ 弹窗画清单用；由后端过滤 status=pending） */
export async function reminderForTodo(id: string): Promise<Reminder[]> {
  if (!inTauri()) return [];
  return invoke<Reminder[]>("reminder_for_todo", { id });
}

/** 清掉所有「来源已移除」的待办，返回清掉几条 */
export async function todoPurgeRemoved(): Promise<number> {
  if (!inTauri()) throw new Error("浏览器预览模式不能清理待办");
  return invoke<number>("todo_purge_removed");
}

// ───────────────────────── 快捷小窗（M6） ─────────────────────────
//
// 窗口的创建/显示/隐藏都在 Rust（`crate::window`）：全局快捷键的回调在 Rust 侧，
// 而且前端直接调 `getCurrentWindow().hide()` 要显式 ACL 权限（草笺踩过"漏配 → 点了没反应"）。

/** 唤起小窗（没有就创建） */
export async function smallWindowShow(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("small_window_show");
}

/** 收起小窗（**不销毁**，里面的草稿留着） */
export async function smallWindowHide(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("small_window_hide");
}

/**
 * **再开一个速记窗**（2026-10-11 · 用户反馈第 6 条，v2.21.0；**2026-10-13 改成三入口共用**）。
 *
 * 用户 2026-10-13 原话：「**我可以按好多次 f9，同时也出好多个小窗**」——
 * 所以 **全局快捷键 / 小窗标题栏那颗 ⧉ / 托盘「再开一个速记窗」走的是同一条路**：
 * 1. 有「藏着但还在」的速记窗 → 先把号最小的拉出来（**草稿还在**）；
 * 2. 都没有 → 再开一个新的（1→5 号）；
 * 3. 号满了 → 把最后一个拿到最前。
 * 返回那个窗的 label（`small` / `small-2` / …）。
 *
 * ⚠️ 老命令 `small_window_toggle`（开着就收、没开就弹）**已删** —— 它只碰 1 号窗，
 * 正是用户「按了 F9 就是不多开」的根源。
 */
export async function smallWindowNew(): Promise<string> {
  if (!inTauri()) return "";
  return invoke<string>("small_window_new");
}

/**
 * **一次收起所有速记窗**（2026-10-13 新增，托盘菜单「收起所有速记窗」用）。
 * ⚠️ **只收不销毁**：每篇草稿都还在，再按一次快捷键会原样拉回来。
 */
export async function smallWindowHideAll(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("small_window_hide_all");
}

// ───────────────────────── 提醒 ─────────────────────────

export async function reminderList(): Promise<Reminder[]> {
  if (!inTauri()) return [];
  return invoke<Reminder[]>("reminder_list");
}

export async function reminderDismiss(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能操作提醒");
  return invoke<boolean>("reminder_dismiss", { id });
}

export async function reminderSnooze(id: string, minutes = 15): Promise<Reminder | null> {
  if (!inTauri()) throw new Error("浏览器预览模式不能操作提醒");
  return invoke<Reminder | null>("reminder_snooze", { id, minutes });
}

// ───────────────────────── 备份导出 / 导入（M7） ─────────────────────────

/**
 * 导出备份（打包成一个 zip）。
 *
 * `dest` 不传就写到 `<数据目录>/backups/笔记备份-YYYY-MM-DD.zip`；
 * 用户在文件对话框里选过路径就传进来。
 */
export async function backupExport(dest?: string): Promise<BackupReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导出备份");
  return invoke<BackupReport>("backup_export", { dest: dest ?? null });
}

/**
 * 导入备份 —— ⚠️ **会覆盖当前数据**，调用方必须先做二次确认。
 *
 * 后端的第一步是**把当前数据先备份一份**（那步失败就直接中止），
 * 返回的 `safetyBackup` 就是那份"后悔药"。
 */
export async function backupImport(src: string): Promise<ImportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导入备份");
  return invoke<ImportReport>("backup_import", { src });
}

// ─────────────────── 笔记导出 / 导入（M27 / v2.18.0）───────────────────

/**
 * 导出**一篇**到指定文件（**电脑端**）—— `dest` 是「另存为」对话框给的完整路径。
 *
 * `withImages` 为真时，正文里用到的图会复制到**主文件旁边**的 `<文件名>.assets/`，
 * 并把链接改成相对路径（导出的东西拿去别处也不断图）。
 */
export async function noteExportFile(
  noteId: string,
  dest: string,
  format: ExportFormat,
  withImages: boolean,
): Promise<NoteExportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导出");
  return invoke<NoteExportReport>("note_export_file", { noteId, dest, format, withImages });
}

/**
 * 批量导出到一个文件夹（**电脑端**）：`noteIds` 不传 = 整个认知区。
 *
 * 每篇一个 `<标题>.md`（重名自动加 `-2`），图片放各自的 `<标题>.assets/`。
 */
export async function notesExportDir(
  noteIds: string[] | null,
  dir: string,
  format: ExportFormat,
  withImages: boolean,
): Promise<NotesExportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导出");
  return invoke<NotesExportReport>("notes_export_dir", { noteIds, dir, format, withImages });
}

/**
 * 导入若干 `.md` / `.txt`（**电脑端**）—— `paths` 是「打开」对话框给的路径。
 *
 * 每个文件 → 一篇新笔记；文件旁边的 `<文件名>.assets/` 会被收进数据目录的 `assets/`。
 */
export async function notesImportFiles(paths: string[]): Promise<NotesImportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导入");
  return invoke<NotesImportReport>("notes_import_files", { paths });
}

/** Android：取走文件管理器通过 ACTION_VIEW 交给应用的 Markdown / 文本文件。 */
export async function notesImportAndroidPending(): Promise<NotesImportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导入");
  return invoke<NotesImportReport>("notes_import_android_pending");
}

/**
 * 导出**一篇**到手机「下载/东方摩耶堂/」（**手机端专用**）。
 *
 * 为什么手机不自己选位置：安卓上 dialog 插件的「另存为」根本没实现（见进度 §三 2k / C1），
 * 所以统一落到下载目录 —— 文件管理里看得见，微信/QQ 也能从那儿发。
 */
export async function noteExportDownloads(
  noteId: string,
  format: ExportFormat,
  withImages: boolean,
): Promise<NoteExportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导出");
  return invoke<NoteExportReport>("note_export_downloads", { noteId, format, withImages });
}

/** 把整库备份导出到手机「下载/东方摩耶堂/」（手机端） */
export async function backupExportDownloads(): Promise<NoteExportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导出备份");
  return invoke<NoteExportReport>("backup_export_downloads");
}

/**
 * 从字节导入备份（**手机端**：`<input type=file>` 选 zip → base64）。
 *
 * ⚠️ **会覆盖当前数据**，调用方必须先二次确认；后端第一步会先把当前数据留档。
 */
export async function backupImportBytes(dataBase64: string): Promise<ImportReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导入备份");
  return invoke<ImportReport>("backup_import_bytes", { dataBase64 });
}

/**
 * 清空回收站（`notes/_trash/`），返回删掉的文件个数。
 *
 * ⚠️ 这是**唯一真删笔记**的操作 —— 删掉的连 `.bak` 都没了。
 * 所以调用方必须先二次确认（界面上的按钮是这么做的）。
 */
export async function trashPurge(): Promise<number> {
  if (!inTauri()) throw new Error("浏览器预览模式不能清空回收站");
  return invoke<number>("trash_purge");
}

// ───────────────────────── 关于 / 快捷键状态（M7） ─────────────────────────

/** 版本 + 数据统计（信息 / 笔记 / 待办条数、附件占用） */
export async function appInfo(): Promise<AppInfo> {
  if (!inTauri()) {
    return {
      name: "东方摩耶堂",
      version: "0.1.0",
      infoCount: 0,
      noteCount: 0,
      todoCount: 0,
      assetCount: 0,
      assetBytes: 0,
      dataDir: "（浏览器预览模式）",
    };
  }
  return invoke<AppInfo>("app_info");
}

/** 唤起小窗的快捷键状态（尤其要看 `registered`：false = 这个键被占了，按了没反应） */
export async function shortcutStatus(): Promise<ShortcutStatus> {
  if (!inTauri()) {
    return { accelerator: "Ctrl+Space", registered: false, default: "Ctrl+Space" };
  }
  return invoke<ShortcutStatus>("shortcut_status");
}

// ───────────────────────── 每日报告（M11-A） ─────────────────────────

/**
 * 读某一天的日报（**只有用户手写的那部分**）。
 * 没写过也返回空壳（`notes: []`），所以调用方不用判 `null`。
 */
export async function dailyGet(date: string): Promise<DailyReport> {
  if (!inTauri()) return { date, notes: [], updatedAt: "" };
  return invoke<DailyReport>("daily_get", { date });
}

/** 写 / 改某一天的一条说明；`text` 去掉空白后为空 = **删掉这一条** */
export async function dailyNoteSet(
  date: string,
  key: string,
  text: string,
): Promise<DailyReport> {
  if (!inTauri()) throw new Error("浏览器预览模式不能写日报");
  return invoke<DailyReport>("daily_note_set", { date, key, text });
}

/**
 * 把某一天的日报导出成 txt（正文由前端拼好传进来）。
 * `dest` 不传就写到 `<数据目录>/dailies/<日期>-日报.txt`；返回最终写出的路径。
 */
export async function dailyExport(
  date: string,
  content: string,
  dest?: string,
): Promise<string> {
  if (!inTauri()) throw new Error("浏览器预览模式不能导出日报");
  return invoke<string>("daily_export", { date, content, dest });
}

// ───────────────────────── 奖状 / 证书（M12-A） ─────────────────────────

/**
 * 全部奖状。**原样按文件顺序**（= 加入顺序）——
 * "置顶最前 + 按年份分段"在 `features/skills/awards.ts` 里做，只放在一处。
 */
export async function awardList(): Promise<Award[]> {
  if (!inTauri()) return [];
  return invoke<Award[]>("award_list");
}

/** 新建一张（**只要一个标题** —— 没图也能建） */
export async function awardCreate(title: string): Promise<Award> {
  if (!inTauri()) throw new Error("浏览器预览模式不能建奖状");
  return invoke<Award>("award_create", { title });
}

/**
 * 改一张：**不传的字段一律不动**；这几个字段传**空串 = 清空那一格**。
 * （`assetPath: ""` = 摘掉图，**`assets/` 里的原图不删** —— 和 M4 那条约定一致。）
 */
export async function awardSet(
  id: string,
  patch: Partial<Pick<Award, "title" | "issuer" | "date" | "note" | "assetPath" | "pinned">>,
): Promise<Award> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改奖状");
  return invoke<Award>("award_set", { id, ...patch });
}

/** 删一张（**真删**；后端会先把这一条的原文留档到 `backups/`，留档失败就中止） */
export async function awardDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删奖状");
  return invoke<boolean>("award_delete", { id });
}

// ───────────────────────── 格言 / 原则（M12-C） ─────────────────────────

/** 全部格言 / 原则（**原样按文件顺序** = 加入顺序；怎么摆是界面的事） */
export async function mottoList(): Promise<Motto[]> {
  if (!inTauri()) return [];
  return invoke<Motto[]>("motto_list");
}

/** 新建一条（**只要那句话**；`kind` 不传就当"自己的原则"） */
export async function mottoCreate(text: string, kind?: MottoKind): Promise<Motto> {
  if (!inTauri()) throw new Error("浏览器预览模式不能写格言");
  return invoke<Motto>("motto_create", { text, kind });
}

/** 改一条：**不传的字段一律不动**；`from` 传空串 = 清掉出处 */
export async function mottoSet(
  id: string,
  patch: Partial<Pick<Motto, "text" | "from" | "kind">>,
): Promise<Motto> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改格言");
  return invoke<Motto>("motto_set", { id, ...patch });
}

/** 删一条（**真删**；后端先留档，留档失败就中止） */
export async function mottoDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删格言");
  return invoke<boolean>("motto_delete", { id });
}

// ───────────────────────── 倒计时（2026-10-04 · V2 打磨） ─────────────────────────

/** 全部倒计时（原样按文件顺序；"按日期从近到远"是界面的事） */
export async function countdownList(): Promise<Countdown[]> {
  if (!inTauri()) return [];
  return invoke<Countdown[]>("countdown_list");
}

/** 新建一个倒计时（`date` 必须是 `YYYY-MM-DD` 的真日子，后端会校验） */
export async function countdownCreate(
  title: string,
  date: string,
  note?: string,
): Promise<Countdown> {
  if (!inTauri()) throw new Error("浏览器预览模式不能加倒计时");
  return invoke<Countdown>("countdown_create", { title, date, note });
}

/** 改一个：**不传的字段一律不动**；`onWidget: false` = 从挂件上拿掉 */
export async function countdownUpdate(
  id: string,
  patch: { title?: string; date?: string; note?: string; onWidget?: boolean },
): Promise<Countdown> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改倒计时");
  return invoke<Countdown>("countdown_update", { id, ...patch });
}

/** 删一个（**真删**；后端先留档到 `backups/`，留档失败就中止） */
export async function countdownDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删倒计时");
  return invoke<boolean>("countdown_delete", { id });
}
// ───────────────────────── 同步数据层（M21 / v2.11.0） ─────────────────────────

/** 设备状态：设备 id（第一次调用时生成并落盘）/ 上次同步时间 / 协议版本 */
export interface SyncState {
  deviceId: string;
  lastSyncAt: string;
  protocolVersion: number;
}

/** 一条删除记录（墓碑）：只有 id / 删除时间 / 种类，**不含内容** */
export interface Grave {
  id: string;
  deletedAt: string;
  /** `"todo"` | `"note"` | `"info"`（档案库里的条目按它原本的种类记） */
  kind: string;
}

export async function syncStateGet(): Promise<SyncState> {
  return invoke<SyncState>("sync_state_get");
}

/** 删除记录列表（新的在前）。真正的同步在 M23，这里先给界面/诊断用 */
export async function syncGravesList(): Promise<Grave[]> {
  return invoke<Grave[]>("sync_graves_list");
}

/** 清空删除记录（**真删**；后端先留档到 `backups/`，留档失败就中止）→ 返回清掉几条 */
export async function syncGravesPurge(): Promise<number> {
  if (!inTauri()) throw new Error("浏览器预览模式不能清删除记录");
  return invoke<number>("sync_graves_purge");
}

// ───────────────────────── 专注小窗（M13-A） ─────────────────────────

/**
 * 弹出专注小窗（待办点「开始」时调）。
 * `tooltip` 会同时写到托盘上（例如「东方摩耶堂 · 专注中：把设计稿定下来」）。
 * ⚠️ Rust 那边是 `async fn`（建窗必须，否则主线程死锁）。
 */
export async function focusWindowOpen(tooltip?: string): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("focus_window_open", { tooltip: tooltip ?? null });
}

/** 收起专注小窗；托盘 tooltip 同时复原 */
export async function focusWindowClose(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("focus_window_close");
}

/** 专注小窗现在开着吗（只读，验收脚本用） */
export async function focusWindowVisible(): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("focus_window_visible");
}

/** 换托盘上那行字（专注中 / 暂停中 / 疑似离开）；传 `null` 复原 */
export async function focusTraySet(tooltip: string | null): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("focus_tray_set", { tooltip });
}

// ─────────────── 专注监控（M13-B：锁屏自动暂停 / 疑似离开累计）───────────────
//
// 判定的活全在 Rust（键鼠空闲、锁屏、睡过都在系统层拿，前端拿不到）；
// 前端每秒钟收一条 `focus-tick` 事件，只管显示与"要不要继续"。

/**
 * 开一次专注会话（待办点「开始」时调）。
 * `thresholdSeconds` 不传就用设置里那个（默认 90 秒）。
 */
/**
 * **手机端发起一次同步**（M23）。
 *
 * `target` 可以是扫到的 `moye-sync://IP:端口/令牌`，也可以是手输的 `IP:端口` + `code`（6 位短码）。
 * 返回账单：补过来 / 传过去 / 冲突 / 删掉。
 */
export interface SyncBill {
  adopted: number;
  sent: number;
  conflicts: number;
  deleted: number;
  skipped: number;
  copies: string[];
  /** M26：图片补过来几张（对方有我没有的） */
  assetsAdopted: number;
  /** M26：图片传过去几张（对方收下了几张） */
  assetsSent: number;
  /** M26：这轮预算装不下、下次接着传的张数 */
  assetsDeferred: number;
  /** M26：同名但内容不一样的图（两边都留着自己那张） */
  assetsClash: string[];
}
export interface SyncOutcome {
  ok: boolean;
  device: string;
  bill: SyncBill;
  message: string;
  adopted: number;
  sent: number;
}
export async function syncClientNow(target: string, code?: string | null): Promise<SyncOutcome> {
  if (!inTauri()) throw new Error("浏览器预览模式不能同步");
  return invoke<SyncOutcome>("sync_client_now", { target, code: code ?? null });
}

export async function focusMonitorStart(
  todoId: string,
  thresholdSeconds?: number,
): Promise<FocusTick> {
  if (!inTauri()) {
    return {
      active: false,
      todoId: "",
      paused: false,
      pauseReason: "",
      pausedSeconds: 0,
      interruptedSeconds: 0,
      interruptedTimes: 0,
      idleSeconds: 0,
      idleSinceStartSeconds: 0,
      awayNow: false,
    };
  }
  return invoke<FocusTick>("focus_monitor_start", {
    todoId,
    thresholdSeconds: thresholdSeconds ?? null,
  });
}

/**
 * 结束专注会话，**返回最终那份数字**（疑似离开秒数 / 次数 / 暂停秒数）。
 * 记番茄时就把这份数字一起写进去 —— 以它为准，别信前端手里那份（可能差不到 1 秒）。
 */
export async function focusMonitorStop(): Promise<FocusTick> {
  if (!inTauri()) {
    return {
      active: false,
      todoId: "",
      paused: false,
      pauseReason: "",
      pausedSeconds: 0,
      interruptedSeconds: 0,
      interruptedTimes: 0,
      idleSeconds: 0,
      idleSinceStartSeconds: 0,
      awayNow: false,
    };
  }
  return invoke<FocusTick>("focus_monitor_stop");
}

/** 现在这份专注状态（只读，验收脚本与"小窗重开时补一次"用） */
export async function focusMonitorState(): Promise<FocusTick> {
  if (!inTauri()) {
    return {
      active: false,
      todoId: "",
      paused: false,
      pauseReason: "",
      pausedSeconds: 0,
      interruptedSeconds: 0,
      interruptedTimes: 0,
      idleSeconds: 0,
      idleSinceStartSeconds: 0,
      awayNow: false,
    };
  }
  return invoke<FocusTick>("focus_monitor_state");
}

// ───────────────────────── 批注（M14-B） ─────────────────────────
//
// ⚠️ 批注属于「档案区」那一族：界面上的入口受 `config.archive.enabled` 控制
// （用户 2026-09-26 定，默认关），但这几条命令跟开关无关 —— 开关只管显示。

/** 读全部批注（前端按 noteId 过滤；量不大，一次读完省事） */
export async function annoList(): Promise<Annotation[]> {
  if (!inTauri()) return [];
  return invoke<Annotation[]>("anno_list");
}

/** 新建一条批注（锚点四件套由前端算好传进来：原话 / 前 12 字 / 后 12 字 / 句子哈希） */
export async function annoCreate(
  noteId: string,
  quote: string,
  prefix: string,
  suffix: string,
  hash: string,
  text: string,
): Promise<Annotation> {
  if (!inTauri()) throw new Error("浏览器预览模式不能写批注");
  return invoke<Annotation>("anno_create", { noteId, quote, prefix, suffix, hash, text });
}

/** 只改批注正文（锚点不许动 —— 它是算出来的） */
export async function annoSet(id: string, text: string): Promise<Annotation> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改批注");
  return invoke<Annotation>("anno_set", { id, text });
}

/** 删一条批注（后端**先留档**再删，留档失败就中止） */
export async function annoDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删批注");
  return invoke<boolean>("anno_delete", { id });
}

// ───────────────────────── 档案库（M15） ─────────────────────────
//
// ⚠️ 跟 `motto_*` / `award_*` / `daily_*` / `anno_*` 同族：**有意不广播 `data-changed`**，
// 档案库页面自己刷自己的。入口受 `config.archive.enabled` 控制（默认关）。

/** 读整个档案库（量小，一次读完；前端自己搜索 / 筛选） */
export async function archiveList(): Promise<ArchiveEntry[]> {
  if (!inTauri()) return [];
  return invoke<ArchiveEntry[]>("archive_list");
}

/** 把一条东西**收进档案库**（`kind` = info / note / todo；收走后原位就没了） */
export async function archivePut(
  kind: "info" | "note" | "todo",
  sourceId: string,
  note = "",
): Promise<ArchiveEntry> {
  if (!inTauri()) throw new Error("浏览器预览模式不能收进档案库");
  return invoke<ArchiveEntry>("archive_put", { kind, sourceId, note });
}

/**
 * **新建一条自由档案**（2026-10-11 · 用户反馈第 2 条，v2.21.0）。
 *
 * 跟 `archivePut` 的区别：这条东西**从别处来不了** —— 它就是在档案库里生的，
 * 没有原位，所以取不出来（`archive_restore` 会拒绝），但能就地改与删。
 */
export async function archiveCreate(title: string, content = ""): Promise<ArchiveEntry> {
  if (!inTauri()) throw new Error("浏览器预览模式不能新建档案");
  return invoke<ArchiveEntry>("archive_create", { title, content });
}

/** **取出**：按快照放回原来的区（原 id 与时间保留），并从档案库里删掉这条 */
export async function archiveRestore(id: string): Promise<ArchiveEntry> {
  if (!inTauri()) throw new Error("浏览器预览模式不能取出");
  return invoke<ArchiveEntry>("archive_restore", { id });
}

/** 改这条档案的备注 / 标题 */
export async function archiveSet(
  id: string,
  patch: { note?: string; title?: string },
): Promise<ArchiveEntry> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改档案");
  return invoke<ArchiveEntry>("archive_set", {
    id,
    note: patch.note ?? null,
    title: patch.title ?? null,
  });
}

/** 就地改档案里那条的内容（`patch` 是**快照里的字段**，只改传进来的键） */
export async function archivePatch(
  id: string,
  patch: Record<string, unknown>,
): Promise<ArchiveEntry> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改档案");
  return invoke<ArchiveEntry>("archive_patch", { id, patch });
}

/** 档案里的笔记正文保存（写回 `notes/_archive/`；正文是用户手写的：一个字都不改） */
export async function archiveNoteSave(
  id: string,
  title: string,
  content: string,
): Promise<ArchiveEntry> {
  if (!inTauri()) throw new Error("浏览器预览模式不能改档案里的笔记");
  return invoke<ArchiveEntry>("archive_note_save", { id, title, content });
}

/** 彻底删掉一条档案（后端**先留档**再删，留档失败就中止） */
export async function archiveDelete(id: string): Promise<boolean> {
  if (!inTauri()) throw new Error("浏览器预览模式不能删档案");
  return invoke<boolean>("archive_delete", { id });
}

// ───────────────────────── 其它 ─────────────────────────

/** 让 Rust 按当前时段刷新窗口/任务栏图标，返回是否白天 */
export async function iconRefresh(): Promise<boolean> {
  if (!inTauri()) return isDaytime();
  return invoke<boolean>("icon_refresh");
}

/**
 * 退出程序。
 * 走 Rust 的 `quit_app`：前端的 `getCurrentWindow().close()` 需要 `core:window:allow-close`
 * 权限（`core:default` 里没有），漏配会被 ACL 拒绝且容易看不出来。
 */
export async function quitApp(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("quit_app");
}
// ─────────────────────── M22：电脑端「同步入口」的临时服务 ───────────────────────

/** 同步服务的状态（字段跟 Rust 的 `SyncServerStatus` 一一对应） */
export interface SyncServerStatus {
  /** `idle`｜`waiting`｜`connected`｜`comparing`/`transferring`/`applying`｜`done`｜`error` */
  phase: string;
  /** `192.168.1.5:32123` */
  address: string;
  /** 连上来的设备（先写它的 IP；手机版会显示电脑名，等 M24 真机再核） */
  remote: string;
  /** 二维码还剩几秒有效 */
  secondsLeft: number;
  /** **代码生成**的二维码 SVG（协议：不许用图片顶替） */
  qrSvg: string;
  /** 二维码内容 `moye-sync://<ip>:<port>/<token>` */
  qrText: string;
  /** **6 位短码**：手机上相机不好使时手输它就能连；服务一关就作废 */
  shortCode: string;
  startedAt: string;
  /** 同步前快照目录（相对数据目录） */
  preSnapshot: string;
  lastSyncAt: string;
  message: string;
  log: string[];
  /**
   * 🩹 **P1-2**：**上一轮**同步的结果：`done`｜`error`｜`cancel`｜空串（从没同步过）。
   *
   * 一轮结束时会话就从槽里摘掉了（`phase` 立刻回到 `idle`），所以"上一轮成没成"必须靠这几个字段交代，
   * 否则用户刚看到"同步完成"、下一秒界面就什么都不剩。
   */
  lastResult: string;
  /** 上一轮的一句话结论（给人看） */
  lastMessage: string;
  /** 上一轮结束的时间（ISO） */
  lastAt: string;
}

/** 点「开始同步」：先留同步前快照，再起临时服务（只在这次同步期间存在） */
export async function syncServerStart(): Promise<SyncServerStatus> {
  if (!inTauri()) throw new Error("浏览器预览模式不能同步");
  return invoke<SyncServerStatus>("sync_server_start");
}

/** 现在什么状态（界面每秒来问一次） */
export async function syncServerStatus(): Promise<SyncServerStatus> {
  if (!inTauri()) throw new Error("浏览器预览模式不能同步");
  return invoke<SyncServerStatus>("sync_server_status");
}

/** 取消：关掉服务、令牌立刻作废（端口随之释放） */
export async function syncServerCancel(): Promise<SyncServerStatus> {
  if (!inTauri()) throw new Error("浏览器预览模式不能同步");
  return invoke<SyncServerStatus>("sync_server_cancel");
}
