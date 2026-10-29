/**
 * 桌面挂件（E 批，2026-10-03）—— 窗口 label = `widget`。
 *
 * # 它是什么，跟"专注小窗"什么关系
 *
 * 用户原话：「类似 widget 的常驻展示……可以做到桌面上看见挂件。我想实现随时随地能看到
 * 格言、待办、日课（未来的倒数计时）的效果」。他 2026-10-03 点头的方向：
 * **中号 + 普通置顶 + 与专注小窗不合并**。
 *
 * 🔴 **跟 `FocusWindow`（专注小窗）是两码事，别合并**：
 * - 专注小窗的生死跟着**番茄钟**（开始时弹、结束就收）；
 * - 挂件的生死跟着**用户**（想让它在就一直在，不专注的时候也在）。
 * 两者规则相反，所以是两个窗口、两份页面。专注中挂件上**多一格只读的倒计时**
 * （要暂停/结束还是去专注小窗 —— 挂件只负责"看一眼"，塞按钮进去既重复又容易点错）。
 *
 * # 三条"别抢"的规矩（跟专注小窗同源）
 * 1. **别抢焦点**：窗口创建时 `.focused(false)`（在 `window.rs` 里），这里也**不许**调 `setFocus()`；
 * 2. **只读**：挂件自己不写数据（唯一会做的事是"点一下跳到主窗对应页面"）；
 * 3. **拖动靠 `data-tauri-drag-region`**：无边框窗口的标题条拖拽交给 Tauri，
 *    别自己写指针逻辑（M4 那套是给画布节点用的，这里用不上）。
 *
 * ⚠️ 验收脚本的抓手（**别改名**）：`data-widget` / `-slot` / `-motto` / `-todo` / `-pomodoro` /
 * `-info` / `-clock` / `-focus`（专注中那格）/ `-close` / `-open-todos`。
 */
import { useEffect, useMemo, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useData } from "../store/data";
import { mottoList, widgetClose } from "../features/api";
import type { FocusState, Motto, Pomodoro } from "../features/types";
import { ordered, todayMotto } from "../features/skills/mottos";
import { isToday } from "../features/todos/time";
import { countdownShort, countdownText, daysLeftOf, sortByDate } from "../features/countdown/time";

/** 本地日期 `YYYY-MM-DD`（⚠️ 别用 toISOString —— 那是 UTC，晚上 8 点后会差一天） */
function localDay(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function clockOf(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = `${Math.floor(safe / 60)}`.padStart(2, "0");
  const ss = `${safe % 60}`.padStart(2, "0");
  return `${mm}:${ss}`;
}

/** 走时的钟（每分钟自己重画一次；挂件上那个大号时间用） */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export default function Widget() {
  const config = useData((s) => s.config);
  const todos = useData((s) => s.todos);
  const infos = useData((s) => s.infos);
  /** 倒计时（2026-10-04）：挂件上那一格读它 */
  const countdowns = useData((s) => s.countdowns);
  /** 格言：跟专注小窗一样**单独读一次**（它不在 store 里 —— 跟 `FocusWindow` 同一个套路） */
  const [mottos, setMottos] = useState<Motto[]>([]);
  const refresh = useData((s) => s.refresh);
  const now = useMinuteClock();

  /** 专注中的实时状态（从主窗推过来；没在专注就是 null） */
  const [focusState, setFocusState] = useState<FocusState | null>(null);

  // 挂件窗也要自己拉一次数据：它是**独立窗口**，主窗 `App` 那边的 refresh 不会喂给它
  useEffect(() => {
    void refresh();
    void mottoList()
      .then(setMottos)
      .catch(() => undefined);
  }, [refresh]);

  // 格言变了要跟着变（在技能区改了格言 → 挂件上也该变）
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen("data-changed", () => {
      void mottoList()
        .then(setMottos)
        .catch(() => undefined);
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // 数据变了要跟着变（主窗 emit 的 `data-changed` 是所有窗口一起收的）
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen("data-changed", () => {
      void useData.getState().refresh();
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // 专注状态：主窗每秒 `emitTo("widget", "focus-state", …)`（没有会话时不推）
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<FocusState>("focus-state", (event) => {
      setFocusState(event.payload ?? null);
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const slots = config.widget.show;
  const has = (slot: string) => slots.includes(slot as never);
  /**
   * 挂件上要显示的倒计时（2026-10-04）：**只算勾了「上挂件」的**，按日期从近到远，最多 2 条
   * （挂件是常驻的，不能被撑高）。天数现算，不靠定时器。
   */
  const widgetCountdowns = sortByDate(countdowns.filter((one) => one.onWidget))
    .slice(0, 2)
    .map((one) => ({ one, days: daysLeftOf(one.date) }));

  /** 今天这一句（跟专注小窗同一份真源：手动挑的留一整天 → 否则按日期哈希挑） */
  const motto = useMemo(() => {
    const list = ordered(mottos);
    const today = localDay(new Date());
    const picked =
      config.focus.mottoPickDate === today
        ? list.find((one) => one.id === config.focus.mottoPickId)
        : undefined;
    return picked ?? todayMotto(list);
  }, [mottos, config.focus.mottoPickDate, config.focus.mottoPickId]);

  /** 今日待办：今天安排的 或 快到期的，最多 4 条（挂件上多了看着累） */
  const todayTodos = useMemo(() => {
    const open = todos.filter((one) => one.status !== "done");
    const planned = open.filter((one) => one.plannedAt && isToday(one.plannedAt));
    const due = open.filter((one) => one.dueAt);
    const seen = new Set<string>();
    const out: typeof open = [];
    for (const one of [...planned, ...due, ...open]) {
      if (seen.has(one.id)) continue;
      seen.add(one.id);
      out.push(one);
      if (out.length >= 4) break;
    }
    return out;
  }, [todos]);

  /** 今天的番茄（条数 + 有效秒数） */
  const todayPom = useMemo(() => {
    const all: Pomodoro[] = [];
    for (const todo of todos) {
      for (const pom of todo.pomodoros ?? []) {
        if (isToday(pom.at)) all.push(pom);
      }
    }
    const seconds = all.reduce((sum, one) => {
      if (one.voided) return sum;
      return sum + Math.max(0, one.seconds - (one.pausedSeconds ?? 0));
    }, 0);
    return { count: all.length, seconds };
  }, [todos]);

  /** 今天录了几条信息、几条还没联动 */
  const todayInfo = useMemo(() => {
    const mine = infos.filter((one) => isToday(one.createdAt));
    return { count: mine.length, pending: mine.filter((one) => one.status !== "linked").length };
  }, [infos]);

  /** 专注中那格：优先用主窗推来的实时状态（它才是计时的权威） */
  const focusing = focusState?.todoId
    ? {
        title: focusState.title,
        remaining:
          focusState.mode === "countdown"
            ? Math.max(0, focusState.target - focusState.elapsed)
            : focusState.elapsed,
        paused: !!focusState.paused,
      }
    : null;

  const openMain = (view: string, kind: string, id: string) => {
    // 点挂件上的条目 → 唤回主窗并跳到对应位置（挂件自己只发意图，不写数据）
    void emitTo("main", "widget-intent", { action: "open", view, kind, id }).catch(() => undefined);
  };

  return (
    <div
      data-widget
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900/90 text-slate-100 backdrop-blur"
    >
      {/* 标题条：**这一条负责拖动**（无边框窗口靠 data-tauri-drag-region） */}
      <div
        data-tauri-drag-region
        data-widget-bar
        className="flex shrink-0 items-center gap-1.5 bg-slate-800/70 px-2.5 py-1 text-[10.5px] text-slate-400"
      >
        <span data-tauri-drag-region className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
        <span data-tauri-drag-region className="select-none">
          摩耶堂
        </span>
        <span data-tauri-drag-region className="ml-auto select-none tracking-widest text-slate-500">
          ⋮⋮
        </span>
        <button
          type="button"
          data-widget-close
          title="收起挂件（设置里的开关状态不变；想再叫出来用托盘菜单）"
          onClick={() => void widgetClose().catch(() => undefined)}
          className="ml-1 rounded px-1 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2.5">
        {/* ── 时钟（只有大号才显示） ── */}
        {has("clock") && (
          <div data-widget-slot="clock" data-widget-clock={now.getHours() * 60 + now.getMinutes()}>
            <p className="font-mono text-2xl leading-none">
              {`${now.getHours()}`.padStart(2, "0")}:{`${now.getMinutes()}`.padStart(2, "0")}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              {now.getMonth() + 1} 月 {now.getDate()} 日 ·{" "}
              {"日一二三四五六"[now.getDay()] === "日" ? "周日" : `周${"日一二三四五六"[now.getDay()]}`}
            </p>
          </div>
        )}

        {/* ── 格言 ── */}
        {has("motto") && (
          <div data-widget-slot="motto" data-widget-motto={motto ? motto.text : ""}>
            {motto ? (
              <>
                <p className="text-[12.5px] leading-relaxed text-indigo-200">「{motto.text}」</p>
                {motto.from && <p className="mt-0.5 text-[10px] text-slate-500">—— {motto.from}</p>}
              </>
            ) : (
              <p className="text-[11px] text-slate-500">技能区还没有格言（去写一条）</p>
            )}
          </div>
        )}

        {/* ── 专注中（**只读**；没在专注就不占地方） ── */}
        {focusing && (
          <div
            data-widget-slot="focus"
            data-widget-focus={focusing.title}
            className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2 py-1"
          >
            <p className="flex items-center gap-1.5 text-[10.5px] text-indigo-200">
              <span>🍅</span>
              <span className="truncate">{focusing.title}</span>
              <span className="ml-auto font-mono">{clockOf(focusing.remaining)}</span>
            </p>
            <p className="mt-0.5 text-[9.5px] text-indigo-300/70">
              {focusing.paused ? "已暂停" : "专注中"} · 要暂停/结束请点下方「打开执行区」
            </p>
          </div>
        )}

        {/* ── 今日待办 ── */}
        {has("todos") && (
          <div data-widget-slot="todos" className="min-h-0 flex-1">
            <p className="mb-1 flex items-center text-[10px] text-slate-500">
              <span>今天 · {todayTodos.length} 件</span>
              <button
                type="button"
                data-widget-open-todos
                onClick={() => openMain("todo", "", "")}
                className="ml-auto text-slate-500 hover:text-slate-300"
              >
                去执行区 ↗
              </button>
            </p>
            {todayTodos.length === 0 ? (
              <p className="text-[11px] text-slate-500">今天没有安排 —— 空着也好。</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {todayTodos.map((todo) => (
                  <li key={todo.id}>
                    <button
                      type="button"
                      data-widget-todo={todo.id}
                      onClick={() => openMain("todo", "todo", todo.id)}
                      className="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] hover:bg-slate-800"
                    >
                      <span className="text-slate-500">☐</span>
                      <span className="min-w-0 flex-1 truncate">{todo.title}</span>
                      {todo.quadrant === "q1" && <span className="text-[9.5px] text-amber-400">紧</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── 倒计时（2026-10-04）：只显示勾了「上挂件」的那些，按日期从近到远，最多 2 条 ──
             ⚠️ 天数**按日期现算**（`daysLeftOf`），不靠定时器 —— 挂件本来就每 20 秒重画一次，
             跨零点它会自己变成新的一天。 */}
        {has("countdown") && widgetCountdowns.length > 0 && (
          <div
            data-widget-slot="countdown"
            data-widget-countdown={widgetCountdowns[0].one.id}
            className="shrink-0 border-t border-slate-700/50 pt-1.5"
          >
            <p className="mb-0.5 text-[10px] text-slate-500">倒计时</p>
            <ul className="flex flex-col gap-0.5">
              {widgetCountdowns.map(({ one, days }) => (
                <li key={one.id}>
                  <button
                    type="button"
                    data-widget-countdown-item={one.id}
                    data-widget-countdown-days={days ?? ""}
                    title={`${one.title} · ${countdownText(days)}（点一下去日程看）`}
                    onClick={() => openMain("schedule", "", "")}
                    className="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-slate-800"
                  >
                    <span className="min-w-0 flex-1 truncate text-[11.5px]">{one.title}</span>
                    <span
                      className={`shrink-0 tabular-nums text-[12px] font-semibold ${
                        days === 0
                          ? "text-rose-400"
                          : days !== null && days < 0
                            ? "text-slate-500 font-normal"
                            : "text-amber-400"
                      }`}
                    >
                      {countdownShort(days)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── 番茄 / 信息（底栏） ── */}
        {(has("pomodoro") || has("info")) && (
          <div className="flex shrink-0 items-center gap-2 border-t border-slate-700/50 pt-1.5 text-[10px] text-slate-500">
            {has("pomodoro") && (
              <span data-widget-slot="pomodoro" data-widget-pomodoro={todayPom.count}>
                🍅 今天 {todayPom.count} 个
                {todayPom.seconds > 0 ? ` · ${Math.round(todayPom.seconds / 60)} 分钟` : ""}
              </span>
            )}
            {has("info") && (
              <span
                data-widget-slot="info"
                data-widget-info={todayInfo.count}
                className={todayInfo.pending > 0 ? "text-amber-400/80" : ""}
              >
                信息 {todayInfo.count}
                {todayInfo.pending > 0 ? `（${todayInfo.pending} 待联动）` : ""}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
