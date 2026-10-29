/**
 * 「这一场专注」在浏览器存储里留的一份底（2026-10-05，v1.14.1 扩成"整场会话"）。
 *
 * # 为什么要有它
 *
 * 用户实测的 bug：**合上笔记本盖子睡一觉、回来之后，那一场番茄凭空消失了**
 * （面板显示「没有正在进行的待办」、「今天专注」也没多一条记录）。
 * 根因是**会话本身只活在内存里**：
 * - 前端 `store/focusSession.ts` 只存"是哪条待办"，**没有任何持久化**；
 * - `App.tsx` 是 `{focusTodo && <PomodoroPanel/>}`，主窗一被系统挂起重载，
 *   `focusTodo` 变回 `null` → 面板消失、没人再去读后端那份会话；
 * - `focusMonitorState()` 早就有了，但**前端一次都没调用过** —— 没有任何"接回去"的路径。
 *
 * 于是那一场既没人显示、也没人结算，成了"孤儿"。这里把**整场会话**存下来：
 * 是哪条待办 + 模式 + 时长 + **计时锚点** + 各数字 + 当时在不在跑。
 * 重载后 `App` 读它 → 找回待办 → 问后端会话还在不在 → 接回去（见 `focusSession.resume`）。
 *
 * # 四条规矩
 *
 * 1. **只可能是"这一场"的**：开始新一场时调 [`clearFocusNumbers`] 清掉；
 *    结算取数字时还要 `todoId` 对得上 —— 否则同一待办的下一次专注会被上一场的数字污染；
 * 2. **🔴 数字只增不减**：每秒那条底是"覆盖式"写的，但**决不允许把大数字写成小数字** ——
 *    进程重启后后端从 0 重新报数，若照单全收，本来记着"睡了 300 秒"的底会被 0 冲掉；
 * 3. **绝不编造**：这里只存"后端报过的数字 + 前端自己数的那些"，不自己算时长；
 * 4. **坏了不影响用**：存储读不出来 / 被禁用（无痕模式）就当没有，绝不抛错。
 */

/** 存储键（带应用前缀，免得跟别的页面撞） */
const KEY = "dsh.focus.numbers";

/** 计时模式（跟 `features/todos/Pomodoro.tsx` 里的 `PomodoroMode` 一致，这里不引它免得循环依赖） */
export type LiveMode = "countup" | "countdown" | "free";

/** 一场专注目前的完整状态（字段全是"后端报过的 + 前端自己数的"） */
export interface FocusNumbers {
  todoId: string;
  /** 锁屏 / 休眠自动暂停的累计秒数（后端算的） */
  pausedSeconds: number;
  /** 疑似离开的累计秒数（后端算的） */
  interruptedSeconds: number;
  /** 疑似离开的次数（后端算的） */
  interruptedTimes: number;
  /** 其中**用户手动暂停**的那部分秒数（前端自己数的：后端不知道手动暂停） */
  manualPausedSeconds: number;
  /** 写下的时刻（`Date.now()`）—— 重载后用它算"被挂起了多久" */
  savedAt: number;

  // ─────────── v1.14.1 新增：让"整场会话"能跨重载接回来 ───────────
  /** 待办标题（重载后立刻能显示，不必等列表到位） */
  todoTitle: string;
  /** 计时模式 */
  mode: LiveMode;
  /** 倒计时的时长（分钟）—— 重载后倒计时表盘要接着走 */
  minutes: number;
  /** **计时锚点**：`elapsed = (now - startedAt)/1000`，暂停靠"往后挪它"实现（面板里的老规矩） */
  startedAt: number;
  /** 写这份时**是不是在跑**（`false` = 暂停中 / 等用户点「继续」） */
  running: boolean;
}

/** 数字类字段（合并时**只增不减**；`savedAt` 例外，永远取新的） */
const MONOTONIC: Array<keyof FocusNumbers> = [
  "pausedSeconds",
  "interruptedSeconds",
  "interruptedTimes",
  "manualPausedSeconds",
];

/**
 * 写进来的那份：**数字必填，身份类字段可缺**。
 * 缺了就沿用上一份（见 [`rememberFocusNumbers`] 的合并规则）—— 让"只报数字"的老调用点照旧能用。
 */
export type FocusNumbersInput = Omit<
  FocusNumbers,
  "savedAt" | "mode" | "minutes" | "startedAt" | "running" | "todoTitle"
> &
  Partial<Pick<FocusNumbers, "mode" | "minutes" | "startedAt" | "running" | "todoTitle">>;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 读原始那条（不做 `todoId` 判断），坏了就 `null` */
function readRaw(): Partial<FocusNumbers> | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FocusNumbers> | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 记下这一场目前的数字（每秒一条 + 离开页面前一条）。
 *
 * 🔴 **合并规则（v1.14.1）**：数字类字段取"新值 / 旧值"里**大的那个**。
 * 为什么不能直接覆盖：进程重启后后端那份从 0 开始报，覆盖就把已经攒下的暂停秒数冲成 0 了。
 */
export function rememberFocusNumbers(numbers: FocusNumbersInput): void {
  try {
    const previous = readRaw();
    const sameSession = !!previous && previous.todoId === numbers.todoId;
    const merged: FocusNumbers = {
      todoId: numbers.todoId,
      // 身份类字段：写的人没给就沿用上一份 —— 面板里有些地方只报数字（比如手动暂停那一下），
      // 让它们把"锚点 / 模式 / 时长"冲成 0 就等于把整场会话弄丢了（这正是这次要修的 bug 的同类）
      mode: numbers.mode ?? (sameSession ? (previous!.mode as LiveMode) : undefined) ?? "countdown",
      minutes: num(numbers.minutes) || (sameSession ? num(previous!.minutes) : 0),
      startedAt: num(numbers.startedAt) || (sameSession ? num(previous!.startedAt) : 0),
      running:
        typeof numbers.running === "boolean"
          ? numbers.running
          : sameSession
            ? previous!.running !== false
            : true,
      todoTitle: numbers.todoTitle || (sameSession ? (previous!.todoTitle ?? "") : ""),
      savedAt: Date.now(),
      pausedSeconds: num(numbers.pausedSeconds),
      interruptedSeconds: num(numbers.interruptedSeconds),
      interruptedTimes: num(numbers.interruptedTimes),
      manualPausedSeconds: num(numbers.manualPausedSeconds),
    };
    // 同一个待办才允许"取最大"；换了待办就是新的一场（旧数字一律不认）
    if (sameSession) {
      for (const key of MONOTONIC) {
        const before = num(previous![key]);
        const now = num(merged[key]);
        if (before > now) (merged[key] as number) = before;
      }
    }
    window.localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // 存储被禁用 / 写满：只是少了一层兜底，绝不影响计时与结算
  }
}

/**
 * 读回**整场会话**（重载后 `App` 用它把会话接回来）。
 *
 * ⚠️ 跟 [`readFocusNumbers`] 的区别：这个**不检查 `todoId`** —— 它的用途正是
 * "我还不知道上次是哪条待办，先看看有没有一场没结束的"。
 */
export function readLiveSession(): FocusNumbers | null {
  const parsed = readRaw();
  if (!parsed || typeof parsed.todoId !== "string" || !parsed.todoId) return null;
  return {
    todoId: parsed.todoId,
    pausedSeconds: num(parsed.pausedSeconds),
    interruptedSeconds: num(parsed.interruptedSeconds),
    interruptedTimes: num(parsed.interruptedTimes),
    manualPausedSeconds: num(parsed.manualPausedSeconds),
    savedAt: num(parsed.savedAt),
    todoTitle: typeof parsed.todoTitle === "string" ? parsed.todoTitle : "",
    mode: parsed.mode === "countup" || parsed.mode === "free" ? parsed.mode : "countdown",
    minutes: num(parsed.minutes),
    startedAt: num(parsed.startedAt),
    running: parsed.running !== false,
  };
}

/**
 * 读回这一场目前的数字（结算时用）。
 *
 * ⚠️ `todoId` 对不上就返回 `null`：那是**另一场**专注留下的，混进来就是张冠李戴。
 */
export function readFocusNumbers(todoId: string): FocusNumbers | null {
  const parsed = readLiveSession();
  return parsed && parsed.todoId === todoId ? parsed : null;
}

/**
 * 清掉（开始新一场专注时调）。
 *
 * 🔴 **必须在 `start` 里清**：不清的话，同一条待办的下一次专注会把上一场的数字当自己的底。
 * 结算收尾（面板 ✕ / 结束之后）也要清 —— 否则下次开机会把已经结束的那场又"接回来"。
 */
export function clearFocusNumbers(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 同上：清不掉也不影响用
  }
}
