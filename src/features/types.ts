/**
 * 与 Rust 端一一对应的数据类型（字段名统一 camelCase）。
 * 后端真源在 `src-tauri/src/models.rs`，改一处记得改另一边。
 */
import type { ThemeId } from "../shared/themes";
import type { ToolbarAction } from "./notes/format";

// ── 信息区 ──
export type InfoKind = "text" | "image";
export type InfoStatus = "pending" | "linked";

export interface Link {
  targetKind: "note" | "todo";
  targetId: string;
  titleSnapshot: string;
  at: string;
}

export interface Info {
  id: string;
  kind: InfoKind;
  text: string;
  /** 图片相对路径：assets/xxxx.png */
  assetPath?: string;
  /** ISO 8601（后端盖章，可直接按字符串排序） */
  createdAt: string;
  /** 最后一次修改时间；老数据里可能为空 */
  updatedAt?: string;
  categories: string[];
  status: InfoStatus;
  links: Link[];
}

// ── 设置 ──
/** 主题：内置三态 + M16-B 的七套（那七套是"做给别人用的"，内置三态仍是默认） */
export type ThemeMode = "light" | "dark" | "system" | ThemeId;

export interface Shortcuts {
  toggleSmallWindow: string;
  quickInfo: string;
  openHome: string;
  openTodos: string;
  startPomodoro: string;
}

export interface RemindersConfig {
  infoStaleEnabled: boolean;
  infoStaleMinutes: number;
  /**
   * C 批（2026-10-02）：提示音档位。`"ding"` 叮 | `"triple"` 三连叮 | `"low"` 低鸣 | `"none"` 静音。
   *
   * ⚠️ 声音是 **Web Audio 现场合成**的（`shared/sound.ts`），**没有音频文件、不联网**。
   */
  soundKind: SoundKind;
  /** 音量 0~100（0 = 不出声） */
  soundVolume: number;
  /** 响几声（1~5） */
  soundTimes: number;
}

/** 提示音档位（C 批） */
export type SoundKind = "ding" | "triple" | "low" | "none";

export interface HomeSticky {
  reminders: boolean;
  singleDayItinerary: boolean;
  recentTodos: boolean;
  /** #8（2026-10-21）：十字待办（四象限）—— 从执行区搬到首页后的常驻项开关 */
  quadrant: boolean;
}

/** 小窗出现在哪儿（B4：居中 / 跟随鼠标） */
export type SmallPosition = "center" | "mouse";

export interface WindowConfig {
  smallPosition: SmallPosition;
  /** 跟随鼠标时，窗口左上角相对光标的偏移（像素） */
  smallMouseOffset: number;
  /** M10-3：关窗口是收进托盘（true，默认）还是直接退出 */
  closeToTray: boolean;
}

/**
 * M13-B：番茄钟「意外中断」的设置（存 `config.json` 的 `focus` 段）。
 *
 * ⚠️ Rust 侧 `FocusConfig` 字段逐个对应，改一边就要改另一边。
 */
export interface FocusConfig {
  /** 多久没动键鼠算「疑似离开」（秒），默认 90 */
  awayThresholdSeconds: number;
  /**
   * 锁屏 / 休眠时**自动暂停**。
   * 🔴 用户 2026-09-26 定：**只有这两种才自动暂停** —— 单纯"没操作"永远只做记号、计时不停。
   */
  pauseOnLock: boolean;
  /** 番茄结束时要不要问「计入 / 作废」；关掉就默认按「计入」记 */
  askOnFinish: boolean;
  /**
   * M13-C：手动挑的格言「留一整天」—— 本地日期（`YYYY-MM-DD`）与格言 id。
   * 当天且那条格言还在 → 用它；否则回到"今天这一句"自动挑。
   */
  mottoPickDate: string;
  mottoPickId: string;
  /**
   * C 批（2026-10-02，用户脑图第 8 条「工作时间进行时，随机时间弹出提醒我」）。
   *
   * ⚠️ 我按**固定间隔**做（默认 45 分钟），不是真随机 —— 随机间隔真用起来没法预判；
   * 提示**只出现在专注小窗上**（不弹窗、不打断，也不写进数据）。默认**关**。
   */
  workPromptEnabled: boolean;
  /** 每隔多少分钟提示一次（默认 45） */
  workPromptMinutes: number;
  /**
   * 2026-10-05（v1.14.0）：**自定义番茄时长**（分钟）—— 设置里预设一次，
   * 番茄面板打开时就按它开始，不必每场再进时长那一行输一遍。
   * 用户原话：「可以在小齿轮那里设置自定义时间，不必再开始之后再设置」。
   */
  customMinutes: number;
}

/**
 * M15：一条档案（收进档案库的东西；来源可能是信息 / 笔记 / 待办）。
 *
 * 🔴 **存的是"整条快照"，不是"一个标题"**（取出时要逐字段复原）。
 */
export interface ArchiveEntry {
  id: string;
  /**
   * 来源：`info` 信息 ｜ `note` 笔记 ｜ `todo` 待办 ｜ **`free` 自由档案**。
   *
   * `free`（2026-10-11 用户反馈第 2 条，v2.21.0）＝**直接在档案库里新建的**那一种：
   * 没有原位、取不出来，快照形状固定是 `{ title, content }`。
   */
  kind: "info" | "note" | "todo" | "free";
  /** 列表上显示的标题 */
  title: string;
  /** 一行摘要 */
  summary: string;
  /** 整条原记录的 JSON 快照（形状跟着 `kind` 走：`Info` / `Note` / `Todo` / 自由档案的 `{title,content}`） */
  snapshot: Record<string, unknown>;
  archivedAt: string;
  /** 最后一次修改时间；老数据里可能为空 */
  updatedAt?: string;
  /** 你自己给这条档案写的一句话（可空） */
  note: string;
}

/**
 * M14-B：一条批注。锚点**不存行号**（正文一改就全错位），存"原话快照 + 前后文 + 句子哈希"
 * —— 重定位算法见 `features/notes/annotations.ts`。
 */
export interface Annotation {
  id: string;
  /** 属于哪篇笔记 */
  noteId: string;
  /** 被批注的那句话（原样快照） */
  quote: string;
  /** 原句**前 12 字**（改字后重新找位置用） */
  prefix: string;
  /** 原句**后 12 字** */
  suffix: string;
  /** 句子内容的哈希（快路径：没改过就直接命中） */
  hash: string;
  /** 你写的批注正文 */
  text: string;
  createdAt: string;
  /** 最后一次修改时间；老数据里可能为空 */
  updatedAt?: string;
}

/** M14：档案区（批注栏属于它这一族；M15 的档案库入口会接同一个开关） */
/** E 批（2026-10-03）：桌面挂件（类 widget 的常驻展示） */
export interface WidgetConfig {
  /** 开不开（**默认关**：这种常驻的东西得用户主动要） */
  enabled: boolean;
  /** `"small"` 只格言 ｜ `"mid"` 格言+今日待办+番茄（默认）｜ `"big"` 再加时钟与信息 */
  size: WidgetSize;
  /** 显示哪几格 */
  show: WidgetSlot[];
  /** 兼容旧配置；界面不再提供真桌面层，实际统一按置顶浮窗运行。 */
  layer: WidgetLayer;
  /** 上次停在哪儿（物理像素）；没摆过就是 undefined */
  pos?: { x: number; y: number };
}

export type WidgetSize = "small" | "mid" | "big";
/** `desktop` 仅为旧配置兼容保留。 */
export type WidgetLayer = "top" | "desktop";
export type WidgetSlot = "motto" | "todos" | "pomodoro" | "info" | "clock" | "countdown";

export interface ArchiveConfig {
  /**
   * 「启用档案区」。🔴 用户 2026-09-26 定：**默认 false** ——
   * 关着时认知区**不显示批注页签**，去设置里打开才出现。
   */
  enabled: boolean;
}

export interface Config {
  theme: ThemeMode;
  uiFont: string;
  bodyFont: string;
  fontSize: number;
  dataDir: string;
  shortcuts: Shortcuts;
  reminders: RemindersConfig;
  homeSticky: HomeSticky;
  backupKeep: number;
  window: WindowConfig;
  focus: FocusConfig;
  archive: ArchiveConfig;
  /** E 批：桌面挂件 */
  widget: WidgetConfig;
  /** P2-D：手机文本页悬浮球停在哪（球可拖，松手吸附左右边） */
  mobileToolbarBall: MobileToolbarBall;
  /** 手机端：点开笔记默认进「阅读」还是「编辑」（默认 read；只影响手机端） */
  noteOpenMode: "read" | "edit";
  /**
   * 认知区列表的**默认折叠方式**（2026-10-11 用户反馈第 4 条，两端都用这一个）。
   *
   * `"expand"` = 全部展开（默认，跟老行为一致）；
   * `"collapse-grouped"` = **分好类的收起来、没分类的展开**（用户原话的那条愿景）。
   * ⚠️ 只是初始形态：当次会话里用户手点过的折叠以他点的为准。
   */
  cognitionGroupDefault: "expand" | "collapse-grouped";
  /** 编辑辅助栏显示哪些 Markdown 按钮、按什么顺序（撤销/重做/插图不在其中，始终保留） */
  toolbarActions: ToolbarAction[];
}

/**
 * 手机文本页悬浮球的位置（P2-D）。
 *
 * ⚠️ 存**侧 + 距顶**而不是 `{x,y}`：换机型 / 横竖屏时写死的 `x` 会落到屏幕外，`side` 不会。
 */
export interface MobileToolbarBall {
  side: "left" | "right";
  /** 距屏幕顶部多少像素（前端会夹进可视范围） */
  y: number;
}

/** 默认设置：浏览器预览模式、或配置文件读不出来时用（与 Rust 端 Default 一致） */
export function defaultConfig(): Config {
  return {
    theme: "light",
    uiFont: "",
    bodyFont: "",
    fontSize: 16,
    dataDir: "",
    shortcuts: {
      toggleSmallWindow: "Ctrl+Space",
      quickInfo: "",
      openHome: "",
      openTodos: "",
      startPomodoro: "",
    },
    reminders: {
      infoStaleEnabled: true,
      infoStaleMinutes: 45,
      // C 批：默认「叮」一声、音量 60
      soundKind: "ding",
      soundVolume: 60,
      soundTimes: 1,
    },
    homeSticky: { reminders: true, singleDayItinerary: true, recentTodos: true, quadrant: true },
    backupKeep: 5,
    window: { smallPosition: "center", smallMouseOffset: 16, closeToTray: true },
    focus: {
      awayThresholdSeconds: 90,
      pauseOnLock: true,
      askOnFinish: true,
      mottoPickDate: "",
      mottoPickId: "",
      // C 批：工作中的定时提示**默认关**（这种"定时念叨"得他自己开）
      workPromptEnabled: false,
      workPromptMinutes: 45,
      // 2026-10-05（v1.14.0）：番茄默认 25 分钟（跟面板原来的默认档一致）
      customMinutes: 25,
    },
    archive: { enabled: false },
    // E 批：挂件默认**关**着（要用得自己去设置里开）
    widget: {
      enabled: false,
      size: "mid",
      show: ["motto", "todos", "pomodoro"],
      layer: "top",
    },
    // P2-D：球默认停在**右侧**、离顶 320px（他真机 393×873 上大概屏幕中间偏上）
    mobileToolbarBall: { side: "right", y: 120 },
    // B1（2026-10-07 用户反馈）：手机端点开笔记默认进「阅读」态；不习惯的话在设置里改成「编辑」
    noteOpenMode: "read",
    // ④（2026-10-11 用户反馈）：认知区默认全部展开 —— 想"分好类的收起来"就去设置里改
    cognitionGroupDefault: "expand",
    toolbarActions: [
      "bold",
      "italic",
      "h1",
      "h2",
      "bullet",
      "ordered",
      "marker",
      "code",
      "spoiler",
      "strike",
      "link",
      "toc",
    ],
  };
}

// ─────────────────────────── 信息分类（两级 · 可多选） ───────────────────────────

/** 两级之间用中点连接，存进 `Info.categories` 的就是 `组·细项` 这种字符串 */
export const CATEGORY_SEP = "·";

/** 分类树（PRD 5.1.2）：一级 3 个，二级是具体情形 */
export const CATEGORY_TREE: { group: string; leaves: string[] }[] = [
  {
    group: "主动冒出",
    leaves: [
      "随手写下",
      "大工程计划/愿景",
      "突然想起",
      "梦境/半梦半醒碎片",
      "情绪高峰/低谷念头",
      "反复出现的执念",
      "未完成的半句话/半张图",
    ],
  },
  {
    group: "被动接收",
    leaves: [
      "浏览手机电脑",
      "算法推送",
      "扫一眼划走但潜意识记住",
      "群聊/朋友圈碎片",
      "别人随口一说但你记住了",
    ],
  },
  {
    group: "被触发",
    leaves: [
      "身体感受触发记忆（气味/旋律/场景）",
      "由当前信息联想到旧信息",
    ],
  },
];

/** 一级分类名列表（筛选用） */
export const CATEGORY_GROUPS = CATEGORY_TREE.map((node) => node.group);

/** 组 + 细项 → 存储值 */
export function categoryValue(group: string, leaf: string): string {
  return `${group}${CATEGORY_SEP}${leaf}`;
}

/** 取一级分类（存的是 `组·细项`；万一是旧数据只存了细项，就原样当一级返回） */
export function categoryGroupOf(value: string): string {
  const idx = value.indexOf(CATEGORY_SEP);
  return idx > 0 ? value.slice(0, idx) : value;
}

/** 取二级细项（没有中点就返回原值） */
export function categoryLeafOf(value: string): string {
  const idx = value.indexOf(CATEGORY_SEP);
  return idx > 0 ? value.slice(idx + CATEGORY_SEP.length) : value;
}

/** 从一段文字里取一个当标题的短句（与 Rust 的 `title_from_text` 保持一致） */
export function titleFromText(text: string, max = 20): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(oneLine);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : oneLine;
}

/**
 * 一条信息在认知笔记里显示成什么文字（与 Rust `store::note::display_text` 保持一致）。
 *
 * 联动信息写进笔记时用的就是这段文字，预览要靠它把引用块对回具体哪条信息。
 */
export function infoDisplayText(info: Info): string {
  const text = info.text.trim();
  if (text.length > 0) return text;
  return info.assetPath ? `（图片）${titleFromText(info.assetPath, 24)}` : "（空信息）";
}

// ─────────────────────────── 认知笔记 ───────────────────────────

export type NoteKind = "doc" | "tree";

export interface TreeNode {
  id: string;
  text: string;
  assetPath?: string;
  collapsed: boolean;
  children: TreeNode[];
  /**
   * 这个节点是从哪条信息**联动**进来的（信息区 → 认知区，单向可见）。
   *
   * 画布靠它在卡片上显示「〔联动信息〕」来源标记、点标记跳回信息区。
   * 手建的节点没有这个字段。旧笔记文件里也没有，读出来是 undefined。
   */
  sourceInfoId?: string;
}

/**
 * 一次树操作的结果（与 Rust `store::tree::TreeOpResult` 一一对应）。
 *
 * `focusNodeId` 是操作完该选中/进入编辑的节点：新建时是新节点，删除时是它的父节点。
 * `removed` 是这次删掉/影响了几个节点（整枝删除给 toast 用）。
 */
export interface TreeOpResult {
  note: Note;
  focusNodeId: string | null;
  removed: number;
}

/** 拖动落点：变成子节点 / 插到前面 / 插到后面 */
export type DropPosition = "child" | "before" | "after";

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 联动进来的信息 id（信息区 → 认知区，单向可见） */
  sourceInfoIds: string[];
  /** 文本笔记正文（Markdown） */
  content: string;
  /** 树状图根节点 */
  root?: TreeNode;
  /**
   * 分组名（M8 方案 A）：空串 = 未分组。
   *
   * ⚠️ 后加的字段，老数据里没有 → 后端用 `#[serde(default)]` 兜着，
   * 前端也要按"可能是 undefined"处理（`note.group ?? ""`）。
   */
  group?: string;
}

/** 联动到认知区后后端回的简报 */
export interface LinkedNote {
  noteId: string;
  noteTitle: string;
  noteKind: NoteKind;
}

// ─────────────────────────── 待办 ───────────────────────────

export type TodoStatus = "open" | "done";
export type Quadrant = "q1" | "q2" | "q3" | "q4";
export type TodoSourceKind = "manual" | "note" | "info";

export interface TodoSource {
  kind: TodoSourceKind;
  noteId?: string;
  markerKey?: string;
  markerText?: string;
  /** 标记所在行号（0 基）：改字时靠它认出"这是同一行的待办"，就地改名而不是新建 */
  markerLine?: number;
  /** 这条标记长在哪个**树节点**上（M5；文本笔记没有）。树里改字靠它认人 */
  nodeId?: string;
  infoId?: string;
  /**
   * **来源已移除**（M5-1）：认知区里那条 `-[]` 标记被删掉了。
   *
   * 待办**不会**被删、完成状态也不动 —— 用户很可能已经照着做完了这件事，
   * 程序替他删掉就是丢东西。界面上只标一句「来源已移除」，留还是删由他决定。
   * 把那行标记加回来，这个标记会自动撤销（还是原来那条待办，带着勾选状态）。
   */
  sourceRemoved?: boolean;
}

export interface Pomodoro {
  mode: string;
  seconds: number;
  note: string;
  at: string;
  /**
   * M13-B：这次番茄里「疑似离开」累计的秒数（超过阈值那部分才算，不是整段）。
   * 老数据没有这三个字段 → 全部按 0 / false 读。
   */
  interruptedSeconds?: number;
  /** 疑似离开**发生了多少次**（每跨过一次阈值算一次，不是秒数） */
  interruptedTimes?: number;
  /** 锁屏 / 休眠期间**自动暂停**累计的秒数（这部分不算专注） */
  pausedSeconds?: number;
  /** 结束时用户选了「作废」：不计入有效专注，但**记录照留**（用户 2026-09-26 定的） */
  voided?: boolean;
}

/** M13-B：这次番茄算不算数 —— 有效专注时长（秒）。作废 = 0，其余 = 计划 − 暂停 */
export function pomodoroEffective(p: Pomodoro): number {
  if (p.voided) return 0;
  return Math.max(0, Math.floor(p.seconds) - Math.floor(p.pausedSeconds ?? 0));
}

/** 一条子任务（M9-2）：刻意做得很轻 —— 只有"写什么"和"做完了没" */
export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

/** 重复规则（M9-6）：每天 / 每周 / 每月。刻意只有三档 —— 这是"别忘了"，不是排班表 */
export type TodoRepeat = "daily" | "weekly" | "monthly";

export interface Todo {
  id: string;
  title: string;
  order: number;
  plannedAt?: string;
  /**
   * 截止日期（M9-1）：最晚什么时候必须完成，过了卡片上标红。
   *
   * 和 `plannedAt` 两回事：前者是"我打算什么时候做"，这个是"最晚什么时候得完成"。
   */
  dueAt?: string;
  /** 子任务清单（M9-2）：一条待办下面的小步骤，卡片上显示 `2/5` */
  subtasks?: Subtask[];
  /**
   * 重复规则（M9-6）：勾完这一条，后端会自动派一条下一次的
   * （时间往后推、子任务重置、状态回到未完成）。
   */
  repeat?: TodoRepeat;
  /** 这条是**从哪一条重复待办派出来的**（只用来防重复派发，界面上不显示） */
  repeatFrom?: string;
  status: TodoStatus;
  doneAt?: string;
  quadrant?: Quadrant;
  source: TodoSource;
  reminderAt?: string;
  pomodoros: Pomodoro[];
  /**
   * M13-C：这条待办的「须知」—— 点开始专注时飘在小窗上的**长期**备注
   * （"这件事要干什么 / 有什么规则"）。
   *
   * ⚠️ 跟 `pomodoros[].note` 是两回事：那个是"这一次做到哪了"（跟记录走），
   * 这个是"这件事的规则"（跟待办走，下次点开始还在）。别合并。
   */
  focusNote?: string;
  /**
   * 分组名（V2 打磨 D 批，2026-10-04）：跟认知区那套 `Note.group` 一样，
   * 就是个**标签**（不做文件夹树、不嵌套）。空/缺省 = 未分组。
   */
  group?: string;
  /**
   * **这一条待办自己的番茄时长（分钟）**（v1.15.0，用户拍板的"B 语义"）。
   *
   * 缺省（`undefined`）= **跟随设置里的全局值** `config.focus.customMinutes`；
   * 有值 = 这条待办自己用这个分钟数（背单词 15、写作业 45，各设各的）。
   * ⚠️ 后端 `Todo.custom_minutes` 是 `Option<u32>` 且带 `skip_serializing_if` —— 没设过就没有这个键。
   */
  customMinutes?: number;
  createdAt: string;
}

// ─────────────────────────── 提醒 ───────────────────────────

export type ReminderKind = "info-stale" | "todo-remind";
export type ReminderStatus = "pending" | "fired" | "dismissed";

export interface ReminderPayload {
  text: string;
  categoryText: string;
  /** C 批（2026-10-02）：这条提醒自己的一句说明（「提前 10 分钟」这种）；老数据是空串 */
  note: string;
}

export interface Reminder {
  id: string;
  kind: ReminderKind;
  /** 指向的信息 / 待办 id */
  refId: string;
  fireAt: string;
  status: ReminderStatus;
  payload: ReminderPayload;
  snoozedUntil?: string;
  /**
   * C 批（2026-10-02）：这条提醒的"身份" —— 同一条待办可以有多条提醒。
   *
   * 取值：`"at:<ISO>"` 手动那条 ｜ `"early:<分钟>"` 提前提醒；**老数据是空串**（按手动那条算）。
   */
  key: string;
}

// ─────────────────────────── 备份（M7） ───────────────────────────

/** 导出结果（`backup_export` 的返回） */
export interface BackupReport {
  /** 实际写出的 zip 路径 */
  file: string;
  /** 打进去的文件个数 */
  files: number;
  /** zip 大小（字节） */
  bytes: number;
}

/** 导入结果（`backup_import` 的返回） */
export interface ImportReport {
  /**
   * 覆盖之前**自动留下的那份**当前数据备份。
   * 用户对导入结果不满意时，用它再导回来就能回到导入前。
   */
  safetyBackup: string;
  /** 恢复出来的文件个数 */
  files: number;
}

// ─────────────────────── 笔记导出 / 导入（M27 / v2.18.0） ───────────────────────

/** 导出格式：`md` = 带 `# 标题` 的 Markdown；`txt` = 纯文本 */
export type ExportFormat = "md" | "txt";

/** 导出**一篇**的结果（`note_export_file` / `note_export_downloads` 的返回） */
export interface NoteExportReport {
  /** 主文件落到哪儿了：电脑端是完整路径，手机端是「下载/东方摩耶堂/xxx.md」 */
  file: string;
  /** 文件名主干（不含扩展名） */
  stem: string;
  /** 一共写了几个文件（1 = 只有正文；>1 = 连图片一起） */
  files: number;
  /** 其中图片几张 */
  images: number;
}

/** 批量导出（`notes_export_dir`）的结果 */
export interface NotesExportReport {
  dir: string;
  notes: number;
  files: number;
  images: number;
  /** 导出的标题 */
  titles: string[];
  /** 没导成的（标题 + 原因）—— 不许静默吞掉 */
  failed: string[];
}

/** 导入若干 md/txt（`notes_import_files`）的结果 */
export interface NotesImportReport {
  /** 导进来的笔记标题 */
  notes: string[];
  /** 连同收进来的图片张数 */
  images: number;
  failed: string[];
}

// ─────────────────────────── 关于 / 快捷键状态（M7） ───────────────────────────

/** `app_info`：版本 + 数据统计（PRD §5.5 的「关于」） */
export interface AppInfo {
  name: string;
  version: string;
  infoCount: number;
  noteCount: number;
  todoCount: number;
  assetCount: number;
  assetBytes: number;
  dataDir: string;
}

/**
 * `shortcut_status`：唤起小窗的快捷键现在啥情况。
 *
 * `registered === false` 表示**这个键在系统里根本没注册上**（被输入法或别的程序占了）——
 * 用户按了不会有任何反应，所以设置页必须把这件事说出来，不能让他以为是程序坏了。
 */
export interface ShortcutStatus {
  accelerator: string;
  registered: boolean;
  default: string;
}

// ─────────────────────────── 每日报告（M11-A） ───────────────────────────

/**
 * `daily_get`：某一天**用户手写的那部分**。
 *
 * ⚠️ 日报里的「完成了哪些 / 设计了哪些 / 填写了哪些」**不在这里** ——
 * 那三类是前端从 `todos` / `infos` **实时算**出来的（`features/schedule/aggregate.ts`）。
 * 同一个事实只留一个来源，免得"两处对不上"。
 */
export interface DailyReport {
  /** `YYYY-MM-DD`（**本地日期**，和界面上的"今天"同一个算法） */
  date: string;
  notes: DailyNote[];
  updatedAt: string;
}

/**
 * 一条手写说明。`key` 指出"这句话是说谁的"：
 * `todo:<待办 id>` / `info:<信息 id>` / `day`（当天小结）。
 *
 * ⚠️ 用 id、不用"第几条"：列表顺序会变，**位置锚点一改就全错位**。
 */
export interface DailyNote {
  key: string;
  text: string;
}

// ─────────────────────────── 奖状 / 证书（M12-A） ───────────────────────────

/**
 * 一张奖状 / 证书。
 *
 * 用户对这块的要求是"**界面简洁轻松上手、给自己情绪价值**"，所以字段只有四个（加一张图 + 置顶），
 * 没有分类、没有评分、没有排行榜。
 *
 * ⚠️ `date` 是**自由文本**（`2026-08-14` / `2026 年 6 月` / 空都行）——
 * 奖状不一定有确切日期，硬要 `YYYY-MM-DD` 等于逼你编一个。
 * 分年份时从里面抓前四位数字；抓不到就归到"没写日期"那一段。
 */
export interface Award {
  id: string;
  title: string;
  /** 谁给的（"自己发的"也行） */
  issuer: string;
  /** 什么时候（**自由文本**） */
  date: string;
  /** 写给自己的一句话 */
  note: string;
  /** 图片在 `assets/` 里的相对路径；没图就是 undefined —— **没图也能建** */
  assetPath?: string;
  /** 置顶（"我最得意的"永远排最前） */
  pinned: boolean;
  createdAt: string;
}

// ─────────────────────────── 格言 / 原则（M12-C） ───────────────────────────

/** 两类：别人的话 vs 自己定的规矩 */
export type MottoKind = "motto" | "rule";

/**
 * 一条格言 / 原则。
 *
 * 字段只有两个：**那句话** + **谁说的**（空着时界面按 `kind` 兜一句）。
 * ⚠️ **故意没有"置顶"** —— 用户 2026-09-26 明确说"去掉置顶功能"（格言不该排序）。
 */
export interface Motto {
  id: string;
  /** 那句话本身 */
  text: string;
  /** 谁说的 / 出处（可空） */
  from: string;
  kind: MottoKind;
  createdAt: string;
}

// ─────────────────────────── 倒计时（2026-10-04 · V2 打磨） ───────────────────────────

/**
 * 一个倒计时 = **某个日子 + 它是什么事**，显示「还有 N 天」。
 *
 * ⚠️ 名字：用户脑图里叫"日课（未来的倒数计时）"，但他 2026-10-04 定名**「倒计时」**，别再写"日课"。
 * ⚠️ `date` **只到天**（`YYYY-MM-DD`）：倒计时问的是"离那天还有几天"，存时刻会长出
 * "还有 0 天但已经过了"这种怪状态。天数**由前端按本地日历天现算**（见 `features/countdown/time.ts`）。
 */
export interface Countdown {
  id: string;
  title: string;
  /** 目标日 `YYYY-MM-DD` */
  date: string;
  note: string;
  /** 要不要显示在桌面挂件上（默认 true） */
  onWidget: boolean;
  /** 最后一次修改时间；老数据里可能为空 */
  updatedAt?: string;
}
// ─────────────────────────── 专注小窗（M13-A） ───────────────────────────

/**
 * 主窗推给**专注小窗**的那份状态（`emitTo("focus", "focus-state", …)`）。
 *
 * ⚠️ 计时状态的**权威在主窗**（`features/todos/Pomodoro.tsx`），小窗只是把它画出来 ——
 * 两边各跑一个计时器迟早对不上（"小窗显示 12:03、执行区显示 12:05"）。
 */
export interface FocusState {
  todoId: string;
  title: string;
  /** 来源那一行（"来自认知区《XX》·自动检测"这种） */
  sourceText?: string;
  mode: "countup" | "countdown" | "free";
  /** 已经走过的秒数（倒计时也用它，`target - elapsed` 才是剩余） */
  elapsed: number;
  /** 倒计时的目标秒数（正计时 / 不计时为 0） */
  target: number;
  note: string;
  // ───────── M13-B：意外中断（锁屏暂停 / 疑似离开）─────────
  /** 现在被自动暂停着（锁屏 / 休眠）—— 暂停期间倒计时**冻住** */
  paused?: boolean;
  /** 为什么暂停：`""` | `"lock"` | `"sleep"` */
  pauseReason?: string;
  /** 暂停累计秒数（这部分不算专注） */
  pausedSeconds?: number;
  /** 疑似离开累计秒数（超过阈值那部分） */
  interruptedSeconds?: number;
  /** 疑似离开发生了多少次 */
  interruptedTimes?: number;
  /** 此刻正处在"疑似离开"（计时仍在走） */
  awayNow?: boolean;
  /** 当前已经多久没动键鼠（秒）—— 小窗上那句「疑似离开 1 分 12 秒」用的就是它 */
  idleSeconds?: number;
  /** 刚从暂停里回来、等用户点「继续」—— 点之前倒计时一直冻着 */
  resumePending?: boolean;
  /**
   * B 批（2026-10-02）：**用户自己按的暂停**（跟锁屏/休眠那种"自动暂停"分开记）。
   * ⚠️ 小窗靠这个字段决定那颗按钮显示「⏸ 暂停」还是「▶ 继续」——
   * 不能只看 `paused`（那个把两种暂停合并了，小窗就分不出该不该给"继续"）。
   */
  manualPaused?: boolean;
  /**
   * C 批（2026-10-02）：工作的定时提示 —— 已经专注到这个秒数时提示过一次。
   * 小窗据此显示一句"已经专注 N 分钟"（`0` = 还没到过 / 这个功能关着）。
   */
  workPromptAtSeconds?: number;
  /** 用户按了「结束」但有疑似离开：小窗变成一张结算卡，等他选计入 / 作废 */
  settle?: FocusSettle | null;
  /**
   * M13-C：这条待办的「须知」（长期备注）。
   * ⚠️ 小窗上就地编辑它时**只发意图回来**，落盘由主窗做（写数据的窗口只有一个）。
   */
  focusNote?: string;
  /** M13-C：这次专注挂着的格言；`null` = 没挂（技能区一条都没有时整块不显示） */
  motto?: { text: string; from: string; kind: string } | null;
}

/** 结算卡上的那份信息（小窗与面板共用同一份，别各算各的） */
export interface FocusSettle {
  mode: "countup" | "countdown" | "free";
  /** 计划 / 已走的秒数 */
  seconds: number;
  interruptedSeconds: number;
  interruptedTimes: number;
  pausedSeconds: number;
}

/**
 * M13-B：Rust 侧监控线程每秒推一次的信号（`emitTo("main", "focus-tick", …)`）。
 *
 * ⚠️ **判定在 Rust**（键鼠空闲 / 锁屏 / 睡过都在系统层拿），前端只管显示与"要不要继续"。
 * 计时的权威仍在主窗，这里只是"外部世界发生了什么事"。
 */
export interface FocusTick {
  active: boolean;
  todoId: string;
  paused: boolean;
  /** `""` | `"lock"` | `"sleep"` */
  pauseReason: string;
  pausedSeconds: number;
  interruptedSeconds: number;
  interruptedTimes: number;
  /** 当前已经多久没动键鼠（秒）—— **系统真实空闲** */
  idleSeconds: number;
  /**
   * C 批（2026-10-02）：**从这次会话开始算起**的空闲秒数 —— 判定"疑似离开"用的就是它
   * （开场前就空闲几十分钟的话，那些不算这次被打断）。
   * ⚠️ 跟 `idleSeconds` 差一个"开场基线"，别混用：界面显示用前者、判定用后者。
   */
  idleSinceStartSeconds: number;
  /** 此刻正处在"疑似离开" */
  awayNow: boolean;
}
