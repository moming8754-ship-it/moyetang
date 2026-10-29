/**
 * 番茄钟面板（M5-6；**2026-10-02 B 批从"模态弹窗"改成"右侧面板"**）。
 *
 * PRD §5.3：**正计时 / 倒计时 / 不计时** + 备注 + 显示来源文本（可跳转）；
 * **结束 → 自动把待办标记为完成，但不删除**（10.4 那条专门验这个）。
 *
 * 🔴🔴 **为什么不再是 `Modal`**（用户实测反馈的原话：「一旦开始待办，其他地方雾化，无法点击」）：
 * 原来这里套的是 `components/Modal` —— 那是 `fixed inset-0 + backdrop-blur` 的**全屏模态遮罩**，
 * 一开就把整个界面的鼠标吃掉。番茄钟是"一边计时一边干别的"的东西，**它不该是模态**。
 * 现在它是一块**普通面板**（不铺遮罩、不吞鼠标），挂在 `App.tsx` 上（见 `store/focusSession.ts`
 * 里写的"为什么不留在 TodoPage"）。
 *
 * 倒计时给了 25 / 5 / 1 分钟三档 —— 前两档是正常用的，**1 分钟是给验收脚本用的**：
 * 没人愿意在自动化里等真实的 25 分钟（这也是进度.md 第七节给 M5 提的做法）。
 *
 * ⚠️ 验收脚本的抓手（**别改名**）：`data-pomodoro` / `-mode-btn` / `-duration` / `-custom` /
 * `-clock` / `-mode` / `-interrupt` / `-resume` / `-continue` / `-away` / `-interrupted` /
 * `-focus-note` / `-note` / `-source` / `-cancel` / `-finish` / `-void` / `-count` /
 * **`-pause`（B 批新增）/ `-confirm`（B 批新增的二次确认条）**。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { focusMonitorStop, focusTraySet, focusWindowClose, mottoList } from "../api";
import type { PomodoroExtra } from "../api";
import { readFocusNumbers, rememberFocusNumbers } from "../../store/focusNumbers";
import type { FocusNumbers } from "../../store/focusNumbers";
import type { FocusState, FocusTick, Motto } from "../types";
import { useData } from "../../store/data";
import type { Todo } from "../types";
import { randomMotto, todayMotto } from "../skills/mottos";
import { clockText } from "./time";

export type PomodoroMode = "countup" | "countdown" | "free";

const MODE_LABEL: Record<PomodoroMode, string> = {
  countup: "正计时",
  countdown: "倒计时",
  free: "不计时",
};

/**
 * 常用时长档（分钟）。
 *
 * 2026-10-05（v1.14.0）：用户点名的"小齿轮里预设自定义时长"落地后，这一行加上了 45 / 60；
 * ⚠️ **原来的 5 / 1 两个档保留** —— `tools\m13` 那套验收就是拿它们跑短番茄的（删了会红）。
 */
const DURATIONS = [25, 45, 60, 5, 1] as const;
const DEFAULT_MINUTES = 25;

/**
 * 重载后"算不算被挂起过"的判据（秒）—— v1.14.1。
 *
 * 比后端 `focus.rs` 的 `SLEEP_GAP_SECONDS = 3` 松一点：普通页面重载本身要一两秒，
 * 拿 3 秒卡会把每次普通重载都记成"休眠暂停"；5 秒以上才算"机器睡了 / 被挂起了"。
 * ⚠️ 判错的代价不对称：**多记一点暂停**只是数字保守，**少记**就是用户的时间白丢（用户的红线）。
 */
const RESTORE_SUSPEND_GAP_SECONDS = 5;

/**
 * 本地日期 `YYYY-MM-DD`（M13-C 挑格言用）。
 * ⚠️ **不许**用 `toISOString().slice(0, 10)` —— 那是 UTC，晚上 8 点后会差一天（这坑项目里记过）。
 */
function localDay(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

interface PomodoroProps {
  todo: Todo;
  /**
   * 🔴 v1.14.1：**开机接回来的那一场**（`App` 从 `store/focusNumbers.ts` 那份底里读出来）。
   *
   * 有值时：把计时锚点 / 模式 / 时长恢复成上次那样，并在"确实被挂起过"时
   * 冻住计时 + 显示「已暂停 · 休眠」等用户点「继续」。
   * `rustAlive` = 后端那份会话还在（还在的话**绝不能**重开会话，否则它攒的暂停秒数会被清零）。
   */
  restore?: { record: FocusNumbers; rustAlive: boolean } | null;
  /** 来源那一行显示什么 */
  sourceText: string;
  onOpenSource?: () => void;
  /** 结束 / 到点：记一笔，并把待办标完成（后端只标完成、绝不删除） */
  onFinish: (
    mode: PomodoroMode,
    seconds: number,
    note: string,
    finish: boolean,
    extra?: PomodoroExtra,
  ) => void;
  onClose: () => void;
}

export default function Pomodoro({
  todo,
  restore,
  sourceText,
  onOpenSource,
  onFinish,
  onClose,
}: PomodoroProps) {
  const [mode, setMode] = useState<PomodoroMode>("countdown");
  // 2026-10-05（v1.14.0）：默认时长 = **设置里预设的那个**（用户："不必再开始之后再设置"）。
  // ⚠️ 用 useState 的惰性初始化读一次 config：之后用户在这一场里点档位/输数字**照旧能改**，
  //    只是"下一场"又会回到设置里那个值（那才是"预设"的意思）。
  const [minutes, setMinutes] = useState<number>(() => {
    // 🔴 v1.15.0：**先看这条待办自己设的**（卡片 ⚙ 里那一行「番茄时长」），没设才跟随设置里的全局值。
    // 用户拍板的语义 B：**每条待办各设各的**（背单词 15 分钟、写作业 45 分钟）。
    // ⚠️ 只当"开这一场时的默认值"：之后就归用户在这一场里拨（换档位 / 输数字），
    //    中途在 ⚙ 里改了设置也不回头动正在跑的这一场（免得把表盘从人手底下抽走）。
    const own = todo.customMinutes;
    if (typeof own === "number" && own >= 1) return Math.min(999, Math.round(own));
    const preset = useData.getState().config?.focus?.customMinutes;
    return typeof preset === "number" && preset >= 1 ? Math.min(999, Math.round(preset)) : DEFAULT_MINUTES;
  });
  /** 自定义输入框里正在打的东西（还没提交，所以和 `minutes` 分开） */
  const [customText, setCustomText] = useState("");
  const [note, setNote] = useState("");
  /** 已经走过的秒数（正计时从 0 往上，倒计时从目标往下） */
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number>(Date.now());
  const firedRef = useRef(false);

  // ─────────────── B 批（2026-10-02）②：「结束」的二次确认 ───────────────
  //
  // 用户原话：「开启待办后右下角的『结束』，说结束就结束有点搞笑，应该加个确认键」。
  // ⚠️ **确认条长在面板内部**（不弹 `ConfirmDialog`）—— 理由：那个也是全屏遮罩，
  //    在"番茄钟不再挡人"这一批里再叠一层遮罩就自相矛盾了。
  const [confirming, setConfirming] = useState(false);
  /** 二次确认条里点「继续专注」= 收起确认条（Esc 同效） */
  const cancelConfirm = useCallback(() => setConfirming(false), []);

  // ─────────────── B 批（2026-10-02）③：手动暂停 / 继续 ───────────────
  //
  // 语义（2026-10-02 定，稿子 `.spike\V2打磨-B批-专注面板设计稿.html` 那张表）：
  // - 手动暂停 → **计时冻住**，暂停那段**不计入专注**（算进 `pausedSeconds`）；
  // - **不留"被打断"的记号**（是你主动停的，不是被打断）；
  // - 和"锁屏/休眠自动暂停"**走同一套冻结机制**（`pausedRef` + 挪 `startedAt`），不另搞一套。
  const [manualPaused, setManualPaused] = useState(false);
  /** 手动暂停的那一段累计秒数（跟 Rust 那份"锁屏暂停秒数"相加后才是总数） */
  const manualPausedAccumRef = useRef(0);
  /** 手动暂停从哪天开始冻的 */
  const manualPausedAtRef = useRef(0);

  // ─────────────── M13-B：意外中断（锁屏 / 睡过 / 疑似离开）───────────────
  //
  // 判定全在 Rust（`focus.rs` 起一个每秒采样的线程），这里只收 `focus-tick`。
  // 两条规矩：
  // 1. **暂停期间倒计时必须冻住**（暂停那段不算专注）—— 冻的方式是把"开始时间"往后挪，
  //    而不是把 elapsed 存下来（那个每秒会被 interval 覆盖掉）；
  // 2. 解锁回来**不自动接着走**，先问一句「继续吗」—— 用户点了才继续。
  /** Rust 监控线程每秒推来的"外面发生了什么" */
  const [tick, setTick] = useState<FocusTick | null>(null);
  /** 刚从暂停里回来、等用户点「继续」；点之前倒计时一直冻着 */
  const [resumePending, setResumePending] = useState(false);
  /**
   * 接回来的那一场，**存盘时已经攒下的暂停秒数**（v1.14.1）。
   *
   * 为什么要有它：接回来时后端可能已经换了新会话（进程重启那条路），它报的 `pausedSeconds` 是 0 ——
   * 若只信 `tick`，面板上会显示成「刚才离开了 00:00」，用户会以为那 10 分钟白丢了。
   */
  const [restoredPausedSeconds, setRestoredPausedSeconds] = useState(0);
  /** 结束时若有疑似离开：先变成结算卡，等用户选「计入 / 作废」 */
  const [settle, setSettle] = useState<{
    mode: PomodoroMode;
    seconds: number;
    note: string;
    interruptedSeconds: number;
    interruptedTimes: number;
    pausedSeconds: number;
    /** 2026-10-05（v1.14.0）：总数里"手动暂停"那一段，报账时要单独给后端一份 */
    manualPausedSeconds: number;
  } | null>(null);
  /** 倒计时冻着吗（自动暂停中、或等用户点继续） */
  const pausedRef = useRef(false);
  /** 冻住的那一刻（恢复时用它把时间轴往后挪） */
  const pausedAtRef = useRef(0);
  /** 上一次看到的"暂停累计秒数"，用来算睡过去多久 */
  const lastPausedSecondsRef = useRef(0);

  // ─────────────── 🔴 v1.14.1：让"这一场"活过重载（用户实测 bug 的修法）───────────────
  /** `tick` 的最新值镜像：给"每秒存底 / 离开页面时存底"用，避免闭包拿到旧值 */
  const tickRef = useRef<FocusTick | null>(null);
  /** `mode` / `minutes` 的最新值镜像（同上） */
  const liveExtraRef = useRef<{ mode: PomodoroMode; minutes: number }>({ mode, minutes });
  /** 接回来的那一场**只接一次**（effect 会随 props 反复跑） */
  const restoreAppliedRef = useRef(false);
  /**
   * 接回来的那一场，**锚点还没往前挪过**（v1.14.1）。
   *
   * 平时的流程里，"暂停 → 恢复"那次跳变由 tick 检测到、顺手把 `startedAt` 往后挪；
   * 但**接回来的这一场没有那次跳变**（后端可能一直报 paused=true，或者干脆是重开的会话）。
   * 少了这一挪，被挂起的那几十分钟会算进专注时间 —— 所以标上记，等用户点「继续」时补挪。
   */
  const anchorShiftOnResumeRef = useRef(false);

  /**
   * 🔴 v1.14.1：把"这一场目前的完整状态"写进浏览器存储。
   *
   * 每秒一条（跟着 `focus-tick`）、页面要走了再来一条、以及每次用户动手（换档位/暂停/继续）一条。
   * 存的东西：**是哪条待办 + 模式 + 时长 + 计时锚点 + 各数字 + 当时在不在跑** ——
   * 重载之后 `App` 就是靠它把这一场接回来的（见 `store/focusNumbers.ts` 的注释）。
   *
   * ⚠️ 定义放在这一堆 ref 之后、`applyMinutes` 之前：换时长 / 换模式那两处也要立刻存一条。
   */
  const saveLive = useCallback(() => {
    rememberFocusNumbers({
      todoId: todo.id,
      todoTitle: todo.title,
      mode: liveExtraRef.current.mode,
      minutes: liveExtraRef.current.minutes,
      startedAt: startedAt.current,
      running: !pausedRef.current && !firedRef.current,
      pausedSeconds: tickRef.current?.pausedSeconds ?? 0,
      interruptedSeconds: tickRef.current?.interruptedSeconds ?? 0,
      interruptedTimes: tickRef.current?.interruptedTimes ?? 0,
      manualPausedSeconds: manualPausedAccumRef.current,
    });
  }, [todo.id, todo.title]);

  /** 换时长 = 重新开始计时（和档位按钮原来那段逻辑一致） */
  const applyMinutes = useCallback(
    (value: number) => {
      if (firedRef.current) return;
      setMinutes(value);
      startedAt.current = Date.now();
      setElapsed(0);
      // v1.14.1：锚点换了就立刻存一条（重载后倒计时表盘要跟这个走）
      liveExtraRef.current = { ...liveExtraRef.current, minutes: value };
      saveLive();
    },
    [saveLive],
  );

  /** 提交自定义分钟数：只认 1~999 的整数，别的就退回原值（别把 0 分钟的倒计时放出去） */
  const commitCustom = useCallback(() => {
    const raw = customText.trim();
    if (!raw) return;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value) || value < 1) {
      setCustomText("");
      return;
    }
    applyMinutes(Math.min(999, value));
    setCustomText("");
  }, [applyMinutes, customText]);

  const targetSeconds = mode === "countdown" ? minutes * 60 : 0;

  // `tick` / `mode` / `minutes` 的镜像（下面那些"存底"的回调靠它们拿最新值，避免闭包过期）
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);
  useEffect(() => {
    liveExtraRef.current = { mode, minutes };
  }, [mode, minutes]);

  // 开局先存一条：用户刚点「开始」就重载（甚至只隔一秒）也能接回来
  useEffect(() => {
    saveLive();
  }, [saveLive]);

  /**
   * 页面要被销毁 / 藏起来之前，**再存一条**（同步写，来得及）。
   *
   * 🔴 **这里只存，绝不停会话** —— 合盖 / 关窗 / 重载都不该结束那一场；
   * 能结束会话的只有两件事：用户点「结束」，或者倒计时真的走完（见 `finish`）。
   */
  useEffect(() => {
    const onLeave = () => saveLive();
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    document.addEventListener("visibilitychange", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      document.removeEventListener("visibilitychange", onLeave);
    };
  }, [saveLive]);

  /**
   * 🔴 v1.14.1：**把上次没结束的那一场接回来**（`App` 从存储里读出来交给这里）。
   *
   * 三件事：
   * 1. **恢复锚点**：`startedAt` 用"存盘那一刻已经走了多久"反推（`now - elapsed*1000`），
   *    这样表盘接着上次走，**被挂起的那段不会算进专注**（跟"冻结靠挪锚点"是同一套机制）；
   * 2. **确实被挂起过 → 冻住**：显示「已暂停 · 休眠」等用户点「继续」，**不自动接着走**
   *    （跟锁屏那套语义完全一致）；
   * 3. **后端还活着就什么都不重开**：`focusMonitorStart` 是"新建一场"，一调就把后端攒的
   *    "睡过 300 秒"清零 —— 那正是这次要修的 bug 的另一副面孔。
   */
  useEffect(() => {
    if (!restore || restoreAppliedRef.current) return;
    if (restore.record.todoId !== todo.id) return;
    restoreAppliedRef.current = true;
    const rec = restore.record;

    if (rec.mode === "countup" || rec.mode === "countdown" || rec.mode === "free") setMode(rec.mode);
    if (rec.minutes >= 1) setMinutes(Math.min(999, Math.round(rec.minutes)));

    // ① 锚点：把"已经走过的时间"钉住，挂起的那段不算
    const elapsedAtSave =
      rec.startedAt > 0 && rec.savedAt > rec.startedAt
        ? Math.max(0, Math.floor((rec.savedAt - rec.startedAt) / 1000))
        : 0;
    startedAt.current = Date.now() - elapsedAtSave * 1000;
    setElapsed(elapsedAtSave);
    manualPausedAccumRef.current = rec.manualPausedSeconds;
    lastPausedSecondsRef.current = rec.pausedSeconds;

    // ② 被挂起过（或者存盘时本来就是暂停着）→ 冻住，等用户点「继续」
    const gap = rec.savedAt > 0 ? Math.max(0, Math.floor((Date.now() - rec.savedAt) / 1000)) : 0;
    const suspended = !rec.running || gap > RESTORE_SUSPEND_GAP_SECONDS;
    setRestoredPausedSeconds(rec.pausedSeconds);
    if (suspended) {
      pausedAtRef.current = Date.now();
      pausedRef.current = true;
      setResumePending(true);
      // ⚠️ 标上"锚点待补挪"：见 `anchorShiftOnResumeRef` 的注释
      anchorShiftOnResumeRef.current = true;
      // 合成一条"休眠暂停"的后端信号：面板上那句「已暂停 · 休眠」与秒数都从这里来。
      // ⚠️ 后端还活着时，真信号一秒内就会把它覆盖掉（真数据优先）。
      setTick({
        active: true,
        todoId: todo.id,
        paused: true,
        pauseReason: "sleep",
        pausedSeconds: rec.pausedSeconds,
        interruptedSeconds: rec.interruptedSeconds,
        interruptedTimes: rec.interruptedTimes,
        idleSeconds: 0,
        idleSinceStartSeconds: 0,
        awayNow: false,
      });
    }
  }, [restore, todo.id]);

  // 每一秒按"真实流逝"重算，而不是 elapsed + 1 ——
  // 定时器会被浏览器节流（窗口在后台时尤其明显），累加会越走越慢
  // ⚠️ M13-B：暂停中（锁屏 / 等用户点继续）**不许重算** —— 冻结就是冻结
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pausedRef.current) return;
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  // 收 Rust 每秒推的那条信号：暂停 / 疑似离开 / 睡过都会体现在这里
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<FocusTick>("focus-tick", (event) => {
      const payload = event.payload;
      // 只认"这次专注"的信号（换了待办 / 已经结束的旧信号一律丢掉）
      if (!payload || payload.todoId !== todo.id) return;
      setTick(payload);
      // 🔴 v1.14.0/v1.14.1：顺手把"这一场目前的完整状态"在浏览器存储里留一份底。
      // 合盖睡一觉后主窗被挂起/重建、甚至进程重启时，内存里这份就没了 ——
      // 有了这份底，**会话才接得回来**，结算也不会把"睡了 300 秒"写成 0
      // （见 `store/focusNumbers.ts`）。
      saveLive();
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 监听专注监控失败", error);
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [todo.id, saveLive]);

  // 锁屏 / 休眠 → 冻住；解锁 / 唤醒 → 先问「继续吗」（**不自动接着走**）
  useEffect(() => {
    const pausedNow = !!tick?.paused;
    if (pausedNow && !pausedRef.current) {
      // 睡过去那一段：Rust 是把它算进 pausedSeconds 的，这里要剔掉，
      // 不然"冻住"的那一下会先跳一大截再停
      const slept =
        tick?.pauseReason === "sleep"
          ? Math.max(0, (tick.pausedSeconds ?? 0) - lastPausedSecondsRef.current)
          : 0;
      pausedAtRef.current = Date.now() - slept * 1000;
      pausedRef.current = true;
      setElapsed(Math.max(0, Math.floor((pausedAtRef.current - startedAt.current) / 1000)));
    } else if (!pausedNow && pausedRef.current && !resumePending) {
      // 时间轴往后挪：暂停那段不算"走过"
      startedAt.current += Date.now() - pausedAtRef.current;
      setResumePending(true);
    }
    lastPausedSecondsRef.current = tick?.pausedSeconds ?? 0;
  }, [tick?.paused, tick?.pauseReason, tick?.pausedSeconds, resumePending]);

  /** 用户在暂停后点了「继续」：解冻，接着往下走 */
  const resume = useCallback(() => {
    // 🔴 v1.14.1：接回来的那一场在这里补挪锚点 —— 不补的话，被挂起的那段会算进专注时间
    if (anchorShiftOnResumeRef.current && pausedAtRef.current > 0) {
      startedAt.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = 0;
      anchorShiftOnResumeRef.current = false;
    }
    pausedRef.current = false;
    setResumePending(false);
    lastPausedSecondsRef.current = tick?.pausedSeconds ?? 0;
    // 状态变了就存一条（万一紧接着又重载，接回来时 running 才是对的）
    saveLive();
  }, [saveLive, tick?.pausedSeconds]);

  // ─────────────── 🔴 换了一条待办 = 一场新专注，**所有临时状态归零** ───────────────
  //
  // B 批（2026-10-02）把面板从 `TodoPage` 搬到 `App` 之后踩到的真 bug：
  // 面板**不再随页面卸载**（这是好事：切页面不再打断计时），但代价是
  // **组件里那些"这一场"的状态会留到下一场** —— 上一场没结算的卡（`settle`）、
  // 确认条、手动暂停、中断计数、工作提示……全都会**提前出现在新一场里**。
  // 现象：点「开始」新一场，面板上直接写着「专注结束（待结算）」，小窗上也是。
  //
  // ⚠️ 判据用 `todo.id`：同一个待办再点一次「开始」不算换会话（那是"重新计时"，
  //    由 `applyMinutes` / 模式按钮自己重置秒数）。
  // ⚠️ 这个 effect 必须放在**所有 state 声明之后**，否则会踩 TDZ。
  const sessionIdRef = useRef<string>(todo.id);
  useEffect(() => {
    if (sessionIdRef.current === todo.id) return;
    sessionIdRef.current = todo.id;
    // 这一场相关的全部清零
    setSettle(null);
    setConfirming(false);
    setManualPaused(false);
    manualPausedAccumRef.current = 0;
    manualPausedAtRef.current = 0;
    setWorkPromptAtSeconds(0);
    workPromptStepRef.current = 0;
    pausedRef.current = false;
    pausedAtRef.current = 0;
    anchorShiftOnResumeRef.current = false;
    setResumePending(false);
    setRestoredPausedSeconds(0);
    lastPausedSecondsRef.current = 0;
    firedRef.current = false;
    setTick(null);
    // 秒数也从头来（新的一场的表盘不该接着上一条走）
    startedAt.current = Date.now();
    setElapsed(0);
    setNote("");
  }, [todo.id]);

  /**
   * 手动暂停（B 批）：冻住计时，把"已经走了多久"钉在当下。
   *
   * ⚠️ 为什么定格要用 `startedAt = Date.now() - elapsed*1000` 反推：
   * 计时是每秒按 `Date.now() - startedAt` **重算**的（不是累加，见上面那段注释），
   * 所以"冻住"只能靠把"起点"往后挪。**恢复**时再按暂停时长把起点往前推回去。
   */
  const pauseManually = useCallback(() => {
    if (pausedRef.current || firedRef.current) return;
    manualPausedAtRef.current = Date.now();
    pausedRef.current = true;
    setManualPaused(true);
    // 2026-10-05（v1.14.0）：手动暂停也进"数字底"，免得重建之后这一段白丢
    // v1.14.1：整场一起存（锚点 / 模式 / 时长 / running），重载才接得回来
    saveLive();
    setElapsed((current) => {
      startedAt.current = Date.now() - current * 1000;
      return current;
    });
  }, [saveLive]);

  /** 手动继续：把暂停那一段从时间轴上抹掉（**不算专注**），然后接着走 */
  const resumeManually = useCallback(() => {
    if (!manualPaused) return;
    const pausedFor = Math.max(0, Math.floor((Date.now() - manualPausedAtRef.current) / 1000));
    manualPausedAccumRef.current += pausedFor;
    startedAt.current += Date.now() - manualPausedAtRef.current;
    pausedRef.current = false;
    setManualPaused(false);
    // 2026-10-05（v1.14.0）：累加完立刻更新"数字底"（这一段是唯一只有前端知道的部分）
    rememberFocusNumbers({
      todoId: todo.id,
      pausedSeconds: tick?.pausedSeconds ?? 0,
      interruptedSeconds: tick?.interruptedSeconds ?? 0,
      interruptedTimes: tick?.interruptedTimes ?? 0,
      manualPausedSeconds: manualPausedAccumRef.current,
    });
  }, [manualPaused, todo.id, tick?.pausedSeconds, tick?.interruptedSeconds, tick?.interruptedTimes]);

  /** 设置里那个开关：结束时要不要问我（关掉就默认按「计入」记） */
  const askOnFinish = useData((s) => s.config.focus.askOnFinish);
  /** 设置里那个阈值（结算卡上写"超过 N 秒没动键鼠"，别写死 90） */
  const awayThresholdSeconds = useData((s) => s.config.focus.awayThresholdSeconds);
  /**
   * 2026-10-05（v1.14.0）：设置里预设的自定义番茄时长（分钟）。
   * 它既是这一场的默认起点，也作为**额外一个档位**出现在时长那一行里（不在常用档中时才加）。
   */
  const presetMinutes = useData((s) => s.config.focus.customMinutes);

  // ─────────────── M13-C：这次专注挂哪条格言 ───────────────
  //
  // 用户 2026-09-26 定："默认自动挑一条，可手动换"，而且**挑的这条留一整天**。
  // 所以优先级是：配置里今天挑过的那条（还在的话）→ 否则"今天这一句"（按本地日期哈希，同一天固定）。
  const config = useData((s) => s.config);
  const saveConfig = useData((s) => s.saveConfig);
  const setFocusNote = useData((s) => s.setFocusNote);
  const [mottos, setMottos] = useState<Motto[]>([]);
  const [mottoId, setMottoId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await mottoList();
        if (cancelled) return;
        setMottos(list);
        const today = localDay(new Date());
        const picked =
          config.focus.mottoPickDate === today
            ? list.find((one) => one.id === config.focus.mottoPickId)
            : undefined;
        setMottoId((picked ?? todayMotto(list))?.id ?? null);
      } catch (error) {
        console.error("[东方摩耶堂] 读取格言失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // ⚠️ 只在面板打开时读一次（config 变了不用重读——换格言走下面那两个回调）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const motto = mottos.find((one) => one.id === mottoId) ?? null;

  /** 换一条（随机）：**也写进配置**，这样今天一直是它（跟"挑"同一个待遇） */
  const switchMotto = useCallback(() => {
    const next = randomMotto(mottos, mottoId ?? undefined);
    if (!next) return;
    setMottoId(next.id);
    void saveConfig({
      focus: { ...config.focus, mottoPickDate: localDay(new Date()), mottoPickId: next.id },
    });
  }, [config.focus, mottoId, mottos, saveConfig]);

  /** 从小窗上「📋 挑」选中了某一条 */
  const chooseMotto = useCallback(
    (id: string) => {
      if (!mottos.some((one) => one.id === id)) return;
      setMottoId(id);
      void saveConfig({
        focus: { ...config.focus, mottoPickDate: localDay(new Date()), mottoPickId: id },
      });
    },
    [config.focus, mottos, saveConfig],
  );

  /** 小窗上改的「须知」：**落盘由这里做**（写数据的窗口只有一个） */
  const saveNoteFromWindow = useCallback(
    (text: string) => {
      void setFocusNote(todo.id, text);
    },
    [setFocusNote, todo.id],
  );

  // M13-C：「须知」在面板里也是个输入框（两处都能编辑，同一份数据）
  const [noteText, setNoteText] = useState(todo.focusNote ?? "");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  // 小窗那边改了须知 → 推回来（正在这里打字时不覆盖，免得把光标打断）
  useEffect(() => {
    if (noteRef.current && document.activeElement === noteRef.current) return;
    setNoteText(todo.focusNote ?? "");
  }, [todo.focusNote]);

  const remaining = Math.max(0, targetSeconds - elapsed);
  const shown = mode === "countdown" ? clockText(remaining) : clockText(elapsed);
  /**
   * 面板上"已离开多久"该显示多少（v1.14.1）：**后端报的** 与 **接回来时存盘的那份** 取最大。
   * 两者说的是同一个事实（暂停累计），相加会翻倍；只取后端那份会在"进程重启"时显示成 00:00。
   */
  const pausedShownSeconds = Math.max(tick?.pausedSeconds ?? 0, restoredPausedSeconds);

  /**
   * **手动暂停**累计（含"现在正暂停着"这一段）。
   *
   * 这一段只有前端知道（后端看不见你按了面板上的暂停），所以报账时它是**另加**的一份。
   */
  const manualPausedTotal = useCallback((): number => {
    const liveManual = manualPaused
      ? Math.max(0, Math.floor((Date.now() - manualPausedAtRef.current) / 1000))
      : 0;
    return manualPausedAccumRef.current + liveManual;
  }, [manualPaused]);

  /**
   * 结算时"**后端类的暂停**"（锁屏 / 休眠）该报多少 —— **内存 / 存储 / 后端快照**三份里取最大。
   *
   * 🔴 2026-10-05（v1.14.0）修的真 bug：以前这一项是
   * `snapshot?.pausedSeconds ?? totalPausedSeconds()` ——
   * ① 只要 `focusMonitorStop()` 拿到了东西（正常情况），**手动暂停那一段就被整段丢掉**；
   * ② 而 `snapshot` 一旦是"已经丢失的会话"（全 0），写下去的就是 0 ——
   *    用户合盖睡一觉后那条 `seconds:4 / pausedSeconds:0` 就是这么来的。
   *
   * 现在三份都看一遍取最大（它们说的是同一个事实，**相加会翻倍**）：
   * - `tick`：内存里最后收到的那条后端信号；
   * - `readFocusNumbers`：每秒写进浏览器存储的那份底（挂起 / 重建后还在）；
   * - `focusMonitorStop()` 的返回值：后端刚刚算完的最终数字。
   */
  const backendPausedMax = useCallback(
    (snapshot: FocusTick | null): number => {
      const fromStore = readFocusNumbers(todo.id)?.pausedSeconds ?? 0;
      return Math.max(tick?.pausedSeconds ?? 0, fromStore, snapshot?.pausedSeconds ?? 0);
    },
    [todo.id, tick?.pausedSeconds],
  );

  /** 同理：疑似离开的秒数 / 次数（这两项后端是唯一权威，取最大只是不让它被 0 盖掉） */
  const backendInterruptedMax = useCallback(
    (snapshot: FocusTick | null): { seconds: number; times: number } => {
      const saved = readFocusNumbers(todo.id);
      return {
        seconds: Math.max(
          tick?.interruptedSeconds ?? 0,
          saved?.interruptedSeconds ?? 0,
          snapshot?.interruptedSeconds ?? 0,
        ),
        times: Math.max(
          tick?.interruptedTimes ?? 0,
          saved?.interruptedTimes ?? 0,
          snapshot?.interruptedTimes ?? 0,
        ),
      };
    },
    [todo.id, tick?.interruptedSeconds, tick?.interruptedTimes],
  );

  /**
   * 结束：**先问 Rust 要最终那份数字**（以前端手里那份为准会差不到 1 秒），
   * 有疑似离开就变成结算卡等用户选，没有就直接记账收尾。
   *
   * ⚠️ B 批（2026-10-02）：**主窗面板上那颗「结束」要先过一道二次确认** ——
   * 判据是"有没有传 `autoSeconds`"：
   * - 倒计时自然走完 → `finish(targetSeconds)` → **不打扰**（到点结束本来就是它该干的事）；
   * - 面板上点「结束」→ `finish()` → 先 `setConfirming(true)`，等用户在确认条上选。
   *
   * 🔴 **但小窗上那颗「结束」不走确认**（2026-10-02 验收逮到的回归）：确认条长在**主窗面板**里，
   *    小窗点结束如果也要求确认，用户在小窗上点了会**看起来没反应**（他可能根本没打开主窗）。
   *    小窗那颗按钮本来就是"明确意图"（用户特意点到它），照 M13 原来的语义**直接收尾**。
   *
   * 🔴 **2026-10-05（v1.14.0）**：报给后端的三个数字改成
   * 「后端类取三份最大 + 手动那段另加」，并把 `manualPausedSeconds` **单独报一份** ——
   * 这样后端也能拿它跟自己算的那份比对（见 `commands.rs::todo_add_pomodoro`）。
   * 分工是死的：**锁屏/休眠 = 后端的账，手动暂停 = 前端的账**，两边各报各的、相加不重叠。
   */
  const finish = useCallback(
    async (autoSeconds?: number, skipConfirm = false) => {
      if (firedRef.current) return;
      if (autoSeconds === undefined && !confirming && !skipConfirm) {
        setConfirming(true);
        return;
      }
      firedRef.current = true;
      const seconds =
        autoSeconds ?? (mode === "countdown" ? Math.min(elapsed, targetSeconds) : elapsed);
      const snapshot = await focusMonitorStop().catch(() => null);
      const interrupted = backendInterruptedMax(snapshot);
      const manualPaused = manualPausedTotal();
      const pausedSeconds = backendPausedMax(snapshot) + manualPaused;
      // 有疑似离开才问（用户 2026-09-26 定：作废 = 统计 + 给待办留个记号）
      if (interrupted.times > 0 && askOnFinish) {
        setSettle({
          mode,
          seconds,
          note,
          interruptedSeconds: interrupted.seconds,
          interruptedTimes: interrupted.times,
          pausedSeconds,
          manualPausedSeconds: manualPaused,
        });
        return;
      }
      onFinish(mode, seconds, note, true, {
        interruptedSeconds: interrupted.seconds,
        interruptedTimes: interrupted.times,
        pausedSeconds,
        manualPausedSeconds: manualPaused,
        voided: false,
      });
      onClose();
    },
    [
      askOnFinish,
      backendInterruptedMax,
      backendPausedMax,
      confirming,
      elapsed,
      manualPausedTotal,
      mode,
      note,
      onClose,
      onFinish,
      targetSeconds,
    ],
  );

  /** 结算卡上点了「计入 / 作废」：两种都**照样记下来**（作废只是不计入有效专注） */
  const resolveSettle = useCallback(
    (voided: boolean) => {
      if (!settle) return;
      onFinish(settle.mode, settle.seconds, settle.note, true, {
        interruptedSeconds: settle.interruptedSeconds,
        interruptedTimes: settle.interruptedTimes,
        pausedSeconds: settle.pausedSeconds,
        manualPausedSeconds: settle.manualPausedSeconds,
        voided,
      });
      onClose();
    },
    [onClose, onFinish, settle],
  );

  // 倒计时到点 → 自动收尾（只触发一次）
  //
  // ⚠️ 这个 effect 必须排在 `finish` 声明**后面**：依赖数组在渲染期就要取值，
  //    放前面会踩 `const` 的 TDZ（Cannot access 'finish' before initialization）。
  useEffect(() => {
    if (mode !== "countdown" || firedRef.current) return;
    if (targetSeconds > 0 && elapsed >= targetSeconds) void finish(targetSeconds);
  }, [elapsed, mode, targetSeconds, finish]);

  // 不计时模式没有"到点"，正计时也没有 —— 只有倒计时会自己收尾
  const autoFinishes = mode === "countdown";

  // ─────────────── M13-A：把"进行中"同步到**专注小窗**（+ 托盘那行字）───────────────
  //
  // ⚠️ 三条约定：
  // 1. **计时的权威在这里**，小窗只负责显示（它不自己跑计时器）—— 两边各跑一个迟早对不上；
  // 2. 小窗上的按钮只发"意图"回来（`focus-intent`），**真的结束 / 标完成还是这里做**
  //    （数据在 store 里，小窗手上什么都没有）；
  // 3. 面板**打开 = 这次专注开始**，面板关掉（结束 / 取消）= 小窗跟着收。
  /** 对外（专注小窗 / 托盘）报告的"暂停中" = **Rust 的自动暂停 或 用户的手动暂停**。
   * 两边冻结机制是同一套（`pausedRef` + 挪 `startedAt`），所以小窗只需要一个布尔值。
   */
  const uiPaused = !!tick?.paused || manualPaused;
  const uiPauseReason = tick?.paused ? (tick?.pauseReason ?? "") : manualPaused ? "manual" : "";
  const uiPausedSeconds = (tick?.pausedSeconds ?? 0) + manualPausedAccumRef.current;

  // ─────────── C 批（2026-10-02）：工作中的定时提示 ───────────
  //
  // 用户脑图第 8 条：「执行区、工作时间进行时，随机时间弹出提醒我」。
  // ⚠️ 我做的是**固定间隔**（默认 45 分钟，设置里能改、能关）：
  //    随机间隔真用起来没法预判，反而更烦人；固定间隔他知道"大概什么时候会被念叨一下"。
  // ⚠️ 提示**只推给小窗**（不弹窗、不打断、不落盘）—— 顺手把小窗底部那行字也标出来。
  const workPromptEnabled = useData((s) => s.config.focus.workPromptEnabled);
  const workPromptMinutes = useData((s) => s.config.focus.workPromptMinutes);
  const [workPromptAtSeconds, setWorkPromptAtSeconds] = useState(0);
  /** 已经提示到第几档了（每跨过一个间隔 +1；切档/换时长就归零） */
  const workPromptStepRef = useRef(0);
  useEffect(() => {
    if (!workPromptEnabled || workPromptMinutes <= 0) {
      setWorkPromptAtSeconds(0);
      workPromptStepRef.current = 0;
      return;
    }
    // 暂停中不计（暂停那段时间本来就不算专注）
    if (pausedRef.current) return;
    const step = Math.floor(elapsed / (workPromptMinutes * 60));
    if (step > workPromptStepRef.current) {
      workPromptStepRef.current = step;
      setWorkPromptAtSeconds(elapsed);
    }
  }, [elapsed, workPromptEnabled, workPromptMinutes]);

  const focusState: FocusState = {
    todoId: todo.id,
    title: todo.title,
    sourceText,
    mode,
    elapsed,
    target: targetSeconds,
    note,
    // M13-B：把 Rust 判出来的"意外中断"状态一起推给小窗（判定只有一处，别两边各判一次）
    paused: uiPaused,
    pauseReason: uiPauseReason,
    pausedSeconds: uiPausedSeconds,
    interruptedSeconds: tick?.interruptedSeconds ?? 0,
    interruptedTimes: tick?.interruptedTimes ?? 0,
    awayNow: !!tick?.awayNow,
    idleSeconds: tick?.idleSeconds ?? 0,
    resumePending,
    settle,
    // B 批：小窗上要能自己暂停 / 继续（它照旧只发意图，真的冻/解冻在这里做）
    manualPaused,
    // C 批：工作中的定时提示 —— 到了就带上"已经专注了多久"，小窗上显示一句
    workPromptAtSeconds,
    // M13-C：这条待办的「须知」（长期）与这次挂的格言，一起推给小窗
    focusNote: todo.focusNote ?? "",
    motto: motto ? { text: motto.text, from: motto.from, kind: motto.kind } : null,
  };

  // ⚠️ 开 / 关专注小窗**不在这里**做：那是 `TodoPage` 在「开始 / 关闭」那一刻显式做的
  //    （组件挂载/卸载是异步的，StrictMode 的「挂载 → 清理 → 再挂载」会把开/关打乱顺序）。

  // 秒数 / 模式 / 备注 / 中断状态变了就推一次（别每次渲染都推，那是每秒几百条）
  useEffect(() => {
    void emitTo("focus", "focus-state", focusState).catch(() => undefined);
    // E 批（2026-10-03）：**桌面挂件也要一份**（挂件上那格只读倒计时用它）。
    // ⚠️ 挂件窗可能压根没开 —— 对不存在的窗口 emit 会 reject，所以必须 catch 住，
    //    否则每次 tick 都往控制台丢一条 unhandled rejection。
    void emitTo("widget", "focus-state", focusState).catch(() => undefined);
    // eslint 依赖列表故意按"内容"给，而不是整个对象（对象每次渲染都是新的）
  }, [
    elapsed,
    mode,
    targetSeconds,
    note,
    todo.id,
    todo.title,
    sourceText,
    tick?.paused,
    tick?.pauseReason,
    tick?.pausedSeconds,
    tick?.interruptedSeconds,
    tick?.interruptedTimes,
    tick?.awayNow,
    tick?.idleSeconds,
    resumePending,
    settle,
    // M13-C：这一轮改过依赖表，C 批加的 workPromptAtSeconds 也要跟着推
    todo.focusNote,
    motto?.text,
    motto?.from,
    workPromptAtSeconds,
  ]);

  // 托盘那行字跟着状态走（专注中 / 已暂停 / 疑似离开）—— 只换字，不换图标
  const trayText =
    (settle
      ? "东方摩耶堂 · 专注结束（待结算）"
      : uiPaused
        ? "东方摩耶堂 · 专注中（已暂停）"
        : tick?.awayNow
          ? "东方摩耶堂 · 专注中（疑似离开）"
          : "东方摩耶堂 · 专注中") + `：${todo.title}`;
  useEffect(() => {
    void focusTraySet(trayText).catch(() => undefined);
  }, [trayText]);

  /** 小窗上的按钮 → 发过来的意图。⚠️ 回调放 ref：订阅只做一次、拿到的永远是最新那份 */
  const intentRef = useRef<(action: string) => void>(() => undefined);
  /** 意图里带的参数（M13-C：写「须知」会带 `text`、挑格言会带 `id`） */
  const intentPayloadRef = useRef<{ action?: string; text?: string; id?: string }>({});
  intentRef.current = (action: string) => {
    // ⚠️ 小窗点「结束」→ **不跳确认**（确认条在主窗面板里，小窗上点了会像"没反应"）
    if (action === "finish") void finish(undefined, true);
    // M13-B：暂停后点了「▶ 继续」→ 解冻接着走
    else if (action === "resume") {
      // B 批：如果冻着的是**手动暂停**，"继续"就走手动那条（Rust 那条只负责锁屏/休眠）
      if (manualPaused) resumeManually();
      else resume();
    }
    // B 批：小窗上点了「⏸ 暂停」→ 手动暂停（跟锁屏暂停同一套冻结）
    else if (action === "pause") pauseManually();
    // M13-B：结算卡上的两个选择（都要落盘，作废只是不计入有效专注）
    else if (action === "count") resolveSettle(false);
    else if (action === "void") resolveSettle(true);
    // M13-C：小窗上写了「须知」→ 由这里落盘（写数据的窗口只有一个）
    else if (action === "focus-note") saveNoteFromWindow(intentPayloadRef.current.text ?? "");
    // M13-C：小窗上「🔄 换」→ 随机换一条（也写配置，今天都显示它）
    else if (action === "motto-next") switchMotto();
    // M13-C：小窗上「📋 挑」选中的那条
    else if (action === "motto-pick" && intentPayloadRef.current.id) {
      chooseMotto(intentPayloadRef.current.id);
    }
    // "收起" = 只把小窗藏起来，**计时继续走**（托盘那行字也复原）
    else if (action === "hide") void focusWindowClose().catch(() => undefined);
    // "打开执行区" = 把这个面板关掉，回到执行区列表（人就在执行区，不用切页面）
    else if (action === "open") onClose();
  };
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<{ action?: string; text?: string; id?: string }>("focus-intent", (event) => {
      const payload = event.payload ?? {};
      intentPayloadRef.current = payload;
      if (payload.action) intentRef.current(payload.action);
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 监听专注小窗意图失败", error);
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return (
    /* B 批：**不再是 Modal**（不铺遮罩、不吞鼠标）—— 就是一块普通面板，挂在 App 上 */
    <aside
      data-pomodoro-panel
      className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <span aria-hidden>🍅</span>
            <span data-pomodoro-heading className="truncate" title={todo.title}>
              {todo.title}
            </span>
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {settle ? "专注结束（待结算）" : uiPaused ? "已暂停" : "专注中"} · 关了面板也不影响计时
          </p>
        </div>
        <button
          type="button"
          data-pomodoro-minimize
          onClick={onClose}
          title="收起这块面板（**计时继续**，右下角小窗还在；再点待办的「▶」能叫回来）"
          className="shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          ✕
        </button>
      </header>

      <div data-pomodoro className="flex flex-col gap-5">
        {/* 三种模式 */}
        <div className="flex gap-2">
          {(["countup", "countdown", "free"] as PomodoroMode[]).map((key) => (
            <button
              key={key}
              type="button"
              data-pomodoro-mode-btn={key}
              onClick={() => {
                if (firedRef.current) return;
                setMode(key);
                startedAt.current = Date.now();
                setElapsed(0);
                // v1.14.1：换了模式也立刻存一条
                liveExtraRef.current = { ...liveExtraRef.current, mode: key };
                saveLive();
              }}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-medium ${
                mode === key
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {MODE_LABEL[key]}
            </button>
          ))}
        </div>

        {/* 倒计时才要挑时长 */}
        {mode === "countdown" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>时长</span>
            {DURATIONS.map((value) => (
              <button
                key={value}
                type="button"
                data-pomodoro-duration={value}
                onClick={() => applyMinutes(value)}
                className={`rounded-lg border px-2.5 py-1 ${
                  minutes === value
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                    : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {value} 分钟
              </button>
            ))}

            {/* 2026-10-05（v1.14.0）：设置里**预设的那个**时长也摆成一档 ——
                用户要的是"不必再开始之后再设置"，所以它得看得见、点得着；
                已经在常用档里（25/45/60/5/1）就不重复摆一遍。 */}
            {Number.isFinite(presetMinutes) &&
              presetMinutes >= 1 &&
              !DURATIONS.includes(presetMinutes as (typeof DURATIONS)[number]) && (
                <button
                  type="button"
                  data-pomodoro-duration={presetMinutes}
                  title="这是你在「设置 → 专注」里预设的自定义时长"
                  onClick={() => applyMinutes(Math.min(999, Math.round(presetMinutes)))}
                  className={`rounded-lg border px-2.5 py-1 ${
                    minutes === presetMinutes
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {presetMinutes} 分钟 ★
                </button>
              )}

            {/* 自定义分钟数（2026-09-21 用户拍板 C1："要自定义时间"）。
                回车或失焦就生效；只收 1~999 的整数，防手滑打出一串 9。 */}
            <span className="flex items-center gap-1">
              <input
                data-pomodoro-custom
                type="number"
                min={1}
                max={999}
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
                onBlur={commitCustom}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitCustom();
                  }
                }}
                placeholder="自定义"
                className="w-20 rounded-lg border border-slate-300 bg-transparent px-2 py-1 text-center outline-none focus:border-indigo-400 dark:border-slate-600 dark:text-slate-100"
              />
              <span>分钟</span>
            </span>
          </div>
        )}

        {/* 大表盘 */}
        <div className="flex flex-col items-center gap-1 py-2">
          <p
            data-pomodoro-clock
            className="font-mono text-4xl font-semibold tabular-nums text-slate-800 dark:text-slate-100"
          >
            {shown}
          </p>
          <p data-pomodoro-mode className="text-xs text-slate-400">
            {MODE_LABEL[mode]}
            {mode === "free" ? "（只计时不催你，随时可以结束）" : ""}
          </p>
        </div>

        {/* ───────── C 批（2026-10-02）：工作中的定时提示 ─────────
            用户脑图第 8 条。间隔到了就在这儿说一句（小窗上同样有一句）。
            ⚠️ 只是**显示**：不弹窗、不打断、不落盘；关掉开关它就不出现。 */}
        {workPromptAtSeconds > 0 && (
          <div
            data-pomodoro-work-prompt={workPromptAtSeconds}
            className="-mt-2 rounded-xl border border-indigo-400/50 bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-200"
          >
            ⏳ 已经专注 <b>{clockText(workPromptAtSeconds)}</b> 了 —— 喝口水、直直腰，或者继续。
          </div>
        )}

        {/* ───────── M13-B：意外中断的状态条（跟小窗上那几条同一份数据）───────── */}
        {!settle && (tick?.paused || manualPaused || resumePending || tick?.awayNow || (tick?.interruptedSeconds ?? 0) > 0) && (
          <div
            data-pomodoro-interrupt
            className={`-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs ${
              tick?.paused || manualPaused || tick?.awayNow || resumePending
                ? "border-amber-400/60 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
                : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400"
            }`}
          >
            {/* B 批：手动暂停（跟锁屏暂停显示在同一块里，但来源不同、留痕不同） */}
            {manualPaused && (
              <span data-pomodoro-manual-paused>
                ⏸ 你手动暂停了
                {manualPausedAccumRef.current > 0
                  ? ` · 本次已暂停 ${clockText(manualPausedAccumRef.current)}`
                  : ""}
                <span className="text-slate-400">（这段时间不计入专注，也不留"被打断"记号）</span>
              </span>
            )}
            {(tick?.paused || resumePending) && (
              <span data-pomodoro-paused>
                ⏸ {tick?.pauseReason === "lock" ? "锁屏了" : "电脑睡过去了"}，已自动暂停
                {pausedShownSeconds > 0 ? ` · 已离开 ${clockText(pausedShownSeconds)}` : ""}
                <span className="text-slate-400">（这段时间不计入专注）</span>
              </span>
            )}
            {resumePending && (
              <span data-pomodoro-resume className="flex items-center gap-2">
                刚才离开了 <b>{clockText(pausedShownSeconds)}</b>，继续吗？
                <button
                  type="button"
                  data-pomodoro-continue
                  onClick={resume}
                  className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-700"
                >
                  ▶ 继续
                </button>
              </span>
            )}
            {!tick?.paused && !resumePending && tick?.awayNow && (
              <span data-pomodoro-away>
                ⚠ 疑似离开 {clockText(tick.idleSeconds)} · <b>计时仍在走</b>
              </span>
            )}
            {!tick?.paused && !tick?.awayNow && (tick?.interruptedSeconds ?? 0) > 0 && (
              <span data-pomodoro-interrupted>
                这次已累计疑似离开 {clockText(tick?.interruptedSeconds ?? 0)}
                {tick?.interruptedTimes ? ` · ${tick.interruptedTimes} 次` : ""}
              </span>
            )}          </div>
        )}

        {/* M13-C①：「须知」—— 跟待办走、长期有效（小窗上也能改，同一份数据） */}
        <div>
          <label
            className="text-xs font-semibold text-slate-500 dark:text-slate-400"
            htmlFor="pomodoro-focus-note"
          >
            📝 须知（跟这条待办走，下次开始还在）
          </label>
          <textarea
            id="pomodoro-focus-note"
            data-pomodoro-focus-note
            ref={noteRef}
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            onBlur={() => {
              if (noteText !== (todo.focusNote ?? "")) void setFocusNote(todo.id, noteText);
            }}
            rows={2}
            placeholder="这件事要干什么 / 有什么规则 / 先做什么…"
            className="mt-1 w-full resize-none rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2 text-sm outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
          />
        </div>

        {/* 备注（M13-C 起改叫"这次的备注"：跟这一次番茄记录走，下次开始是空的） */}
        <div>
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400" htmlFor="pomodoro-note">
            这次的备注（可选，跟这次番茄记录走）
          </label>
          <textarea
            id="pomodoro-note"
            data-pomodoro-note
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="这一轮专注里发生了什么 / 被打断了吗…"
            className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
          />
        </div>

        {/* 来源显示（可跳转） */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400">来源</span>
          {onOpenSource ? (
            <button
              type="button"
              data-pomodoro-source
              onClick={onOpenSource}
              className="rounded bg-slate-100 px-2 py-0.5 text-slate-600 hover:bg-indigo-100 hover:text-indigo-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-300"
            >
              {sourceText} →
            </button>
          ) : (
            <span
              data-pomodoro-source
              className="rounded bg-slate-100 px-2 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              {sourceText}
            </span>
          )}
        </div>

        <p className="text-[11px] text-slate-400">
          {autoFinishes
            ? "倒计时走完会自动收尾：待办被标为完成，但不会被删掉。"
            : "点「结束并标完成」收尾：待办被标为完成，但不会被删掉。"}
        </p>

        {settle ? (
          /* ───────── M13-B：结算卡（有疑似离开才出现）─────────
             小窗上也有同一张卡（更紧凑的那版），两边点哪个都一样 —— 都走 resolveSettle。 */
          <div
            data-pomodoro-settle
            className="rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-3 dark:bg-amber-500/10"
          >
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
              这个番茄结束了 —— 有 {clockText(settle.interruptedSeconds)} 疑似离开
            </h3>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-amber-900/90 dark:text-amber-200/90">
              <span>
                计划 <b className="font-mono">{clockText(settle.seconds)}</b>
              </span>
              <span>
                有效{" "}
                <b className="font-mono text-emerald-700 dark:text-emerald-300">
                  {clockText(Math.max(0, settle.seconds - settle.pausedSeconds))}
                </b>
              </span>
              <span>
                疑似离开{" "}
                <b className="font-mono text-amber-700 dark:text-amber-300">
                  {clockText(settle.interruptedSeconds)}
                </b>
              </span>
              {settle.pausedSeconds > 0 && (
                <span>
                  暂停 <b className="font-mono">{clockText(settle.pausedSeconds)}</b>
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-amber-900/70 dark:text-amber-200/70">
              判定依据：{settle.interruptedTimes} 次超过 {awayThresholdSeconds} 秒没动键鼠。
              <br />
              <b>不管选哪个，这次番茄都会被记下来</b>，也会进日历和日报；
              「作废」= 不计入有效专注，并在待办上留一个「⚠ 中断 {settle.interruptedTimes} 次」的记号。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                data-pomodoro-void
                onClick={() => resolveSettle(true)}
                className="rounded-xl bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-700"
              >
                [作废] 这几分钟不算
              </button>
              <button
                type="button"
                data-pomodoro-count
                onClick={() => resolveSettle(false)}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                [计入] 就算{" "}
                {clockText(Math.max(0, settle.seconds - settle.pausedSeconds))}
              </button>
            </div>
          </div>
        ) : confirming ? (
          /* ───────── B 批：「结束」的二次确认（**长在面板内部**，不弹新窗口、不遮任何东西）─────────
             用户原话：「开启待办后右下角的『结束』，说结束就结束有点搞笑，应该加个确认键」。 */
          <div
            data-pomodoro-confirm
            className="rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-3 dark:bg-amber-500/10"
          >
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
              结束这个番茄？（已专注 {shown}）
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-900/80 dark:text-amber-200/80">
              选「结束并标完成」会把这条待办标成完成 —— <b>但不会删掉它</b>，番茄记录也会记下来。
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                data-pomodoro-confirm-finish
                onClick={() => void finish()}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                ✓ 结束并标完成
              </button>
              <button
                type="button"
                data-pomodoro-confirm-cancel
                onClick={cancelConfirm}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                ← 继续专注（不结束）
              </button>
            </div>
            <p className="mt-2 text-[11px] text-amber-900/70 dark:text-amber-200/70">
              想<b>不留任何记录</b>地丢掉这次？点上面那个 ✕ 收起面板后，在待办卡片上用「⚙ → 删除」——
              或者直接关掉小窗（那条路不记账）。
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            {/* B 批：手动暂停 / 继续（暂停那段不计入专注，也不留"被打断"的记号） */}
            <button
              type="button"
              data-pomodoro-pause
              onClick={() => (manualPaused ? resumeManually() : pauseManually())}
              title={
                manualPaused
                  ? "继续计时（暂停的这段时间不算专注）"
                  : "手动暂停：计时冻住，这段时间不算专注"
              }
              className={`rounded-xl border px-3 py-2 text-sm ${
                manualPaused
                  ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {manualPaused ? "▶ 继续" : "⏸ 暂停"}
            </button>
            <button
              type="button"
              data-pomodoro-cancel
              onClick={onClose}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              收起面板
            </button>
            <button
              type="button"
              data-pomodoro-finish
              onClick={() => void finish()}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              结束并标完成
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
