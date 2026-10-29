/**
 * 日程区（M11-A 日历 / M11-B 一周七列）。
 *
 * 🔑 语义：**日历 = 过去；日程 = 现在与未来**。同一页两个视图，右上角切换：
 * - **月视图**（M11-A）：点某天 → 右边出那一天的日报（完成 / 设计 / 填写 + 未跟进）；
 * - **周视图**（M11-B）：一周七列并排、一眼看全，能在某一列**直接加一件事**、能**拖到另一列改日期**。
 *
 * ⚠️ 五条约定（改动前先读）：
 * 1. **日期一律按本地时区算**（`aggregate.ts::dateKey`）—— 后端存 UTC，`iso.slice(0,10)` 会错一天；
 * 2. 日报里的自动内容**实时算**，不另存快照（同一个事实只留一个来源）；
 * 3. **用户写的字一个字都不改**（导出 txt 时原样贴上），这是 V1 就立的规矩；
 * 4. 在日程页加的事**就是执行区那张待办**（`todo_create` + `plannedAt`），**不新开数据文件** ——
 *    所以"在这儿排完，回执行区立刻看得见"是天然的，不是同步出来的；
 * 5. **拖拽是手势**：落点必须用闭包里的局部变量记着（读 React state 会拿到旧值 → 拖拽白做，M4.1 踩过）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import PageShell from "../components/PageShell";
import { dailyExport, dailyGet, dailyNoteSet, inTauri } from "../features/api";
import {
  dateKey,
  dayAt,
  dayReport,
  durationText,
  hhmm,
  monthCounts,
  monthGrid,
  monthLabel,
  reportToText,
  shiftKey,
  weekBoard,
  weekLabel,
  weekStartKey,
  weekdayLabel,
} from "../features/schedule/aggregate";
import type { WeekItem } from "../features/schedule/aggregate";
import type { DailyReport, Todo } from "../features/types";
import {
  countdownShort,
  countdownText,
  daysLeftOf,
  localDayOf,
  sortByDate,
} from "../features/countdown/time";
import { useData } from "../store/data";
import { useUi } from "../store/ui";

/** 月历格子上的小色块（完成 / 设计 / 填写） */
function Pills({ done, planned, info }: { done: number; planned: number; info: number }) {
  if (done + planned + info === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {done > 0 && (
        <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
          完成 {done}
        </span>
      )}
      {planned > 0 && (
        <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
          设计 {planned}
        </span>
      )}
      {info > 0 && (
        <span className="rounded bg-sky-100 px-1 text-[10px] text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
          填写 {info}
        </span>
      )}
    </span>
  );
}

/** 日报里的一行（待办 / 信息共用） */
function ReportRow({
  children,
  detail,
  onClick,
}: {
  children: React.ReactNode;
  detail?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-sm">{children}</span>
      {detail && <span className="shrink-0 text-[11px] text-slate-400">{detail}</span>}
    </>
  );
  if (!onClick) {
    return <div className="flex items-baseline gap-2 py-1">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="点它跳回那一条"
      className="flex w-full items-baseline gap-2 rounded-lg px-1 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
    >
      {body}
    </button>
  );
}

export default function SchedulePage() {
  const todos = useData((state) => state.todos);
  const infos = useData((state) => state.infos);
  const notes = useData((state) => state.notes);
  const createTodo = useData((state) => state.createTodo);
  const setTodoPlanned = useData((state) => state.setTodoPlanned);
  const setFocusRef = useData((state) => state.setFocusRef);
  const setView = useUi((state) => state.setView);
  const toast = useUi((state) => state.toast);
  /** 倒计时（2026-10-04）：日程页读它 + 三个写动作 */
  const countdowns = useData((state) => state.countdowns);
  const createCountdown = useData((state) => state.createCountdown);
  const updateCountdown = useData((state) => state.updateCountdown);
  const deleteCountdown = useData((state) => state.deleteCountdown);

  const todayKey = dateKey(new Date());
  /** 月视图 / 周视图 */
  const [view, setView2] = useState<"month" | "week">("month");
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  /** 周视图的锚点（它所在那一周会被画出来） */
  const [weekAnchor, setWeekAnchor] = useState(todayKey);
  const [picked, setPicked] = useState(todayKey);
  /** 那一天**用户手写的部分**（自动那三类不在这里） */
  const [report, setReport] = useState<DailyReport | null>(null);
  /** 外部把数据整个换掉了（导入备份）→ +1 触发重拉 */
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 正在哪一列里"加一件事"（`YYYY-MM-DD`），以及正在打什么 */
  const [addingOn, setAddingOn] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  /** 拖拽状态（`draggingId` 是给界面用的，落点另存一份 ref 里） */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // 选中的那天变了 → 拉它的手写说明
  useEffect(() => {
    let alive = true;
    void dailyGet(picked)
      .then((one) => {
        if (alive) setReport(one);
      })
      .catch((error: unknown) => {
        if (alive) toast(`读这一天的日报失败：${String(error)}`, "error");
      });
    return () => {
      alive = false;
    };
  }, [picked, toast, reload]);

  /**
   * 外部把数据整个换掉了（**导入备份**）→ 手写说明也得重拉。
   *
   * ⚠️ 日报自己的写操作**不广播** `data-changed`（命令直接返回新对象、就地更新就够了），
   * 所以这条是给"整体替换数据"用的：不监听的话，导入完备份回到日程页
   * 还会显示**旧的那几句手写说明**。
   */
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen("data-changed", () => setReload((n) => n + 1))
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 日程页监听 data-changed 失败", error);
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const grid = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const counts = useMemo(
    () => monthCounts(cursor.year, cursor.month, todos, infos),
    [cursor, todos, infos],
  );
  const day = useMemo(() => dayReport(picked, todos, infos), [picked, todos, infos]);
  const board = useMemo(() => weekBoard(weekAnchor, todos), [weekAnchor, todos]);

  const noteOf = (key: string) => report?.notes.find((one) => one.key === key)?.text ?? "";

  /** 来源说明（"来自认知区《XX》"这种），导出 txt 与界面上都用它 */
  const sourceLabel = (todo: Todo) => {
    if (todo.source.kind === "note") {
      const note = notes.find((one) => one.id === todo.source.noteId);
      return note ? `来自认知区《${note.title}》` : "来自认知区（笔记已删除）";
    }
    if (todo.source.kind === "info") return "来自信息区";
    return "手动添加";
  };

  // ── 月视图：翻月 / 选日 ──
  const shiftMonth = (delta: number) => {
    setCursor((prev) => {
      const date = new Date(prev.year, prev.month - 1 + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() + 1 };
    });
  };

  const goToday = () => {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() + 1 });
    setPicked(dateKey(now));
    setWeekAnchor(dateKey(now));
  };

  const pickDay = (key: string, inMonth: boolean) => {
    setPicked(key);
    if (!inMonth) {
      const date = new Date(`${key}T00:00:00`);
      setCursor({ year: date.getFullYear(), month: date.getMonth() + 1 });
    }
  };

  // ── 周视图：翻周 / 加事 / 拖拽 ──
  const shiftWeek = (delta: number) => setWeekAnchor((prev) => shiftKey(weekStartKey(prev), delta * 7));

  /**
   * 在某一列加一件事 → **真的落成一条执行区的待办**（`plannedAt` = 那天的 09:00）。
   * ⚠️ 不新开数据文件：日程页读的就是待办本身，所以加完回执行区立刻就能看见。
   */
  const addOnDay = async (key: string) => {
    const title = addText.trim();
    if (!title) {
      setAddingOn(null);
      return;
    }
    const created = await createTodo(title, dayAt(key, 9, 0));
    if (created) {
      setAddText("");
      setAddingOn(null);
      toast(`已安排到 ${Number(key.split("-")[1])} 月 ${Number(key.split("-")[2])} 日 09:00`, "success");
    }
  };

  /** 拖到另一列 = 改日期（**时刻保留**；本来没有设定时间的，兜 09:00） */
  const moveToDay = async (todo: Todo, key: string) => {
    if (dateKey(todo.plannedAt ?? todo.dueAt ?? "") === key) return;
    const source = todo.plannedAt ? new Date(todo.plannedAt) : new Date(`${key}T09:00:00`);
    const target = new Date(`${key}T00:00:00`);
    target.setHours(source.getHours(), source.getMinutes(), 0, 0);
    const done = await setTodoPlanned(todo.id, target.toISOString());
    if (done !== false) {
      toast(`已挪到 ${Number(key.split("-")[1])} 月 ${Number(key.split("-")[2])} 日 ${hhmm(target.toISOString())}`, "success");
    }
  };

  /**
   * 周视图卡片上的拖拽（自己写指针逻辑，不用原生 DnD —— 原生 DnD 在 WebView 里不可靠）。
   * ⚠️ 落点用**闭包里的局部变量**记着，别读 React state：真实拖拽的 mouseup 紧跟着 mousemove，
   *    React 还没重渲染，state 里还是旧值 → 拖拽白做（M4.1 真踩过）。
   */
  const onItemPointerDown = (event: React.PointerEvent, item: WeekItem) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let landing: string | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        moved = true;
        setDraggingId(item.todo.id);
      }
      const host = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-week-day]");
      landing = host?.getAttribute("data-week-day") ?? null;
      setDragOverKey(landing);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDraggingId(null);
      setDragOverKey(null);
      if (moved && landing) void moveToDay(item.todo, landing);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 存一句说明（空 = 删掉这条）。没改动就不写盘 */
  const saveNote = async (key: string, text: string) => {
    if (text.trim() === noteOf(key).trim()) return;
    try {
      setReport(await dailyNoteSet(picked, key, text));
    } catch (error) {
      toast(`保存说明失败：${String(error)}`, "error");
    }
  };

  /**
   * 导出这一天为 txt。
   *
   * `dest` 给了就直接写那儿（**验收脚本用的钩子**走这条路），
   * 没给就弹系统文件对话框让用户挑 —— 两步之后的落盘是**同一条代码路径**。
   * ⚠️ 为什么要留这个口子：系统文件对话框没法自动点，而"拼正文 → 落盘"这段必须能自动验
   * （和 `features/useFileDrop.ts` 里那个 `dsh:file-drop` 钩子同一个理由）。
   */
  const runExport = async (dest?: string): Promise<string | null> => {
    setBusy(true);
    try {
      // 正文由这里拼：三类自动内容 + 用户手写的那几句（原样贴，一个字都不改）
      const text = reportToText(day, report?.notes ?? [], sourceLabel);
      let target = dest;
      if (!target) {
        const pickedPath = await saveDialog({
          title: "导出这一天的日报",
          defaultPath: `${picked}-日报.txt`,
          filters: [{ name: "纯文本", extensions: ["txt"] }],
        });
        if (!pickedPath) return null; // 用户取消了
        target = pickedPath;
      }
      const written = await dailyExport(picked, text, target);
      toast(`日报已导出到 ${written}`, "success");
      return written;
    } catch (error) {
      toast(`导出失败：${String(error)}`, "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  // 验收脚本的钩子：`window.dispatchEvent(new CustomEvent("dsh:daily-export", { detail: { dest } }))`
  // ⚠️ 回调放 ref：这样订阅只做一次，而事件里拿到的永远是最新的那个 `runExport`
  const exportRef = useRef(runExport);
  exportRef.current = runExport;
  useEffect(() => {
    const onExport = (event: Event) => {
      const dest = (event as CustomEvent<{ dest?: string }>).detail?.dest;
      void exportRef.current(dest);
    };
    window.addEventListener("dsh:daily-export", onExport);
    return () => window.removeEventListener("dsh:daily-export", onExport);
  }, []);

  const jumpTodo = (todo: Todo) => {
    setFocusRef({ kind: "todo", id: todo.id });
    setView("todo");
  };
  /** 从「专注」明细跳回那条待办（那边只存着 id，不一定还找得到） */
  const jumpTodoId = (id: string) => {
    const found = todos.find((one) => one.id === id);
    if (found) jumpTodo(found);
    else {
      setFocusRef({ kind: "todo", id });
      setView("todo");
    }
  };
  const jumpInfo = (id: string) => {
    setFocusRef({ kind: "info", id });
    setView("info");
  };

  const nothingAtAll =
    day.done.length + day.planned.length + day.infos.length + day.unfollowed.length === 0;
  const [, m, d] = picked.split("-");

  // ───────────────────────── 倒计时（2026-10-04） ─────────────────────────
  /** 「＋ 倒计时」的小表单（`null` = 没在加）；日期默认 = 月视图里选中的那天 */
  const [countdownForm, setCountdownForm] = useState<{ title: string; date: string } | null>(null);
  /** 点开了哪一条倒计时的小菜单（改/删） */
  const [countdownMenuFor, setCountdownMenuFor] = useState<string | null>(null);
  const [countdownEdit, setCountdownEdit] = useState<{ id: string; title: string; date: string } | null>(
    null,
  );

  const submitCountdown = async () => {
    const form = countdownForm;
    if (!form) return;
    const title = form.title.trim();
    if (!title) return;
    const created = await createCountdown(title, form.date.trim());
    if (created) {
      setCountdownForm(null);
      // 跳到目标日那一月，让用户当场看见它挂上去了
      const parsed = localDayOf(created.date);
      if (parsed) setCursor({ year: parsed.getFullYear(), month: parsed.getMonth() + 1 });
      toast(`加好了：距离「${created.title}」${countdownText(daysLeftOf(created.date))}`, "success");
    }
  };

  /** 这一天挂着哪几条倒计时（按日期从近到远；同一天可能有好几个） */
  const countdownsOn = (key: string) =>
    sortByDate(countdowns.filter((one) => one.date === key)).map((one) => ({
      one,
      days: daysLeftOf(one.date),
    }));

  // ───────────────────────── 月视图 ─────────────────────────
  const renderMonth = () => (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          data-cal-month={`${cursor.year}-${`${cursor.month}`.padStart(2, "0")}`}
          className="text-sm font-semibold"
        >
          {monthLabel(cursor.year, cursor.month)}
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-cal-prev
            onClick={() => shiftMonth(-1)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ‹ 上月
          </button>
          <button
            type="button"
            data-cal-today
            onClick={goToday}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            今天
          </button>
          <button
            type="button"
            data-cal-next
            onClick={() => shiftMonth(1)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            下月 ›
          </button>
          {/* 2026-10-04（倒计时）：开口就放在月视图里（用户原话"就放月视图里设置好了"）。
              点它 → 就地弹出小表单，日期默认 = 当前选中的那天。 */}
          <button
            type="button"
            data-cal-countdown-add
            title="给某一天加个倒计时（默认用你现在选中的那天）"
            onClick={() => {
              setCountdownForm({ title: "", date: picked });
            }}
            className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
          >
            ＋ 倒计时
          </button>
        </div>
      </div>

      {/* 就地加倒计时的小表单（不跳页、不弹窗） */}
      {countdownForm && (
        <div
          data-cal-countdown-form
          className="mb-3 rounded-xl border border-amber-300 bg-amber-50/60 p-2.5 dark:border-amber-500/40 dark:bg-amber-500/10"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              autoFocus
              data-cal-countdown-title
              value={countdownForm.title}
              onChange={(event) =>
                setCountdownForm({ ...countdownForm, title: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitCountdown();
                }
                if (event.key === "Escape") setCountdownForm(null);
              }}
              placeholder="写一件事…（期末考 / 妈妈生日）"
              className="min-w-40 flex-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs outline-none dark:border-amber-500/40 dark:bg-slate-900 dark:text-slate-100"
            />
            <input
              data-cal-countdown-date
              value={countdownForm.date}
              onChange={(event) => setCountdownForm({ ...countdownForm, date: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitCountdown();
                }
                if (event.key === "Escape") setCountdownForm(null);
              }}
              placeholder="2026-11-20"
              className="w-32 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs outline-none dark:border-amber-500/40 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              data-cal-countdown-save
              onClick={() => void submitCountdown()}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
            >
              加
            </button>
            <button
              type="button"
              data-cal-countdown-cancel
              onClick={() => setCountdownForm(null)}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              算了
            </button>
          </div>
          <p className="mt-1.5 px-0.5 text-[11px] text-amber-700/80 dark:text-amber-300/70">
            日期默认是你在月视图里选中的那天（{picked}）；写「期末考」回车就加。
          </p>
        </div>
      )}

      <div data-schedule-grid className="grid grid-cols-7 gap-1.5">
        {["一", "二", "三", "四", "五", "六", "日"].map((label) => (
          <div key={label} className="pb-1 text-center text-[11px] text-slate-400">
            {label}
          </div>
        ))}
        {grid.map((cell) => {
          const count = counts[cell.key] ?? { done: 0, planned: 0, info: 0, trouble: 0, voided: 0 };
          const isToday = cell.key === todayKey;
          const isPicked = cell.key === picked;
          return (
            <button
              key={cell.key}
              type="button"
              data-cal-day={cell.key}
              data-cal-in-month={cell.inMonth ? "1" : "0"}
              data-cal-done={count.done}
              data-cal-planned={count.planned}
              data-cal-info={count.info}
              onClick={() => pickDay(cell.key, cell.inMonth)}
              className={`flex min-h-[62px] flex-col rounded-xl border px-2 py-1.5 text-left transition-colors ${
                isPicked
                  ? "border-indigo-400 ring-1 ring-indigo-300 dark:border-indigo-500"
                  : isToday
                    ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/60 dark:bg-indigo-500/10"
                    : "border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700"
              } ${cell.inMonth ? "" : "opacity-40"}`}
            >
              <span
                className={`text-xs ${
                  isToday ? "font-semibold text-indigo-600 dark:text-indigo-300" : ""
                }`}
              >
                {cell.day}
                {isToday && <span className="ml-1 text-[10px]">今天</span>}
              </span>
              <Pills done={count.done} planned={count.planned} info={count.info} />
              {/* 2026-10-04（倒计时）：**挂在它自己的那一天上**（不是在"今天"那格）——
                  琥珀色小标签，同一天有多条时只显示第一条 + `＋N`。
                  ⚠️ 点标签是"改/删那一条"，所以它自己是个按钮，`stopPropagation` 别让外层选日。 */}
              {(() => {
                const mine = countdownsOn(cell.key);
                if (mine.length === 0) return null;
                const first = mine[0];
                return (
                  <button
                    type="button"
                    data-cal-countdown={first.one.id}
                    data-cal-countdown-days={first.days ?? ""}
                    title={`${first.one.title} · ${countdownText(first.days)}${first.one.note ? `（${first.one.note}）` : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCountdownMenuFor(countdownMenuFor === first.one.id ? null : first.one.id);
                    }}
                    className={`mt-0.5 flex items-center gap-1 truncate rounded-md border px-1 py-0.5 text-left text-[10px] leading-4 ${
                      first.days === 0
                        ? "border-rose-400 bg-rose-50 text-rose-600 dark:border-rose-500/50 dark:bg-rose-500/15 dark:text-rose-300"
                        : first.days !== null && first.days < 0
                          ? "border-slate-300 bg-slate-50 text-slate-400 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-500"
                          : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                    }`}
                  >
                    <span className="truncate">{first.one.title}</span>
                    <span className="ml-auto shrink-0 tabular-nums">{countdownShort(first.days)}</span>
                    {mine.length > 1 && <span className="shrink-0">＋{mine.length - 1}</span>}
                  </button>
                );
              })()}
              {/* M13-B：这天有番茄被打断过 / 作废过 → 一个小黄点（不打扰，但翻得到） */}
              {count.trouble > 0 && (
                <span
                  data-cal-trouble={count.trouble}
                  data-cal-voided={count.voided}
                  title={`这天有 ${count.trouble} 次专注被打断${count.voided > 0 ? `，其中作废 ${count.voided} 次` : ""}`}
                  className="mt-auto text-[10px] leading-none text-amber-500"
                >
                  ●
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-400">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-400" />
          完成了
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-indigo-400" />
          设计了
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-sky-400" />
          填写了
        </span>
        {/* 2026-10-04（倒计时）：图例里加一项，让人知道琥珀色小标签是什么 */}
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />
          倒计时
        </span>
        <span className="text-slate-400">· 空的日子点进去就是「这天什么都没记」</span>
      </div>

      {/* 点倒计时标签弹出的小菜单：改标题 / 改日期 / 从挂件上拿掉 / 删掉。
          就地在月视图里办完（用户要求"就在月视图里设置"，不跳设置页）。 */}
      {countdownMenuFor && (
        <div
          data-cal-countdown-menu={countdownMenuFor}
          className="mt-3 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900"
        >
          {(() => {
            const one = countdowns.find((item) => item.id === countdownMenuFor);
            if (!one) return null;
            return (
              <div className="flex flex-col gap-2">
                <p className="px-0.5 text-xs text-slate-500 dark:text-slate-300">
                  {one.title} · {countdownText(daysLeftOf(one.date))}（{one.date}）
                  {!one.onWidget && " · 没在挂件上"}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    data-cal-countdown-edit-title
                    value={countdownEdit?.id === one.id ? countdownEdit.title : one.title}
                    onChange={(event) =>
                      setCountdownEdit({
                        id: one.id,
                        title: event.target.value,
                        date: countdownEdit?.id === one.id ? countdownEdit.date : one.date,
                      })
                    }
                    className="min-w-32 flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <input
                    data-cal-countdown-edit-date
                    value={countdownEdit?.id === one.id ? countdownEdit.date : one.date}
                    onChange={(event) =>
                      setCountdownEdit({
                        id: one.id,
                        title: countdownEdit?.id === one.id ? countdownEdit.title : one.title,
                        date: event.target.value,
                      })
                    }
                    className="w-32 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    data-cal-countdown-edit-save
                    onClick={() => {
                      const draft = countdownEdit?.id === one.id ? countdownEdit : null;
                      if (!draft) {
                        setCountdownMenuFor(null);
                        return;
                      }
                      void updateCountdown(one.id, { title: draft.title, date: draft.date }).then(
                        (ok) => {
                          if (ok) {
                            setCountdownMenuFor(null);
                            setCountdownEdit(null);
                            toast("改好了", "success");
                          }
                        },
                      );
                    }}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    存
                  </button>
                  <button
                    type="button"
                    data-cal-countdown-widget-toggle={one.onWidget ? "on" : "off"}
                    onClick={() => void updateCountdown(one.id, { onWidget: !one.onWidget })}
                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {one.onWidget ? "从挂件上拿掉" : "放到挂件上"}
                  </button>
                  <button
                    type="button"
                    data-cal-countdown-delete
                    onClick={() => {
                      void deleteCountdown(one.id).then((ok) => {
                        if (ok) {
                          setCountdownMenuFor(null);
                          setCountdownEdit(null);
                          toast("删掉了（留档在 backups/）", "success");
                        }
                      });
                    }}
                    className="rounded-lg border border-rose-300 px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
                  >
                    删掉
                  </button>
                  <button
                    type="button"
                    data-cal-countdown-close
                    onClick={() => {
                      setCountdownMenuFor(null);
                      setCountdownEdit(null);
                    }}
                    className="rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    收起
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );

  // ───────────────────────── 周视图（M11-B） ─────────────────────────
  const weekSum = (() => {
    const seen = new Map<string, WeekItem>();
    board.forEach((one) => one.items.forEach((item) => seen.set(item.todo.id, item)));
    const all = [...seen.values()];
    return {
      total: all.length,
      done: all.filter((item) => item.todo.status === "done").length,
      overdue: all.filter((item) => item.overdue).length,
    };
  })();

  const renderWeek = () => (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 data-week-label={weekStartKey(weekAnchor)} className="text-sm font-semibold">
          {weekLabel(weekStartKey(weekAnchor))}
          {weekStartKey(weekAnchor) === weekStartKey(todayKey) && (
            <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
              本周
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-week-prev
            onClick={() => shiftWeek(-1)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ‹ 上一周
          </button>
          <button
            type="button"
            data-week-this
            onClick={() => setWeekAnchor(todayKey)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            本周
          </button>
          <button
            type="button"
            data-week-next
            onClick={() => shiftWeek(1)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            下一周 ›
          </button>
        </div>
      </div>

      <div data-week-board={weekStartKey(weekAnchor)} className="grid grid-cols-7 gap-1.5">
        {board.map((one) => {
          const isToday = one.key === todayKey;
          const isPicked = one.key === picked;
          return (
            <div
              key={one.key}
              data-week-day={one.key}
              data-week-count={one.items.length}
              className={`flex min-h-[300px] flex-col rounded-xl border p-1.5 ${
                dragOverKey === one.key
                  ? "border-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/10"
                  : isPicked
                    ? "border-indigo-400 dark:border-indigo-500"
                    : isToday
                      ? "border-indigo-300 bg-indigo-50/50 dark:border-indigo-500/60 dark:bg-indigo-500/10"
                      : "border-slate-200 dark:border-slate-800"
              }`}
            >
              <button
                type="button"
                data-week-head={one.key}
                title="看这一天的日报"
                onClick={() => setPicked(one.key)}
                className="mb-1.5 flex items-baseline gap-1 border-b border-slate-100 pb-1.5 text-left dark:border-slate-800"
              >
                <span className={`text-xs font-semibold ${isToday ? "text-indigo-600 dark:text-indigo-300" : ""}`}>
                  {Number(one.key.split("-")[2])}
                </span>
                <span className="text-[10px] text-slate-400">
                  {isToday ? "今天" : weekdayLabel(one.key)}
                </span>
                <span className="ml-auto text-[10px] text-slate-400">
                  {one.items.length > 0 ? `${one.items.length} 件` : "—"}
                </span>
              </button>

              {one.items.map((item) => (
                <button
                  key={`${item.todo.id}-${one.key}`}
                  type="button"
                  data-week-item={item.todo.id}
                  data-week-item-day={one.key}
                  data-week-item-done={item.todo.status === "done" ? "1" : "0"}
                  data-week-item-overdue={item.overdue ? "1" : "0"}
                  title={`${item.todo.title}\n（拖到别的列 = 改日期；点一下 = 去执行区）`}
                  onPointerDown={(event) => onItemPointerDown(event, item)}
                  onClick={() => {
                    // 拖过就不算点击（拖拽结束时 click 也会来一次）
                    if (!draggingId) jumpTodo(item.todo);
                  }}
                  className={`mb-1 w-full rounded-lg border-l-[3px] px-1.5 py-1 text-left ${
                    draggingId === item.todo.id ? "opacity-40" : ""
                  } ${
                    item.todo.status === "done"
                      ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10"
                      : item.overdue
                        ? "border-amber-500 bg-amber-50 dark:bg-amber-500/10"
                        : item.planned
                          ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10"
                          : "border-dashed border-amber-400 bg-amber-50/50 dark:bg-amber-500/5"
                  }`}
                >
                  <span
                    className={`block font-mono text-[10px] ${
                      item.todo.status === "done"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : item.overdue
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-indigo-600 dark:text-indigo-400"
                    }`}
                  >
                    {item.planned
                      ? hhmm(item.todo.plannedAt ?? "")
                      : item.todo.dueAt
                        ? `截止 ${hhmm(item.todo.dueAt)}`
                        : ""}
                  </span>
                  <span
                    className={`line-clamp-2 block text-[11.5px] leading-snug ${
                      item.todo.status === "done" ? "text-slate-400 line-through" : ""
                    }`}
                  >
                    {item.todo.title}
                  </span>
                </button>
              ))}

              {addingOn === one.key ? (
                <input
                  autoFocus
                  data-week-add-input={one.key}
                  value={addText}
                  placeholder="回车就安排上…"
                  onChange={(event) => setAddText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void addOnDay(one.key);
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setAddText("");
                      setAddingOn(null);
                    }
                  }}
                  onBlur={() => void addOnDay(one.key)}
                  className="mt-auto w-full rounded-lg border border-indigo-300 bg-white px-1.5 py-0.5 text-[11px] outline-none dark:border-indigo-500 dark:bg-slate-800 dark:text-slate-100"
                />
              ) : (
                <button
                  type="button"
                  data-week-add={one.key}
                  title="在这天安排一件事（会直接在执行区出现）"
                  onClick={() => {
                    setAddText("");
                    setAddingOn(one.key);
                  }}
                  className="mt-auto rounded-lg border border-dashed border-slate-300 py-0.5 text-[11px] text-slate-400 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700"
                >
                  ＋ 安排
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-slate-400">
        <span>
          这一周：<b className="text-slate-600 dark:text-slate-300">{weekSum.total} 件</b>
        </span>
        <span>
          已完成 <b className="text-emerald-600 dark:text-emerald-400">{weekSum.done}</b>
        </span>
        <span>
          逾期 <b className="text-amber-600 dark:text-amber-400">{weekSum.overdue}</b>
        </span>
        <span className="ml-auto">在某一列「＋ 安排」= 直接加进执行区；把卡片拖到另一列 = 改日期</span>
      </div>
    </div>
  );

  // ───────────────────────── 那一天的日报（两个视图共用） ─────────────────────────
  const renderPanel = (wide: boolean) => (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 data-day-title className="text-sm font-semibold">
            {Number(m)} 月 {Number(d)} 日 · {weekdayLabel(picked)}
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {picked === todayKey ? "今天 · 自动生成，不用你填" : "自动生成，不用你填"}
          </p>
        </div>
        <button
          type="button"
          data-day-export
          disabled={busy}
          onClick={() => void runExport()}
          className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          导出这天为 txt
        </button>
      </div>

      {nothingAtAll ? (
        <p data-day-empty className="py-6 text-center text-sm text-slate-400">
          这天什么都没记 —— 空白也是记录
        </p>
      ) : null}

      <div className={wide ? "grid gap-x-6 gap-y-3 lg:grid-cols-2" : ""}>
        {/* 完成了 */}
        <section>
          <h3
            data-day-done={day.done.length}
            className="mb-1 text-xs text-emerald-600 dark:text-emerald-400"
          >
            ✅ 完成了 {day.done.length} 件
          </h3>
          {day.done.length === 0 && <p className="text-[11px] text-slate-400">这天没有完成的待办</p>}
          {day.done.map((todo) => (
            <ReportRow key={todo.id} detail={hhmm(todo.doneAt ?? "")} onClick={() => jumpTodo(todo)}>
              <span className="text-emerald-600 dark:text-emerald-400">☑ </span>
              {todo.title}
            </ReportRow>
          ))}
        </section>

        {/* 设计了 */}
        <section>
          <h3 data-day-planned={day.planned.length} className="mb-1 text-xs text-indigo-600 dark:text-indigo-400">
            🗓 设计了 {day.planned.length} 件
          </h3>
          {day.planned.length === 0 && <p className="text-[11px] text-slate-400">这天没有安排待办</p>}
          {day.planned.map((todo) => (
            <ReportRow key={todo.id} detail={hhmm(todo.plannedAt ?? "")} onClick={() => jumpTodo(todo)}>
              <span className={todo.status === "done" ? "text-slate-400" : ""}>
                {todo.status === "done" ? "☑ " : "☐ "}
              </span>
              {todo.title}
            </ReportRow>
          ))}
        </section>

        {/* 填写了 */}
        <section>
          <h3 data-day-info={day.infos.length} className="mb-1 text-xs text-sky-600 dark:text-sky-400">
            📥 填写了 {day.infos.length} 条信息
          </h3>
          {day.infos.length === 0 && <p className="text-[11px] text-slate-400">这天没往信息区丢东西</p>}
          {day.infos.map((info) => (
            <ReportRow key={info.id} detail={hhmm(info.createdAt)} onClick={() => jumpInfo(info.id)}>
              {(info.text || "").trim().slice(0, 30) || "（图片信息）"}
            </ReportRow>
          ))}
        </section>

        {/* 专注（M13-B：番茄 + 疑似离开 + 作废 —— 作废也要留痕，用户 2026-09-26 定） */}
        <section>
          <h3
            data-day-focus={day.focus.count}
            data-day-focus-seconds={day.focus.effectiveSeconds}
            data-day-focus-interrupted={day.focus.interruptedSeconds}
            data-day-focus-voided={day.focus.voidedCount}
            className="mb-1 text-xs text-rose-600 dark:text-rose-400"
          >
            🍅 专注 {day.focus.count} 个番茄 · 有效 {durationText(day.focus.effectiveSeconds)}
          </h3>
          {day.focus.count === 0 && <p className="text-[11px] text-slate-400">这天没开番茄钟</p>}
          {day.focus.count > 0 && (day.focus.interruptedSeconds > 0 || day.focus.voidedCount > 0) && (
            <p data-day-focus-trouble className="mb-1 text-[11px] text-amber-600 dark:text-amber-400">
              其中疑似离开 {durationText(day.focus.interruptedSeconds)} · 作废 {day.focus.voidedCount} 次
            </p>
          )}
          {day.focus.entries.map((one) => (
            <ReportRow
              key={`${one.todoId}-${one.at}`}
              detail={[
                hhmm(one.at),
                one.voided ? "作废" : "计入",
                one.interruptedSeconds > 0 ? `离开 ${durationText(one.interruptedSeconds)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              onClick={() => jumpTodoId(one.todoId)}            >
              <span className={one.voided ? "text-amber-600 dark:text-amber-400" : ""}>
                {one.voided ? "✗ " : "🍅 "}
              </span>
              {one.title}
            </ReportRow>
          ))}
        </section>

        {/* 未跟进（唯一需要他写字的地方） */}
        <section className="border-t border-slate-100 pt-3 lg:border-t-0 lg:pt-0 dark:border-slate-800">
          <h3
            data-day-unfollowed={day.unfollowed.length}
            className="mb-1 text-xs text-amber-600 dark:text-amber-400"
          >
            ⚠ 未跟进 {day.unfollowed.length} 件
          </h3>
          {day.unfollowed.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              {picked === todayKey ? "今天该做的到目前为止都跟上了" : "这天该做的都做完了"}
            </p>
          ) : (
            day.unfollowed.map((todo) => (
              <div
                key={todo.id}
                data-day-unfollowed-item={todo.id}
                className="mb-2 rounded-xl border border-slate-200 p-2 dark:border-slate-800"
              >
                <ReportRow
                  detail={
                    todo.plannedAt
                      ? `设定 ${hhmm(todo.plannedAt)}`
                      : todo.dueAt
                        ? `截止 ${hhmm(todo.dueAt)}`
                        : ""
                  }
                  onClick={() => jumpTodo(todo)}
                >
                  ☐ {todo.title}
                </ReportRow>
                <textarea
                  // ⚠️ 非受控 + `key` 带上日期：换一天就重挂载，但**正在打的字永远不会被回填搅乱**
                  //    （M4.1 的教训："程序别在用户打字时把内容塞回输入框"）
                  key={`${picked}#todo:${todo.id}`}
                  data-day-note={`todo:${todo.id}`}
                  defaultValue={noteOf(`todo:${todo.id}`)}
                  rows={1}
                  placeholder="写一句为什么没跟进…（回车保存）"
                  onBlur={(event) => void saveNote(`todo:${todo.id}`, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void saveNote(`todo:${todo.id}`, event.currentTarget.value);
                    }
                  }}
                  className="mt-1 w-full resize-y rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
                />
              </div>
            ))
          )}
        </section>
      </div>

      {/* 当天小结 */}
      <section className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <h3 className="mb-1 text-xs text-slate-500 dark:text-slate-400">📝 当天小结</h3>
        <textarea
          key={`${picked}#day`}
          data-day-note="day"
          defaultValue={noteOf("day")}
          rows={2}
          placeholder="想记一句就记一句（回车保存，Shift+回车换行）"
          onBlur={(event) => void saveNote("day", event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void saveNote("day", event.currentTarget.value);
            }
          }}
          className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
        />
      </section>

      <p className="border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-400 dark:border-slate-800">
        上面三类是<b>自动汇总</b>的，只有「未跟进」那一句要你自己写；写下的字存在{" "}
        <span className="font-mono">dailies/{picked}.json</span>，<b>只留最近一年</b>。
      </p>
    </div>
  );

  return (
    <PageShell
      title="日程"
      subtitle="日历看过去、日程看现在与未来：某天完成了什么、设计过什么、接下来几天有什么事"
      badge="M11-A/B · 日历 + 一周七列"
    >
      <div className="flex min-h-full flex-col gap-4">
        {/* 视图切换（月视图 = 过去 / 周视图 = 现在与未来） */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-schedule-view="month"
            onClick={() => setView2("month")}
            className={`rounded-lg px-3 py-1 text-xs ${
              view === "month"
                ? "bg-indigo-600 text-white"
                : "border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            月视图（日历）
          </button>
          <button
            type="button"
            data-schedule-view="week"
            onClick={() => setView2("week")}
            className={`rounded-lg px-3 py-1 text-xs ${
              view === "week"
                ? "bg-indigo-600 text-white"
                : "border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            周视图（一周七列）
          </button>
        </div>

        {view === "month" ? (
          <div className="flex min-h-0 flex-1 gap-6">
            <div className="min-w-0 flex-1">{renderMonth()}</div>
            <aside data-day-panel={picked} className="w-[348px] shrink-0">
              {renderPanel(false)}
            </aside>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-6">
            {renderWeek()}
            <div data-day-panel={picked}>{renderPanel(true)}</div>
          </div>
        )}
      </div>
    </PageShell>
  );
}
