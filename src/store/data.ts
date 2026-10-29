/**
 * 业务数据（Zustand）：信息 / 认知笔记 / 待办 / 提醒 + 设置。
 *
 * 数据真源永远是磁盘（Rust 侧读写的文件），这里只是内存里的一份视图：
 * - 启动时 + 每次窗口收到 `data-changed` 事件时，调 refresh() 重新拉；
 * - 所有写操作都成功后由 Rust 广播 `data-changed`；
 * - 每个写操作都 catch → 弹 Toast（⚠️ 不吞 Promise 异常）。
 */
import { create } from "zustand";
import * as api from "../features/api";
import type { PomodoroExtra } from "../features/api";
import { defaultConfig } from "../features/types";
import type {
  Config,
  Countdown,
  Info,
  LinkedNote,
  Note,
  NoteKind,
  Quadrant,
  Reminder,
  Todo,
  TodoRepeat,
  TreeOpResult,
} from "../features/types";
import { useUi } from "./ui";
import { fileToBase64 } from "../shared/imageFile";

/** 从信息区点"去向"跳过去时要高亮的目标（`info` 是认知区 → 信息区的反向跳转） */
export interface FocusRef {
  kind: "note" | "todo" | "info";
  id: string;
}

interface DataState {
  infos: Info[];
  notes: Note[];
  todos: Todo[];
  reminders: Reminder[];
  /**
   * 倒计时（2026-10-04）：目标日 + 一句话，界面显示「还有 N 天」。
   * ⚠️ 它同时出现在**日程页月视图**和**桌面挂件**两个窗口里 —— 后端写操作会广播
   * `data-changed`，两边各自 refresh（跟 mottos 那种"只在一个页面显示"的不一样）。
   */
  countdowns: Countdown[];
  config: Config;
  loading: boolean;
  /** 启动加载是否已经跑过一轮 */
  ready: boolean;
  focusRef: FocusRef | null;

  setFocusRef: (ref: FocusRef | null) => void;
  refresh: () => Promise<void>;
  loadConfig: () => Promise<void>;
  createInfo: (text: string) => Promise<boolean>;
  /** 拖进来的图片：逐张存进 assets/ 再各建一条信息 */
  createImageInfos: (paths: string[]) => Promise<boolean>;
  /**
   * 剪贴板里的图片（2026-10-02 用户反馈"信息区图片无法粘贴"）：`asset_write_image` → 建一条图片信息。
   *
   * ⚠️ 跟 `createImageInfos` 的区别：那条收的是**磁盘路径**（走 `asset_import`），
   * 剪贴板给的是**字节**，只能走 `asset_write_image`（后端按文件头魔数认格式）。
   * `text` 是剪贴板里同一次复制附带的文字（没有就空串）—— 存成这条图片信息的备注，
   * **不是**存进录入框，免得跟用户正在打的字打架。
   */
  pasteImageInfo: (file: File, text?: string) => Promise<boolean>;
  updateInfo: (info: Info, okText?: string) => Promise<boolean>;
  deleteInfo: (id: string) => Promise<boolean>;
  linkToNote: (
    infoId: string,
    options?: { noteId?: string; noteTitle?: string; noteKind?: NoteKind },
  ) => Promise<LinkedNote | null>;
  linkToTodo: (infoId: string) => Promise<Todo | null>;
  dismissReminder: (id: string) => Promise<boolean>;
  snoozeReminder: (id: string, minutes?: number) => Promise<boolean>;
  createNote: (title: string, kind: NoteKind, content?: string) => Promise<Note | null>;
  deleteNote: (id: string) => Promise<boolean>;
  saveNote: (note: Note) => Promise<Note | null>;
  /** 只改标题 + 正文（手机端用；不整篇覆盖，树笔记的 root 不受影响） */
  /** P0-1：把树笔记正文里还没成为节点的话补进树（幂等、只追加） */
  appendTreeText: (noteId: string, text: string) => Promise<Note | null>;
  setNoteText: (noteId: string, title: string, content: string) => Promise<Note | null>;
  /**
   * 跑一个树操作（M4）。传的是"怎么调后端"，不是"改完的树"
   * —— 后端读盘拿最新再改，所以前端不可能覆盖掉别人写进去的节点。
   */
  applyTreeOp: (run: () => Promise<TreeOpResult>) => Promise<TreeOpResult | null>;
  /** 只改标题（树笔记用；文本笔记仍走 saveNote） */
  setTreeTitle: (noteId: string, title: string) => Promise<Note | null>;
  /** 把笔记移到某个分组（空串 = 移出分组）—— M8 方案 A */
  setNoteGroup: (noteId: string, group: string) => Promise<Note | null>;
  /** 补救：给丢了根节点的坏树笔记补上「中心主题」 */
  ensureTreeRoot: (noteId: string) => Promise<Note | null>;
  /** 勾选/取消勾选笔记里的一条 `-[]` 标记（乐观更新，失败拉回来） */
  toggleMarker: (
    noteId: string,
    markerKey: string,
    text: string | undefined,
    checked: boolean,
  ) => Promise<boolean>;
  /** `plannedAt` 是可选的：M9-9 的快捷语法解析出时间后一并带上 */
  createTodo: (title: string, plannedAt?: string) => Promise<Todo | null>;
  /**
   * **标完成 / 取消完成**（M5 第一件事）。乐观更新：先就地点亮，失败拉回原样。
   * 信息区来的、笔记 `-[]` 来的、手动的待办走的都是这一条。
   */
  setTodoDone: (id: string, done: boolean) => Promise<boolean>;
  setTodoTitle: (id: string, title: string) => Promise<boolean>;
  /** 设定时间；传 `null` 清掉（清掉就不进今日时间轴） */
  setTodoPlanned: (id: string, plannedAt: string | null) => Promise<boolean>;
  /** 截止日期（M9-1）；`null` = 清掉 */
  setTodoDue: (id: string, dueAt: string | null) => Promise<boolean>;
  /** 重复规则（M9-6）；`null` = 不重复。勾完由**后端**自动派下一次 */
  setTodoRepeat: (id: string, repeat: TodoRepeat | null) => Promise<boolean>;
  /** 子任务（M9-2）：加一条 */
  addSubtask: (id: string, text: string) => Promise<boolean>;
  /** 子任务：勾上/取消 */
  toggleSubtask: (id: string, subtaskId: string, done: boolean) => Promise<boolean>;
  /** 子任务：删掉一条 */
  removeSubtask: (id: string, subtaskId: string) => Promise<boolean>;
  /** 四象限归属；传 `null` 拖出象限 */
  setTodoQuadrant: (id: string, quadrant: Quadrant | null) => Promise<boolean>;
  /**
   * D 批（2026-10-04）：把待办移到某个分组（空串 = 移出分组）。
   *
   * 分组只是个**标签**（跟认知区的 `Note.group` 同一套规矩）：不做文件夹树、不嵌套。
   * 乐观更新 + 失败回滚，照 `setTodoQuadrant`。
   */
  setTodoGroup: (id: string, group: string) => Promise<boolean>;
  /** 倒计时（2026-10-04）：新增一条（失败返回 null） */
  createCountdown: (title: string, date: string, note?: string) => Promise<Countdown | null>;
  /** 倒计时：改（**不传的字段不动**）；`onWidget: false` = 从挂件上拿掉 */
  updateCountdown: (
    id: string,
    patch: { title?: string; date?: string; note?: string; onWidget?: boolean },
  ) => Promise<boolean>;
  /** 倒计时：删（后端是真删，删前先留档到 backups/） */
  deleteCountdown: (id: string) => Promise<boolean>;
  /**
   * M13-C：写这条待办的「须知」（长期备注，跟待办走）。
   * **乐观更新 + 失败回滚**（照 `setTodoQuadrant` 那套）：小窗上敲字要立刻看到。
   */
  setFocusNote: (id: string, text: string) => Promise<boolean>;
  /**
   * v1.15.0：设 / 清**这一条待办自己的番茄时长**（卡片 ⚙ 里那一行）。
   *
   * `minutes` = 分钟数（1~999）｜ `null` = **恢复跟随设置里的全局值**。
   * **乐观更新 + 失败回滚**（照 `setFocusNote` 那套）。
   */
  setTodoCustomMinutes: (id: string, minutes: number | null) => Promise<boolean>;
  /** 拖动排序：按给定的 id 顺序落盘 */
  reorderTodos: (orderedIds: string[]) => Promise<boolean>;
  deleteTodo: (id: string) => Promise<boolean>;
  /**
   * M15：把一条东西**收进档案库**（信息 / 笔记 / 待办）。
   * 收完自己 `refresh()`（原位那边要从列表里消失），并给 5 秒「撤销」（误点了还能拿回来）。
   */
  archiveOne: (kind: "info" | "note" | "todo", id: string, title: string) => Promise<boolean>;
  /**
   * 2026-10-11（v2.21.0 · 用户反馈第 2 条）：**新建一条自由档案**（只在档案库里存在）。
   * 成功返回新条目的 id；失败返回 `null`（toast 已经说过了）。
   */
  archiveCreate: (title: string, content: string) => Promise<string | null>;
  /**
   * 记一次番茄钟；`finish` 为真时顺手标完成（**只标完成，不删除**）。
   * `extra` = M13-B 的意外中断数据（疑似离开秒数 / 次数 / 暂停秒数 / 是否作废）。
   */
  addPomodoro: (
    id: string,
    mode: string,
    seconds: number,
    note: string,
    finish: boolean,
    extra?: PomodoroExtra,
  ) => Promise<boolean>;
  /** 「再次设定时间提醒」：到点在首页动态区出现；**C 批起一条待办可以排多条**（靠 key 区分） */
  scheduleTodoRemind: (
    id: string,
    fireAt: string,
    key?: string,
    note?: string,
  ) => Promise<boolean>;
  /** C 批：删掉某一条提醒（只删点名那条） */
  deleteReminder: (id: string) => Promise<boolean>;
  /** 清掉所有「来源已移除」的待办 */
  purgeRemovedTodos: () => Promise<boolean>;
  /** 清空回收站（`notes/_trash/`）—— **唯一真删笔记**的操作，界面负责二次确认 */
  purgeTrash: () => Promise<boolean>;
  saveConfig: (patch: Partial<Config>, okText?: string) => Promise<boolean>;
}

const toast = (text: string, kind: "info" | "success" | "error" = "info") =>
  useUi.getState().toast(text, kind);

/**
 * 把一篇刚落盘的笔记就地替换进列表（不整篇重拉四个文件）。
 *
 * 列表按 `updatedAt` 倒序 —— 跟后端 `note::list` 的排法保持一致，
 * 否则界面上的顺序会和重启后不一样。
 */
function replaceNote(notes: Note[], note: Note): Note[] {
  return [note, ...notes.filter((one) => one.id !== note.id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/**
 * 把一条待办就地换掉（找不到就追加）。
 *
 * 写操作成功后用**后端返回的那个对象**校准界面 —— 后端会顺手改一些字段
 * （标完成时盖 `doneAt`、`sync_markers` 同步标题、番茄钟追加记录），
 * 只按前端自己的猜测更新就会和磁盘对不上。
 */
function withTodo(todos: Todo[], updated: Todo): Todo[] {
  return todos.some((one) => one.id === updated.id)
    ? todos.map((one) => (one.id === updated.id ? updated : one))
    : [...todos, updated];
}

export const useData = create<DataState>((set, get) => ({
  infos: [],
  notes: [],
  todos: [],
  reminders: [],
  countdowns: [],
  config: defaultConfig(),
  loading: false,
  ready: false,
  focusRef: null,

  setFocusRef: (focusRef) => set({ focusRef }),

  loadConfig: async () => {
    try {
      const config = await api.configGet();
      set({ config });
      // 主题是设置的一部分：读回来就应用（这样"重开还记得"）
      useUi.getState().setTheme(config.theme);
    } catch (error) {
      toast(`读取设置失败：${String(error)}`, "error");
      set({ config: defaultConfig() });
    }
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const [infos, notes, todos, reminders, countdowns] = await Promise.all([
        api.infoList(),
        api.noteList(),
        api.todoList(),
        api.reminderList(),
        api.countdownList(),
      ]);
      set({ infos, notes, todos, reminders, countdowns, ready: true });
      await get().loadConfig();
    } catch (error) {
      toast(`读取数据失败：${String(error)}`, "error");
      set({ ready: true });
    } finally {
      set({ loading: false });
    }
  },

  createInfo: async (text) => {
    const value = text.trim();
    if (!value) {
      toast("先写点什么再回车", "info");
      return false;
    }
    try {
      await api.infoCreate(value);
      await get().refresh();
      toast("已保存", "success");
      return true;
    } catch (error) {
      toast(`保存失败：${String(error)}`, "error");
      return false;
    }
  },

  createImageInfos: async (paths) => {
    if (paths.length === 0) return false;
    let saved = 0;
    for (const path of paths) {
      try {
        const rel = await api.assetImport(path);
        await api.infoCreate("", "image", [], rel);
        saved += 1;
      } catch (error) {
        toast(`图片没能收下：${String(error)}`, "error");
      }
    }
    if (saved === 0) return false;
    await get().refresh();
    toast(saved > 1 ? `已存下 ${saved} 张图片` : "图片已存下", "success");
    return true;
  },

  pasteImageInfo: async (file, text) => {
    try {
      const rel = await api.assetWriteImage(await fileToBase64(file));
      await api.infoCreate((text ?? "").trim(), "image", [], rel);
      await get().refresh();
      toast("图片已存下", "success");
      return true;
    } catch (error) {
      toast(`图片没能收下：${String(error)}`, "error");
      return false;
    }
  },

  updateInfo: async (info, okText) => {
    try {
      await api.infoUpdate(info);
      await get().refresh();
      if (okText) toast(okText, "success");
      return true;
    } catch (error) {
      toast(`保存失败：${String(error)}`, "error");
      return false;
    }
  },

  deleteInfo: async (id) => {
    try {
      const removed = await api.infoDelete(id);
      await get().refresh();
      if (!removed) {
        toast("这条信息已经不在了（可能刚被删过）", "info");
        return false;
      }
      toast("已删除", "success");
      return true;
    } catch (error) {
      toast(`删除失败：${String(error)}`, "error");
      return false;
    }
  },

  linkToNote: async (infoId, options) => {
    try {
      const result = await api.infoLinkNote(infoId, options);
      await get().refresh();
      toast(`已联动到《${result.noteTitle}》`, "success");
      return result;
    } catch (error) {
      toast(`联动到认知区失败：${String(error)}`, "error");
      return null;
    }
  },

  linkToTodo: async (infoId) => {
    try {
      const todo = await api.infoLinkTodo(infoId);
      await get().refresh();
      toast(`已建为待办《${todo.title}》`, "success");
      return todo;
    } catch (error) {
      toast(`建为待办失败：${String(error)}`, "error");
      return null;
    }
  },

  dismissReminder: async (id) => {
    try {
      const done = await api.reminderDismiss(id);
      await get().refresh();
      return done;
    } catch (error) {
      toast(`操作失败：${String(error)}`, "error");
      return false;
    }
  },

  snoozeReminder: async (id, minutes = 15) => {
    try {
      const updated = await api.reminderSnooze(id, minutes);
      await get().refresh();
      if (updated) toast(`${minutes} 分钟后再提醒`, "success");
      return updated != null;
    } catch (error) {
      toast(`操作失败：${String(error)}`, "error");
      return false;
    }
  },

  createNote: async (title, kind, content) => {
    try {
      const note = await api.noteCreate(title, kind, content);
      await get().refresh();
      return note;
    } catch (error) {
      toast(`新建笔记失败：${String(error)}`, "error");
      return null;
    }
  },

  deleteNote: async (id) => {
    try {
      const removed = await api.noteDelete(id);
      await get().refresh();
      return removed;
    } catch (error) {
      toast(`删除笔记失败：${String(error)}`, "error");
      return false;
    }
  },

  /**
   * 保存笔记：**就地更新列表**，不整篇重拉。
   *
   * 编辑器是边打字边保存的，每次都全量刷新太浪费；而且 Rust 那边只有"真的动过
   * 待办"才会广播 `data-changed`（见 `commands::note_save` 的注释）。
   * 列表按 `updatedAt` 倒序，跟后端 `note::list` 的排法保持一致。
   */
  saveNote: async (note) => {
    try {
      const saved = await api.noteSave(note);
      set((state) => ({ notes: replaceNote(state.notes, saved) }));
      return saved;
    } catch (error) {
      toast(`保存笔记失败：${String(error)}`, "error");
      return null;
    }
  },

  /**
   * 跑一个树操作（M4）：Rust 侧读盘拿最新 → 改一处 → 原子写，返回整篇 Note。
   *
   * 这里只做两件事：把返回的 Note 就地换进列表 + 出错弹 Toast。
   * **不整篇重拉**：树操作不会动 todos/info/reminders，重拉纯属浪费
   * （和 `saveNote` 的就地更新同构，也是 `note_save` 那条广播例外的一脉相承）。
   */
  /**
   * 只改标题 + 正文（**手机端专用**，2026-10-06 P0-1 修）。
   *
   * ⚠️ 为什么不能让手机端继续用 `saveNote`：那是整篇覆盖，手机手上那份 `root` 是同步来的旧副本，
   * 一旦在手机上保存过树笔记，就会把电脑侧更新过的树节点抹掉（真事故）。
   */
  /** P0-1：手机在文本页写的树笔记正文 → 补成树节点（幂等） */
  appendTreeText: async (noteId, text) => {
    try {
      const saved = await api.noteTreeAppendText(noteId, text);
      set((state) => ({ notes: replaceNote(state.notes, saved) }));
      return saved;
    } catch (error) {
      toast(`把正文补进树失败：${String(error)}`, "error");
      return null;
    }
  },

  setNoteText: async (noteId, title, content) => {
    try {
      const saved = await api.noteSetText(noteId, title, content);
      set((state) => ({ notes: replaceNote(state.notes, saved) }));
      return saved;
    } catch (error) {
      toast(`保存笔记失败：${String(error)}`, "error");
      return null;
    }
  },

  applyTreeOp: async (run) => {
    try {
      const result = await run();
      set((state) => ({ notes: replaceNote(state.notes, result.note) }));
      return result;
    } catch (error) {
      toast(String(error), "error");
      return null;
    }
  },

  setTreeTitle: async (noteId, title) => {
    try {
      const saved = await api.noteTitleSet(noteId, title);
      set((state) => ({ notes: replaceNote(state.notes, saved) }));
      return saved;
    } catch (error) {
      toast(`改标题失败：${String(error)}`, "error");
      return null;
    }
  },

  /**
   * 把笔记移到某个分组（空串 = 移出分组）—— M8 方案 A。
   *
   * 和 `setTreeTitle` 一样是**就地更新**：后端只回改了 `group` 那一篇，
   * 拿返回值替换列表里那一项即可，不用整表重拉。
   */
  setNoteGroup: async (noteId, group) => {
    try {
      const saved = await api.noteSetGroup(noteId, group);
      set((state) => ({ notes: replaceNote(state.notes, saved) }));
      return saved;
    } catch (error) {
      toast(`改分组失败：${String(error)}`, "error");
      return null;
    }
  },

  ensureTreeRoot: async (noteId) => {
    try {
      const fixed = await api.noteTreeEnsureRoot(noteId);
      set((state) => ({ notes: replaceNote(state.notes, fixed) }));
      return fixed;
    } catch (error) {
      toast(`补中心主题失败：${String(error)}`, "error");
      return null;
    }
  },

  toggleMarker: async (noteId, markerKey, text, checked) => {
    const before = get().todos;
    // 先就地点亮（别等一趟往返）；成功后会收到 data-changed 再校准
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.source?.markerKey === markerKey
          ? {
              ...todo,
              status: checked ? "done" : "open",
              doneAt: checked ? new Date().toISOString() : undefined,
            }
          : todo,
      ),
    }));

    try {
      const updated = await api.noteMarkerToggle(noteId, markerKey, text, checked);
      set((state) => ({
        todos: state.todos.some((one) => one.id === updated.id)
          ? state.todos.map((one) => (one.id === updated.id ? updated : one))
          : [...state.todos, updated],
      }));
      return true;
    } catch (error) {
      set({ todos: before }); // 失败就拉回原样，别让界面骗人
      toast(`勾选没写进去：${String(error)}`, "error");
      return false;
    }
  },

  createTodo: async (title, plannedAt) => {
    try {
      const todo = await api.todoCreate(title, plannedAt);
      await get().refresh();
      return todo;
    } catch (error) {
      toast(`新建待办失败：${String(error)}`, "error");
      return null;
    }
  },

  // ── M5：执行区的写操作 ──
  //
  // 统一套路：**先本地就地更新**（界面立刻有反应）→ 调后端 → 成功用后端返回的
  // 权威对象校准 → 失败**拉回原样**再报错（不让界面骗人）。

  setTodoDone: async (id, done) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id
          ? {
              ...todo,
              status: done ? "done" : "open",
              doneAt: done ? new Date().toISOString() : undefined,
            }
          : todo,
      ),
    }));
    try {
      const updated = await api.todoSetDone(id, done);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`标完成没写进去：${String(error)}`, "error");
      return false;
    }
  },

  setTodoTitle: async (id, title) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) => (todo.id === id ? { ...todo, title } : todo)),
    }));
    try {
      const updated = await api.todoSetTitle(id, title);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`改标题失败：${String(error)}`, "error");
      return false;
    }
  },

  setTodoPlanned: async (id, plannedAt) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, plannedAt: plannedAt ?? undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetPlanned(id, plannedAt);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`设定时间失败：${String(error)}`, "error");
      return false;
    }
  },

  setTodoDue: async (id, dueAt) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, dueAt: dueAt ?? undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetDue(id, dueAt);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`设截止日期失败：${String(error)}`, "error");
      return false;
    }
  },

  /**
   * 重复规则（M9-6）：只改规则本身。
   *
   * 「勾完自动派下一条」**不在前端做** —— 派发要读「有没有已经派过」，
   * 那是后端一份数据说了算的事；前端只管把规则存下去。
   */
  setTodoRepeat: async (id, repeat) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, repeat: repeat ?? undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetRepeat(id, repeat);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`设重复失败：${String(error)}`, "error");
      return false;
    }
  },

  /**
   * 子任务三件事（M9-2）：加 / 勾 / 删。
   *
   * 都用同一套"先乐观更新、失败回滚"的写法 —— 勾选要**立刻**有反应，
   * 等一次磁盘写完再更新会让人觉得卡。
   */
  addSubtask: async (id, text) => {
    try {
      const updated = await api.todoSubtaskAdd(id, text);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      toast(`加子任务失败：${String(error)}`, "error");
      return false;
    }
  },

  toggleSubtask: async (id, subtaskId, done) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id
          ? {
              ...todo,
              subtasks: (todo.subtasks ?? []).map((sub) =>
                sub.id === subtaskId ? { ...sub, done } : sub,
              ),
            }
          : todo,
      ),
    }));
    try {
      const updated = await api.todoSubtaskToggle(id, subtaskId, done);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`勾子任务失败：${String(error)}`, "error");
      return false;
    }
  },

  removeSubtask: async (id, subtaskId) => {
    try {
      const updated = await api.todoSubtaskRemove(id, subtaskId);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      toast(`删子任务失败：${String(error)}`, "error");
      return false;
    }
  },

  setTodoQuadrant: async (id, quadrant) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, quadrant: quadrant ?? undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetQuadrant(id, quadrant);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`调整分类失败：${String(error)}`, "error");
      return false;
    }
  },

  /** D 批（2026-10-04）：移到某个分组（空串 = 移出）。乐观更新 + 失败回滚，照 `setTodoQuadrant` */
  setTodoGroup: async (id, group) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, group: group || undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetGroup(id, group);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`移到分组失败：${String(error)}`, "error");
      return false;
    }
  },

  // ── 倒计时（2026-10-04）───────────────────────────────────────────────
  createCountdown: async (title, date, note) => {
    try {
      const one = await api.countdownCreate(title, date, note);
      set((state) => ({ countdowns: [...state.countdowns, one] }));
      return one;
    } catch (error) {
      toast(`加倒计时失败：${String(error)}`, "error");
      return null;
    }
  },

  updateCountdown: async (id, patch) => {
    const before = get().countdowns;
    set((state) => ({
      countdowns: state.countdowns.map((one) => (one.id === id ? { ...one, ...patch } : one)),
    }));
    try {
      const saved = await api.countdownUpdate(id, patch);
      set((state) => ({
        countdowns: state.countdowns.map((one) => (one.id === id ? saved : one)),
      }));
      return true;
    } catch (error) {
      set({ countdowns: before });
      toast(`改倒计时失败：${String(error)}`, "error");
      return false;
    }
  },

  deleteCountdown: async (id) => {
    const before = get().countdowns;
    set((state) => ({ countdowns: state.countdowns.filter((one) => one.id !== id) }));
    try {
      await api.countdownDelete(id);
      return true;
    } catch (error) {
      set({ countdowns: before });
      toast(`删倒计时失败：${String(error)}`, "error");
      return false;
    }
  },

  setFocusNote: async (id, text) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, focusNote: text || undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetFocusNote(id, text);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`「须知」没存上：${String(error)}`, "error");
      return false;
    }
  },

  setTodoCustomMinutes: async (id, minutes) => {
    const before = get().todos;
    set((state) => ({
      todos: state.todos.map((todo) =>
        todo.id === id ? { ...todo, customMinutes: minutes ?? undefined } : todo,
      ),
    }));
    try {
      const updated = await api.todoSetCustomMinutes(id, minutes);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`番茄时长没存上：${String(error)}`, "error");
      return false;
    }
  },

  /**
   * **新建一条自由档案**（2026-10-11 · 用户反馈第 2 条「两个方案都要有」，v2.21.0）。
   *
   * 跟 `archiveOne` 的区别：这条不是在别处生的，**取不出来**（没有原位），
   * 所以这里**不给"撤销"按钮** —— 想清掉就去档案库里删（删之前后端照规矩留档）。
   */
  archiveCreate: async (title, content) => {
    try {
      const entry = await api.archiveCreate(title, content);
      useUi.getState().toast(`已新建档案「${entry.title}」`, "success");
      return entry.id;
    } catch (error) {
      useUi.getState().toast(`新建档案失败：${String(error)}`, "error");
      return null;
    }
  },

  archiveOne: async (kind, id, title) => {
    try {
      const entry = await api.archivePut(kind, id);
      // 原位那边要从列表里消失（后端已经把它从原文件里挪走了）
      await get().refresh();
      const where = kind === "note" ? "认知区" : kind === "info" ? "信息区" : "执行区";
      // M15：5 秒「撤销」—— 误点了能立刻拿回来（toast 现在支持动作按钮）
      useUi.getState().toast(`「${title}」已收进档案库（随时能取出）`, "success", {
        label: "撤销",
        run: () => {
          void (async () => {
            try {
              await api.archiveRestore(entry.id);
              await get().refresh();
              useUi.getState().toast(`已放回${where}`, "success");
            } catch (error) {
              useUi.getState().toast(`撤销失败：${String(error)}`, "error");
            }
          })();
        },
      });
      return true;
    } catch (error) {
      useUi.getState().toast(`收进档案库失败：${String(error)}`, "error");
      return false;
    }
  },

  reorderTodos: async (orderedIds) => {
    const before = get().todos;
    // 本地先按新顺序排好（后端返回的才是权威）
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    set((state) => ({
      todos: [...state.todos].sort((a, b) => {
        const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ra - rb || a.order - b.order;
      }),
    }));
    try {
      const items = await api.todoReorder(orderedIds);
      set({ todos: items });
      return true;
    } catch (error) {
      set({ todos: before });
      toast(`排序没存住：${String(error)}`, "error");
      return false;
    }
  },

  deleteTodo: async (id) => {
    try {
      await api.todoDelete(id);
      await get().refresh();
      return true;
    } catch (error) {
      toast(`删除待办失败：${String(error)}`, "error");
      return false;
    }
  },

  addPomodoro: async (id, mode, seconds, note, finish, extra) => {
    try {
      const updated = await api.todoAddPomodoro(id, mode, seconds, note, finish, extra);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      return true;
    } catch (error) {
      toast(`番茄钟没记上：${String(error)}`, "error");
      return false;
    }
  },

  scheduleTodoRemind: async (id, fireAt, key, note) => {
    try {
      const updated = await api.todoScheduleRemind(id, fireAt, key, note);
      set((state) => ({ todos: withTodo(state.todos, updated) }));
      await get().refresh(); // 提醒本身要跟着刷新，首页动态区才看得到
      return true;
    } catch (error) {
      toast(`设提醒失败：${String(error)}`, "error");
      return false;
    }
  },

  deleteReminder: async (id) => {
    try {
      const removed = await api.reminderDelete(id);
      await get().refresh(); // 清单跟着变（⚙ 弹窗读的就是 store.reminders）
      if (!removed) {
        toast("这条提醒已经不在了（可能刚被删过）", "info");
        return false;
      }
      toast("提醒已删掉", "success");
      return true;
    } catch (error) {
      toast(`删提醒失败：${String(error)}`, "error");
      return false;
    }
  },

  purgeRemovedTodos: async () => {
    try {
      const removed = await api.todoPurgeRemoved();
      await get().refresh();
      if (removed > 0) toast(`清掉了 ${removed} 条来源已移除的待办`, "success");
      else toast("没有可清理的待办");
      return true;
    } catch (error) {
      toast(`清理失败：${String(error)}`, "error");
      return false;
    }
  },

  purgeTrash: async () => {
    try {
      const removed = await api.trashPurge();
      await get().refresh();
      if (removed > 0) toast(`清空了回收站（${removed} 个文件）`, "success");
      else toast("回收站本来就是空的");
      return true;
    } catch (error) {
      toast(`清空回收站失败：${String(error)}`, "error");
      return false;
    }
  },

  saveConfig: async (patch, okText) => {
    const next: Config = { ...get().config, ...patch };
    set({ config: next }); // 先本地生效（主题要立刻看到变化），失败再回滚
    if (patch.theme) useUi.getState().setTheme(patch.theme);

    try {
      const saved = await api.configSave(next);
      set({ config: saved });
      // E 批（2026-10-03）：挂件那几项（开关 / 尺寸 / 贴法）改了要**当场重摆一次**，
      // 不然用户得先关掉再打开才看得到效果。
      // ⚠️ 只在 patch 真的带了 `widget` 时才调 —— 免得每次改字号都去动窗口。
      if (patch.widget) {
        void api.widgetApply().catch((error: unknown) => {
          console.error("[东方摩耶堂] 按配置重摆挂件失败", error);
        });
      }
      if (okText) toast(okText, "success");
      return true;
    } catch (error) {
      toast(`保存设置失败：${String(error)}`, "error");
      await get().loadConfig();
      return false;
    }
  },
}));

/**
 * 当前要显示的提醒：最新一条"已弹出"的（关掉应用再打开也还在，直到用户处理）。
 *
 * `kind` 用来把两类提醒分开：顶部横幅那四个按钮（联动到认知区 / 建为待办 /
 * 稍后提醒 / 不再提醒）是**信息提醒专属**的，拿一条「待办提醒」去显示会张冠李戴
 * （文案会变成"你在 45 分钟前的〔〕信息还没推进下一步"，分类还是空的）。
 * 所以横幅只要 `info-stale`，`todo-remind` 走首页动态区。
 */
export function activeReminder(
  reminders: Reminder[],
  kind?: Reminder["kind"],
): Reminder | null {
  const fired = reminders
    .filter((item) => item.status === "fired" && (!kind || item.kind === kind))
    .sort((a, b) => b.fireAt.localeCompare(a.fireAt));
  return fired[0] ?? null;
}
