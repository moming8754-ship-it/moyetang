/**
 * 手机版 · 专注（M20 / v2.10.0）
 *
 * 设计稿：`.spike\M18D-rest-zones.html` 第 3 格（专注：大计时器 + 今天的专注 + 软锁说明）。
 *
 * # 跟电脑版的关系
 * **计时引擎完全复用电脑版那套 Rust**（`focus.rs`：每秒采样、锁屏/睡过自动暂停、"疑似离开"、
 * 结算数字以后端快照为准）。这里只是**换一套手机能用的界面**：
 *   - 电脑版是"右下角常驻面板 + 独立小窗"，手机上是**整屏一页**（屏幕小，浮层会挡住内容）；
 *   - 电脑版靠 `focus-tick` 事件推数字，手机端**每秒轮询 `focus_monitor_state()`**（更简单，行为一致）。
 *
 * # 软锁（用户 2026-10-05 拍板：**先做「常驻通知 + 到点全屏提醒」**，悬浮窗留成开关）
 * - ✅ **到点全屏提醒**：倒计时归零 → 整屏覆盖层 + 「继续 / 结束」两个选择（这一版做了）
 * - ✅ **不让系统杀掉的引导**：首次进入给一条 MIUI「自启动 / 省电白名单」提示（可关掉，记住选择）
 * - ⏳ **常驻通知**（真·前台服务）还没做：那要在 `gen/android` 里写 Kotlin 前台服务 + 清单权限，
 *   已登记为 **M20.1**（见 `进度.md`）。**没有假装它已经做了。**
 *
 * # 验收抓手（**别改名**，`tools\m19` / `tools\m20` 依赖它们）
 * `data-mtodo-pomo`（m19 的老抓手，保留）· `data-mtodo-pomo-time` · `data-mtodo-pomo-finish`（m19 用）
 * `data-mfocus` · `data-mfocus-mode` · `data-mfocus-pause` · `data-mfocus-void` · `data-mfocus-state`
 * `data-mfocus-note` · `data-mfocus-guide` · `data-mfocus-reminder`
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { focusMonitorStart, focusMonitorState, focusMonitorStop } from "../../features/api";
import type { FocusTick, Todo } from "../../features/types";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

type Mode = "countdown" | "countup" | "free";

const MODE_LABEL: Record<Mode, string> = {
  countdown: "倒计时",
  countup: "正计时",
  free: "不计时",
};

const DURATIONS = [15, 25, 45, 60];

/** 引导条关掉之后记住（同一台机器别每次都弹） */
const GUIDE_KEY = "dsh-miui-guide-done";

function mmss(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

export default function FocusPanel({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const addPomodoro = useData((s) => s.addPomodoro);
  const setFocusNote = useData((s) => s.setFocusNote);
  const config = useData((s) => s.config);
  const toast = useUi((s) => s.toast);

  const threshold = config?.focus?.awayThresholdSeconds ?? 90;
  const presetMinutes = todo.customMinutes ?? config?.focus?.customMinutes ?? 25;

  const [mode, setMode] = useState<Mode>("countdown");
  const [minutes, setMinutes] = useState<number>(presetMinutes);
  const [manualPaused, setManualPaused] = useState(false);
  const [manualPausedSeconds, setManualPausedSeconds] = useState(0);
  const [tick, setTick] = useState<FocusTick | null>(null);
  /** 本地的"墙上时间"锚点：真实经过的秒数（不含暂停由 tick.pausedSeconds 扣） */
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState("");
  const [focusNote, setFocusNoteText] = useState(todo.focusNote ?? "");
  const [confirming, setConfirming] = useState(false);
  const [reminded, setReminded] = useState(false);
  const [guideOpen, setGuideOpen] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const started = useRef(false);

  // ── 1) 起一次会话（只起一次；Rust 那套跟电脑版完全一样）
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void focusMonitorStart(todo.id, threshold).then(setTick).catch(() => {
      toast("专注引擎没起来（手机上可能不支持）", "error");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 2) 每秒：本地时钟 + 轮询后端快照（拿"已暂停多久/疑似离开"这些）
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void focusMonitorState()
        .then((one) => setTick(one))
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // ── 3) 手动暂停也在数秒（面板上要能看见"手动暂停 N 秒"）
  useEffect(() => {
    if (!manualPaused) return;
    const timer = window.setInterval(() => setManualPausedSeconds((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [manualPaused]);

  /** 已暂停的总秒数 = 后端那份（锁屏/睡过）+ 手动那份 */
  const pausedTotal = (tick?.pausedSeconds ?? 0) + manualPausedSeconds;
  /** 真实在专注的秒数 */
  const elapsed = useMemo(() => {
    const wall = Math.floor((now - startedAt) / 1000);
    return Math.max(0, wall - pausedTotal);
  }, [now, startedAt, pausedTotal]);

  const targetSeconds = mode === "countdown" ? minutes * 60 : 0;
  const remaining = Math.max(0, targetSeconds - elapsed);

  // ── 4) 到点：整屏提醒（软锁的"到点全屏提醒"这一半）
  useEffect(() => {
    if (mode !== "countdown" || reminded) return;
    if (targetSeconds > 0 && elapsed >= targetSeconds) setReminded(true);
  }, [mode, reminded, targetSeconds, elapsed]);

  // ── 5) 离开这一页时把会话收干净（**不结算**，由用户点结束）
  useEffect(() => {
    return () => {
      void focusMonitorStop().catch(() => undefined);
    };
  }, []);

  const saveFocusNote = useCallback(
    (text: string) => {
      setFocusNoteText(text);
      void setFocusNote(todo.id, text).catch(() => undefined);
    },
    [setFocusNote, todo.id],
  );

  /** 结算：计入（finish=true 顺手标完成，照电脑版"只标不删"）或作废 */
  const settle = async (voided: boolean) => {
    const snap = await focusMonitorStop().catch(() => null);
    const backendPaused = Math.max(0, (snap?.pausedSeconds ?? 0) - 0);
    await addPomodoro(todo.id, mode, elapsed, note, !voided, {
      interruptedSeconds: snap?.interruptedSeconds ?? 0,
      interruptedTimes: snap?.interruptedTimes ?? 0,
      pausedSeconds: backendPaused + manualPausedSeconds,
      manualPausedSeconds,
      voided,
    });
    toast(voided ? "这次作废了（记录照留）" : "记下一次专注：" + mmss(elapsed), "success");
    onClose();
  };

  const stateText = (() => {
    if (tick?.paused && tick.pauseReason === "lock") return "⏸ 已暂停 · 锁屏";
    if (tick?.paused && tick.pauseReason === "sleep") return "⏸ 已暂停 · 屏幕睡过去了";
    if (manualPaused) return "⏸ 已暂停 · 手动";
    if (tick?.awayNow) return "⚠ 没动键鼠 " + tick.interruptedTimes + " 次";
    return "▶ 专注中";
  })();

  return (
    <div
      data-mtodo-pomo
      data-mfocus
      data-mfocus-state={stateText}
      className="absolute inset-0 z-40 flex flex-col bg-white dark:bg-slate-900"
    >
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <button type="button" data-mfocus-back onClick={onClose} className="text-[13px] text-slate-500">
          ‹ 返回
        </button>
        <span className="truncate px-2 text-[13px] font-medium">{todo.title}</span>
        <span className="w-10" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4">
        {/* MIUI 引导（软锁的一半：别让系统把计时杀掉） */}
        {guideOpen && (
          <div data-mfocus-guide className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="font-semibold">让专注不被系统打断（小米/红米必看）</p>
            <p className="mt-1">
              去「设置 → 应用设置 → 东方摩耶堂」里打开<b>自启动</b>，并在<b>省电策略</b>里选「无限制」；
              再把最近任务里给它<b>加锁</b>。这样专注计时在后台不容易被清掉。
            </p>
            <button
              type="button"
              data-mfocus-guide-ok
              onClick={() => {
                setGuideOpen(false);
                try {
                  localStorage.setItem(GUIDE_KEY, "1");
                } catch {
                  /* 记不住就算了，下次再提示一遍 */
                }
              }}
              className="mt-2 rounded-lg border border-amber-400 px-3 py-1 text-[12px]"
            >
              知道了
            </button>
          </div>
        )}

        {/* 表盘 */}
        <div className="text-center">
          <p data-mtodo-pomo-time className="text-[56px] font-bold leading-none tabular-nums">
            {mode === "countdown" ? mmss(remaining) : mmss(elapsed)}
          </p>
          <p className="mt-2 text-[12.5px] text-slate-500">{stateText}</p>
          {pausedTotal > 0 && (
            <p className="mt-1 text-[11.5px] text-slate-400">
              已暂停 {mmss(pausedTotal)}（不计入专注）
              {tick && tick.interruptedSeconds > 0 ? " · 疑似离开 " + mmss(tick.interruptedSeconds) : ""}
            </p>
          )}
        </div>

        {/* 模式与时长 */}
        <div className="mt-5 flex justify-center gap-1.5">
          {(["countdown", "countup", "free"] as Mode[]).map((key) => (
            <button
              key={key}
              type="button"
              data-mfocus-mode={key}
              data-mfocus-mode-active={mode === key ? "1" : "0"}
              onClick={() => setMode(key)}
              className={
                "rounded-full border px-3 py-1 text-[12px] " +
                (mode === key
                  ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
              }
            >
              {MODE_LABEL[key]}
            </button>
          ))}
        </div>
        {mode === "countdown" && (
          <div className="mt-2 flex justify-center gap-1.5">
            {DURATIONS.map((one) => (
              <button
                key={one}
                type="button"
                data-mfocus-duration={one}
                onClick={() => setMinutes(one)}
                className={
                  "rounded-lg border px-2.5 py-1 text-[12px] tabular-nums " +
                  (minutes === one
                    ? "border-indigo-400 text-indigo-600 dark:text-indigo-300"
                    : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                }
              >
                {one} 分
              </button>
            ))}
          </div>
        )}

        {/* 操作 */}
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            data-mfocus-pause
            onClick={() => setManualPaused((v) => !v)}
            className="rounded-xl border border-slate-200 px-5 py-2 text-[14px] dark:border-slate-700"
          >
            {manualPaused ? "继续" : "暂停"}
          </button>
          <button
            type="button"
            data-mtodo-pomo-finish
            onClick={() => setConfirming(true)}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-[14px] font-medium text-white"
          >
            结束
          </button>
        </div>

        {/* 须知（跟这条待办走、长期有效 —— 跟电脑版同一份数据） */}
        <div className="mt-6">
          <p className="text-[12px] font-semibold text-slate-500">须知（跟这条待办走，下次开始还在）</p>
          <textarea
            data-mfocus-note
            value={focusNote}
            rows={2}
            onChange={(event) => saveFocusNote(event.target.value)}
            placeholder="这件事要干什么、有什么规则…"
            className="mt-1 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />
        </div>

        {/* 本次备注（跟这一次记录走） */}
        <div className="mt-3">
          <p className="text-[12px] font-semibold text-slate-500">这一次做到哪了（可留空）</p>
          <input
            data-mfocus-memo
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />
        </div>
      </div>

      {/* 结束：二次确认（照电脑版 v1.10.0 的规矩，别让人一按就结算） */}
      {confirming && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-6">
          <div data-mfocus-confirm className="w-full rounded-2xl bg-white p-4 dark:bg-slate-800">
            <p className="text-[14px] font-semibold">结束这次专注？</p>
            <p className="mt-1 text-[12.5px] text-slate-500">
              已经专注 {mmss(elapsed)}
              {pausedTotal > 0 ? "（暂停 " + mmss(pausedTotal) + " 没算进去）" : ""}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                data-mfocus-confirm-yes
                onClick={() => void settle(false)}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-[14px] font-medium text-white"
              >
                计入这次专注
              </button>
              <button
                type="button"
                data-mfocus-void
                onClick={() => void settle(true)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-[13.5px] text-slate-500 dark:border-slate-700"
              >
                作废（不计入有效专注，记录照留）
              </button>
              <button
                type="button"
                data-mfocus-confirm-cancel
                onClick={() => setConfirming(false)}
                className="rounded-xl px-4 py-2 text-[13px] text-slate-400"
              >
                继续专注
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 到点整屏提醒（软锁的"到点全屏提醒"） */}
      {reminded && (
        <div data-mfocus-reminder className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-indigo-600 p-8 text-white">
          <p className="text-[15px] opacity-90">{todo.title}</p>
          <p className="mt-3 text-[40px] font-bold tabular-nums">{mmss(elapsed)}</p>
          <p className="mt-1 text-[14px] opacity-90">时间到了 —— 收个尾，或者再来一轮</p>
          <div className="mt-6 flex gap-2">
            <button
              type="button"
              data-mfocus-reminder-continue
              onClick={() => {
                setReminded(false);
                setMinutes(minutes);
                setMode("countup");
              }}
              className="rounded-xl bg-white/20 px-5 py-2 text-[14px]"
            >
              继续做
            </button>
            <button
              type="button"
              data-mfocus-reminder-finish
              onClick={() => {
                setReminded(false);
                setConfirming(true);
              }}
              className="rounded-xl bg-white px-5 py-2 text-[14px] font-medium text-indigo-600"
            >
              结束并记下
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
