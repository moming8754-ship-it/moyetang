/**
 * 专注小窗（M13-A 建 · M13-B 加"意外中断"三态 · M13-C 加「须知」与格言）——
 * 待办点「开始」后**长期挂在右下角**的那个小窗，表示"这件事正在进行中"。
 *
 * # 它是什么、不是什么
 * - **是**一个状态显示器 + 几个按钮 + 一块可编辑的「须知」；
 * - **不是**计时器的家：计时状态在**主窗**（`features/todos/Pomodoro.tsx`）里跑，
 *   这里只是收 `focus-state` 事件把它画出来 —— 这样"谁是权威"只有一处；
 * - **也不是**判定的家：锁屏 / 睡过 / 疑似离开是 **Rust 监控线程**判的，主窗把结论一起推过来；
 * - 🔴 **写数据的只有一个窗口**：这里改「须知」只发**意图**（`focus-note`），
 *   真正落盘由**主窗**做（它手上才有 store）—— 两个窗口各写一次迟早打架。
 *
 * # 消息怎么走
 * - 主窗 → 这里：`emitTo("focus", "focus-state", FocusState)`（秒数变化 / 须知变化 / 格言变化都推）
 * - 这里 → 主窗：`emitTo("main", "focus-intent", { action, ... })`
 *   action：`finish` / `hide` / `open` / `resume` / `count` / `void`
 *   M13-C 新增：`focus-note`（带上 `text`）/ `motto-next`（换一条）/ `motto-pick`（带上 `id`）
 *
 * # ⚠️ 窗口高度（M13-C）
 * 内容多了它自己长高（用户 2026-09-26 定："按内容自己长"），**上限 320**，
 * 而且**长高时要往上顶**（原来的底边贴着屏幕下沿，往下长会跑出屏幕外）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { mottoList } from "../features/api";
import type { FocusState, Motto } from "../features/types";

/** 窗口宽度（跟 Rust 侧 `window.rs` 的 `FOCUS_W` 对齐） */
const WIDTH = 300;
/** 高度上限：再长就要把主窗挡掉一大块了 */
const MAX_HEIGHT = 320;
/** 基础高度：只有标题 + 钟 + 进度 + 按钮那一档 */
const MIN_HEIGHT = 196;

/** 秒数 → `MM:SS`（超过一小时给 `H:MM:SS`） */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = `${m}`.padStart(2, "0");
  const ss = `${s}`.padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 秒数 → 「12 分 03 秒」这种给人看的话 */
function human(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${`${s}`.padStart(2, "0")} 秒` : `${s} 秒`;
}

export default function FocusWindow() {
  const [state, setState] = useState<FocusState | null>(null);
  /** 「须知」编辑中：草稿放本地，保存时才发意图（主窗落盘后会把新的推回来） */
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  /** 格言选择列表开着吗（点了「📋 挑」才去读，平时不做任何请求） */
  const [picking, setPicking] = useState(false);
  const [mottos, setMottos] = useState<Motto[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** 上一次的会话 id（待办 id）：换了会话就把窗内的临时状态清干净 */
  const sessionRef = useRef<string>("");

  // 🔴 2026-09-26 验收踩出来的真 bug：**窗口 hide 不销毁页面**，所以窗内的临时状态
  //   （「格言选择列表」开着、须知编辑到一半）会留到下一次专注 —— 下一轮的验收里它把
  //   `[data-focus-motto]` 挡在后面，读不到格言。所以**会话一变就复位**。
  useEffect(() => {
    const id = state?.todoId ?? "";
    if (id === sessionRef.current) return;
    sessionRef.current = id;
    setPicking(false);
    setNoteDraft(null);
  }, [state?.todoId]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<FocusState>("focus-state", (event) => {
      setState(event.payload);
      // 主窗把「须知」落盘之后会推回来：这时候如果不在编辑，就同步显示
      setNoteDraft((draft) => (draft === null ? null : draft));
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 专注小窗监听状态失败", error);
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const intent = (
    action: "finish" | "hide" | "open" | "resume" | "pause" | "count" | "void" | "motto-next",
  ) => {
    void emitTo("main", "focus-intent", { action }).catch((error: unknown) => {
      console.error("[东方摩耶堂] 专注小窗发意图失败", error);
    });
  };

  /** 保存「须知」：交给主窗落盘（空串 = 清掉） */
  const saveNote = useCallback(() => {
    if (noteDraft === null) return;
    const text = noteDraft;
    setNoteDraft(null);
    void emitTo("main", "focus-intent", { action: "focus-note", text }).catch(
      (error: unknown) => {
        console.error("[东方摩耶堂] 保存须知失败", error);
      },
    );
  }, [noteDraft]);

  /** 从技能区挑一条格言（只读一次；挑完发 id 给主窗写进配置） */
  const openPicker = useCallback(() => {
    void (async () => {
      try {
        const list = await mottoList();
        setMottos(list.slice(0, 8));
        setPicking(true);
      } catch (error) {
        console.error("[东方摩耶堂] 读取格言失败", error);
      }
    })();
  }, []);

  const chooseMotto = (id: string) => {
    setPicking(false);
    void emitTo("main", "focus-intent", { action: "motto-pick", id }).catch(
      (error: unknown) => {
        console.error("[东方摩耶堂] 选择格言失败", error);
      },
    );
  };

  // 倒计时：显示剩余；正计时 / 不计时：显示已走
  const remaining = state
    ? state.mode === "countdown" && state.target > 0
      ? Math.max(0, state.target - state.elapsed)
      : state.elapsed
    : 0;
  const progress =
    state && state.mode === "countdown" && state.target > 0
      ? Math.min(100, Math.round((state.elapsed / state.target) * 100))
      : 0;

  const settle = state?.settle ?? null;
  const paused = !!state?.paused;
  /** B 批：这个暂停是**用户自己按的**（不是锁屏/休眠那种自动暂停） */
  const manualPaused = !!state?.manualPaused;
  /** C 批：工作的定时提示（`0` = 这轮还没到过 / 功能关着） */
  const workPromptAt = state?.workPromptAtSeconds ?? 0;
  const resumePending = !!state?.resumePending;
  const away = !!state?.awayNow;
  const interrupted = state?.interruptedSeconds ?? 0;
  const pausedSeconds = state?.pausedSeconds ?? 0;
  const effective = settle ? Math.max(0, settle.seconds - settle.pausedSeconds) : 0;
  const editingNote = noteDraft !== null;
  const noteText = (state?.focusNote ?? "").trim();
  const motto = state?.motto ?? null;

  /** 标题条左边那个点 + 那句状态词 */
  const dotClass = settle
    ? "bg-amber-500"
    : paused
      ? "bg-slate-500"
      : away
        ? "bg-amber-400"
        : "bg-rose-500";
  const statusText = settle
    ? "番茄结束了"
    : paused
      ? manualPaused
        ? "你暂停了"
        : "已暂停"
      : resumePending
        ? "等你一句话"
        : away
          ? "疑似离开"
          : "专注中";

  // ───────── M13-C：按内容自己长高（上限 320，且长高时往上顶） ─────────
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const body = bodyRef.current;
        if (!body || cancelled) return;
        const needed = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(body.scrollHeight)));
        try {
          const win = getCurrentWindow();
          const factor = await win.scaleFactor();
          const size = await win.innerSize();
          const want = Math.round(needed * factor);
          if (Math.abs(want - size.height) < 2) return;
          const pos = await win.outerPosition();
          // 底边贴住屏幕下沿 → 长高就往**上**顶；
          // ⚠️ 但要**夹住 y ≥ 0**：小窗被拖到屏幕上方时，无脑往上顶会把它顶出屏幕外
          //    （2026-09-26 验收实测：88 → -98，窗口上半截跑到屏幕上面去了）。
          await win.setSize(new PhysicalSize(Math.round(WIDTH * factor), want));
          await win.setPosition(new PhysicalPosition(pos.x, Math.max(0, pos.y + size.height - want)));
        } catch (error) {
          console.error("[东方摩耶堂] 调小窗高度失败", error);
        }
      })();
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // 内容一变就重量（须知 / 格言 / 状态条 / 编辑态都算）
  }, [noteText, motto?.text, editingNote, settle, paused, resumePending, away, picking]);

  return (
    <div
      data-focus-body
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 text-slate-100"
    >
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {/* 标题条：整条都能拖窗口 */}
        <div
          data-tauri-drag-region
          className="flex shrink-0 cursor-move items-center gap-2 bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-300"
        >
          <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${dotClass}`} />
          <span data-focus-status>{statusText}</span>
          <span className="ml-auto font-mono text-[10.5px] text-slate-400">
            {settle
              ? "🍅 结算"
              : state?.mode === "countdown"
                ? `🍅 倒计时 ${Math.round((state?.target ?? 0) / 60)} 分`
                : state?.mode === "countup"
                  ? "🍅 正计时"
                  : "🍅 不计时"}
          </span>
          <button
            type="button"
            data-focus-hide
            title="收起这个小窗（计时继续走着）"
            onClick={() => intent("hide")}
            className="rounded px-1 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-2">
          {/* M13-C：标题加大加粗 —— 它就该是这个窗里最显眼的一行 */}
          <div
            data-focus-title
            className="line-clamp-2 text-[15px] font-bold leading-snug tracking-[0.2px]"
          >
            {state?.title ?? "（没有正在进行的待办）"}
          </div>

          {settle ? (
            /* ───────── 结算卡：有疑似离开才出现，就地二选一 ───────── */
            <div data-focus-settle className="mt-1.5 flex min-h-0 flex-1 flex-col">
              <div className="flex items-baseline gap-2 font-mono text-[11px] text-slate-300">
                <span>有效 {clock(effective)}</span>
                <span className="text-amber-300">疑似离开 {clock(settle.interruptedSeconds)}</span>
              </div>
              <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <span className="block h-full bg-indigo-500" style={{ width: `${progress}%` }} />
                <span
                  className="block h-full bg-amber-500"
                  style={{ width: `${100 - progress}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] leading-snug text-slate-500">
                不论选哪个都会记下来、进日报
              </p>
              <div className="mt-auto flex gap-1.5 pt-1.5">
                <button
                  type="button"
                  data-focus-void
                  onClick={() => intent("void")}
                  title="这几分钟不算专注（记录照留，待办上留个记号）"
                  className="rounded-lg bg-amber-600 px-2.5 py-1 text-[11.5px] text-white hover:bg-amber-700"
                >
                  作废
                </button>
                <button
                  type="button"
                  data-focus-count
                  onClick={() => intent("count")}
                  className="ml-auto rounded-lg bg-indigo-600 px-3 py-1 text-[11.5px] font-medium text-white hover:bg-indigo-700"
                >
                  计入
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                data-focus-clock={remaining}
                className={`mt-2 font-mono text-[26px] leading-none tracking-wide ${
                  paused || resumePending ? "text-slate-400" : ""
                }`}
              >
                {clock(remaining)}
              </div>

              {state?.mode === "countdown" && state.target > 0 && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <span
                    data-focus-progress={progress}
                    className="block h-full bg-indigo-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}

              {/* ───────── 三种"出事了"的提示条 ───────── */}
              {paused && (
                <div
                  data-focus-paused
                  className="mt-1.5 rounded-lg border border-slate-600 bg-slate-800/60 px-1.5 py-1 text-[10px] leading-snug text-slate-400"
                >
                  {manualPaused
                    ? "你自己按了暂停"
                    : state?.pauseReason === "sleep"
                      ? "电脑睡过去了"
                      : "锁屏了" + "，自动暂停"}
                  {pausedSeconds > 0 ? ` · 已暂停 ${human(pausedSeconds)}` : ""}
                  <br />
                  这段时间不计入专注
                </div>
              )}
              {resumePending && (
                <div
                  data-focus-resume
                  className="mt-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-1.5 py-1 text-[10px] leading-snug text-amber-200"
                >
                  刚才离开了 <b>{human(pausedSeconds)}</b>，继续吗？
                </div>
              )}
              {!paused && !resumePending && away && (
                <div
                  data-focus-away
                  className="mt-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-1.5 py-1 text-[10px] leading-snug text-amber-200"
                >
                  ⚠ 疑似离开 {human(state?.idleSeconds ?? 0)} · 计时仍在走
                </div>
              )}
              {!paused && !resumePending && !away && interrupted > 0 && (
                <div
                  data-focus-interrupted
                  className="mt-1.5 text-[10px] leading-snug text-slate-500"
                >
                  这次已累计疑似离开 {human(interrupted)}
                </div>
              )}

              {/* ───────── C 批（2026-10-02）：工作中的定时提示 ─────────
                  用户脑图第 8 条。**只在这里显示一句**，不弹窗、不打断、不落盘。 */}
              {workPromptAt > 0 && (
                <div
                  data-focus-work-prompt={workPromptAt}
                  className="mt-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-1 text-[10px] leading-snug text-indigo-200"
                >
                  ⏳ 已经专注 <b>{human(workPromptAt)}</b> 了 —— 喝口水、直直腰，或者继续。
                </div>
              )}

              {/* ───────── M13-C①：「须知」（跟待办走，点一下就地改） ───────── */}
              {editingNote ? (
                <div
                  data-focus-note-edit
                  className="mt-2 rounded-lg border border-indigo-400 bg-slate-950 px-1.5 py-1"
                >
                  <div className="text-[10px] text-slate-400">📝 须知（正在写）</div>
                  <textarea
                    data-focus-note-input
                    autoFocus
                    rows={3}
                    value={noteDraft ?? ""}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    onBlur={saveNote}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setNoteDraft(null);
                      }
                    }}
                    placeholder="这件事要干什么 / 有什么规则…"
                    className="mt-0.5 w-full resize-none bg-transparent text-[11px] leading-snug text-slate-100 outline-none placeholder:text-slate-600"
                  />
                  <div className="text-[9.5px] text-slate-500">Esc 取消 · 点别处保存</div>
                </div>
              ) : noteText ? (
                <div
                  data-focus-note={noteText}
                  title="点一下就能改"
                  onClick={() => setNoteDraft(state?.focusNote ?? "")}
                  className="mt-2 cursor-text whitespace-pre-wrap rounded-lg border border-dashed border-slate-600 px-1.5 py-1 text-[11px] leading-snug text-slate-200 hover:border-indigo-400"
                >
                  <span className="mr-1 text-[10px] text-slate-500">📝</span>
                  {noteText}
                </div>
              ) : (
                <button
                  type="button"
                  data-focus-note-empty
                  onClick={() => setNoteDraft("")}
                  className="mt-2 rounded-lg border border-dotted border-slate-700 px-1.5 py-1 text-left text-[10.5px] leading-snug text-slate-500 hover:border-indigo-400 hover:text-slate-300"
                >
                  📝 点这里写「须知」：这件事要干什么、有什么规则…
                </button>
              )}

              {/* ───────── M13-C②：格言与原则（默认自动挑，可换可挑） ───────── */}
              {picking ? (
                <div
                  data-focus-motto-picker
                  className="mt-2 overflow-hidden rounded-lg border border-indigo-500/60 bg-slate-950"
                >
                  <div className="flex items-center bg-slate-800 px-1.5 py-0.5 text-[9.5px] text-slate-400">
                    技能区 · 格言与原则
                    <button
                      type="button"
                      onClick={() => setPicking(false)}
                      className="ml-auto text-slate-400 hover:text-slate-100"
                    >
                      ✕
                    </button>
                  </div>
                  {mottos.length === 0 && (
                    <div className="px-1.5 py-1 text-[10px] text-slate-500">
                      技能区还没有格言（去「技能区 → 格言与原则」写一条）
                    </div>
                  )}
                  {mottos.map((one) => (
                    <button
                      key={one.id}
                      type="button"
                      data-focus-motto-option={one.id}
                      onClick={() => chooseMotto(one.id)}
                      className="block w-full truncate px-1.5 py-1 text-left text-[10.5px] text-slate-200 hover:bg-indigo-500/20"
                    >
                      {one.text}
                      <span className="ml-1 text-[9px] text-slate-500">
                        {one.kind === "rule" ? "原则" : "格言"}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    data-focus-motto-shuffle
                    onClick={() => {
                      setPicking(false);
                      intent("motto-next");
                    }}
                    className="block w-full border-t border-slate-800 px-1.5 py-1 text-left text-[10px] text-slate-400 hover:bg-slate-800"
                  >
                    🔄 随便翻一句
                  </button>
                </div>
              ) : motto ? (
                <div
                  data-focus-motto={motto.text}
                  className="mt-2 border-t border-slate-800 pt-1.5 text-[10.5px] leading-snug text-indigo-300"
                >
                  💬 「{motto.text}」
                  <span className="text-slate-500">
                    {motto.from ? ` —— ${motto.from}` : ""}
                  </span>
                  <span className="float-right whitespace-nowrap text-[9.5px] text-slate-500">
                    <button
                      type="button"
                      data-focus-motto-next
                      title="换一条"
                      onClick={() => intent("motto-next")}
                      className="hover:text-slate-200"
                    >
                      🔄
                    </button>
                    <button
                      type="button"
                      data-focus-motto-pick
                      title="从技能区挑一条（留一整天）"
                      onClick={openPicker}
                      className="ml-1.5 hover:text-slate-200"
                    >
                      📋
                    </button>
                  </span>
                </div>
              ) : null}

              <div className="mt-auto flex gap-1.5 pt-2">
                {resumePending ? (
                  <>
                    <button
                      type="button"
                      data-focus-continue
                      onClick={() => intent("resume")}
                      className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-indigo-700"
                    >
                      ▶ 继续
                    </button>
                    <button
                      type="button"
                      data-focus-finish
                      onClick={() => intent("finish")}
                      className="ml-auto rounded-lg border border-slate-600 px-2.5 py-1 text-[11.5px] text-slate-300 hover:bg-slate-800"
                    >
                      ✓ 结束这个番茄
                    </button>
                  </>
                ) : (
                  <>
                    {/* B 批（2026-10-02）：**手动暂停 / 继续** —— 用户常盯着这个小窗，
                        在这儿就能停一下，不用先回执行区。它只发意图，真冻结在主窗做。 */}
                    <button
                      type="button"
                      data-focus-pause
                      title={
                        manualPaused
                          ? "继续计时（暂停的这段不算专注）"
                          : "暂停：计时冻住，这段不算专注"
                      }
                      onClick={() => intent(manualPaused ? "resume" : "pause")}
                      className={`rounded-lg border px-2.5 py-1 text-[11.5px] ${
                        manualPaused
                          ? "border-indigo-500 bg-indigo-600 font-medium text-white hover:bg-indigo-700"
                          : "border-slate-600 text-slate-300 hover:bg-slate-800"
                      }`}
                    >
                      {manualPaused ? "▶ 继续" : "⏸ 暂停"}
                    </button>
                    <button
                      type="button"
                      data-focus-open
                      onClick={() => intent("open")}
                      className="rounded-lg border border-slate-600 px-2.5 py-1 text-[11.5px] text-slate-300 hover:bg-slate-800"
                    >
                      ↗ 打开执行区
                    </button>
                    <button
                      type="button"
                      data-focus-finish
                      onClick={() => intent("finish")}
                      title="会先问一次（确认条在执行区那块面板上）"
                      className="ml-auto rounded-lg bg-indigo-600 px-3 py-1 text-[11.5px] font-medium text-white hover:bg-indigo-700"
                    >
                      ✓ 结束
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
