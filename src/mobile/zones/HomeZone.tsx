/**
 * 手机版 · 首页（M19.1 / v2.2.0）
 *
 * 照设计稿 `.spike\M18B-home.html`（用户已过目通过）：
 *   ① 三张卡：**今天**（数字 + 去日程）｜**提醒**（琥珀色）｜**最近待办**（能直接勾）
 *   ② 右下角「＋」快速记录 → 从底下弹出三个选择：随手记一条 / 加一个待办 / 新建笔记
 *   ③ 空态：一句"今天这里还是空的" + 指路
 *
 * ⚠️ 逻辑**全部复用电脑版**（`store/data.ts` 的 action、`features/schedule/aggregate` 的
 *    `dateKey`、后端 `info_create` / `todo_create` / `note_create`），手机版**不另写一套**。
 * ⚠️ 与电脑版首页的差别（设计稿里写明的）：
 *    - 手机版**不做**"临时收起卡片"的小叉叉（屏幕小，收起反而找不回来）；
 *    - 多了「＋」快速记录（抬手就记，不用先想属于哪个区）。
 */
import { useEffect, useState } from "react";

import { dateKey } from "../../features/schedule/aggregate";
import { infoCreate, todoCreate } from "../../features/api";
import { formatStamp } from "../../shared/daytime";
import { infoHeadline } from "../../shared/reminderText";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

/** 「＋」里那三个选择 */
const QUICK = [
  { key: "info", label: "随手记一条", desc: "先收进信息区，回头再整理", d: "M4 6h16v12H4zM7 10h10M7 14h6" },
  { key: "todo", label: "加一个待办", desc: "能顺手定个时间 / 提醒", d: "M4 6h10M4 12h10M4 18h6M17 14l2 2 3.5-3.5" },
  { key: "note", label: "新建笔记", desc: "进认知区，写长一点的东西", d: "M5 4h14v16H5zM8 9h8M8 13h8" },
] as const;

export default function HomeZone() {
  const setView = useUi((s) => s.setView);
  const todos = useData((s) => s.todos);
  const reminders = useData((s) => s.reminders);
  const config = useData((s) => s.config);
  const refresh = useData((s) => s.refresh);
  const setTodoDone = useData((s) => s.setTodoDone);
  const setFocusRef = useData((s) => s.setFocusRef);
  const linkToNote = useData((s) => s.linkToNote);
  const createNote = useData((s) => s.createNote);
  const toast = useUi((s) => s.toast);

  /** 「＋」面板：null = 关着；否则是选中的那一项 */
  const [quick, setQuick] = useState<null | { key: string; text: string }>(null);
  const [busy, setBusy] = useState(false);

  const liveReminders = reminders
    .filter((item) => item.status === "fired")
    .sort((a, b) => b.fireAt.localeCompare(a.fireAt))
    .slice(0, 3);

  const openTodos = todos.filter((todo) => todo.status === "open");

  /** 最近待办：按创建时间倒序（跟电脑版首页同一规则），手机上给 4 条 */
  const recentTodos = [...openTodos].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);

  /**
   * 🔴 今天有几件事（跟电脑版 `HomePage.tsx` 同一算法）：
   * "没完成" 且（今天设了时间 或 今天到期）。日期一律按**本地时区**算。
   */
  const todayKey = dateKey(new Date());
  const todayTodos = openTodos.filter(
    (todo) =>
      (todo.plannedAt && dateKey(todo.plannedAt) === todayKey) || (todo.dueAt && dateKey(todo.dueAt) === todayKey),
  );
  const todayCount = todayTodos.length;

  const showReminders = config.homeSticky.reminders && liveReminders.length > 0;
  const showTodos = config.homeSticky.recentTodos && recentTodos.length > 0;
  const isEmpty = !showReminders && !showTodos;

  /** 打开快速记录面板 */
  const openQuick = (key: string) => setQuick({ key, text: "" });

  /** 提交快速记录 */
  const submitQuick = async () => {
    if (!quick) return;
    const text = quick.text.trim();
    if (!text) {
      toast("先写点什么吧", "error");
      return;
    }
    setBusy(true);
    try {
      if (quick.key === "info") {
        await infoCreate(text);
        await refresh();
        toast("记下了，去信息区能看到", "success");
      } else if (quick.key === "todo") {
        await todoCreate(text);
        await refresh();
        toast("待办加好了，去执行区能看到", "success");
      } else {
        await createNote(text, "doc");
        toast("笔记建好了，去认知区能看到", "success");
      }
      setQuick(null);
    } catch (error) {
      toast("没记上：" + String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  // Esc 关掉面板（手机上少见，但外接键盘/调试时会用）
  useEffect(() => {
    if (!quick) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuick(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quick]);

  return (
    <div data-mobile-zone="home" className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {/* ① 今天 */}
        <button
          type="button"
          data-mhome-today
          data-mhome-today-count={todayCount}
          onClick={() => setView("schedule")}
          className="mb-2.5 w-full rounded-xl border border-slate-200 bg-white p-3 text-left dark:border-slate-800 dark:bg-slate-900"
        >
          <span className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">今天</span>
            <span className="text-[11px] text-indigo-500 dark:text-indigo-400">去日程 ›</span>
          </span>
          <span className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold leading-none">{todayCount}</span>
            <span className="text-[11px] text-slate-400">
              件待办
              {liveReminders.length > 0 ? ` · ${liveReminders.length} 个提醒` : ""}
            </span>
          </span>
        </button>

        {/* ② 提醒（琥珀色，跟电脑版一致） */}
        {showReminders && (
          <div
            data-mhome-reminder-card
            className="mb-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10"
          >
            <p className="mb-2 flex items-center justify-between text-[11px] text-amber-700 dark:text-amber-300">
              <span>提醒</span>
              <span>{liveReminders.length} 条</span>
            </p>
            <ul className="flex flex-col gap-2.5">
              {liveReminders.map((reminder) => {
                const isTodo = reminder.kind === "todo-remind";
                return (
                  <li key={reminder.id} data-mhome-reminder={reminder.kind} className="text-[12.5px] leading-snug">
                    <p className="text-amber-900 dark:text-amber-100">
                      {isTodo
                        ? `你设的提醒到点了：${reminder.payload.text}`
                        : `〔${reminder.payload.categoryText}〕这条还没推进下一步`}
                    </p>
                    {/* 2026-10-11 用户反馈第 1 条：这张卡原来只有上面那句**写死的话**，
                        信息正文一个字都看不到（认不出是哪条信息）→ 补上正文第一行，
                        跟电脑版首页同一条规矩；文案单一来源在 `shared/reminderText.ts`。 */}
                    {!isTodo && (
                      <p
                        data-mhome-reminder-text={reminder.refId}
                        className="mt-0.5 truncate text-amber-800/80 dark:text-amber-200/70"
                      >
                        {infoHeadline(reminder.payload.text)}
                      </p>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[10.5px] text-amber-700/70 dark:text-amber-300/60">
                        {formatStamp(reminder.fireAt)}
                      </span>
                      {isTodo ? (
                        <button
                          type="button"
                          data-mhome-reminder-go={reminder.refId}
                          onClick={() => {
                            setFocusRef({ kind: "todo", id: reminder.refId });
                            setView("todo");
                          }}
                          className="rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white"
                        >
                          去开始
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-mhome-reminder-link={reminder.refId}
                          onClick={() => void linkToNote(reminder.refId)}
                          className="rounded-md bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white"
                        >
                          联动到认知区
                        </button>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* ③ 最近待办（能直接勾 —— 手机版特有，电脑版是点进去再勾） */}
        {showTodos && (
          <div data-mhome-todo-card className="mb-2.5 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <p className="flex items-center justify-between px-3 pb-1 pt-3 text-[11px] text-slate-400">
              <span>最近待办</span>
              <button
                type="button"
                data-mhome-todo-all
                onClick={() => setView("todo")}
                className="text-[11px] text-indigo-500 dark:text-indigo-400"
              >
                全部 ›
              </button>
            </p>
            <ul>
              {recentTodos.map((todo, index) => (
                <li
                  key={todo.id}
                  data-mhome-todo={todo.id}
                  className={
                    "flex items-center gap-2.5 px-3 py-2.5 " +
                    (index < recentTodos.length - 1 ? "border-b border-slate-100 dark:border-slate-800" : "")
                  }
                >
                  <button
                    type="button"
                    data-mhome-check={todo.id}
                    aria-label="完成这条"
                    title="勾上 = 这条做完了"
                    onClick={() => void setTodoDone(todo.id, true)}
                    className="h-[15px] w-[15px] shrink-0 rounded border-[1.5px] border-slate-300 dark:border-slate-600"
                  />
                  <button
                    type="button"
                    data-mhome-todo-open={todo.id}
                    onClick={() => {
                      setFocusRef({ kind: "todo", id: todo.id });
                      setView("todo");
                    }}
                    className="min-w-0 flex-1 truncate text-left text-[13px]"
                  >
                    {todo.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ④ 空态 */}
        {isEmpty && (
          <div
            data-mhome-empty
            className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-[13px] leading-relaxed text-slate-400 dark:border-slate-700"
          >
            今天这里还是空的
            <br />
            <span className="text-[12px]">点右下角的 ＋ 就能记点东西</span>
          </div>
        )}
      </div>

      {/* 右下角「＋」快速记录（绝对定位在内容区之上，滚动列表不会带走它） */}
      <button
        type="button"
        data-mhome-fab
        aria-label="快速记录"
        title="快速记录"
        onClick={() => setQuick({ key: "", text: "" })}
        className="absolute bottom-4 right-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg active:bg-indigo-700"
      >
        <svg viewBox="0 0 24 24" style={{ width: 22, height: 22 }} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {/* 「＋」面板 */}
      {quick && (
        <div
          data-mhome-quick-sheet
          className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40"
          onClick={() => setQuick(null)}
        >
          <div
            className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="px-1 pb-2 text-sm font-bold">记点什么</p>

            {/* 第一步：选类型 */}
            {!quick.key && (
              <div className="flex flex-col gap-2">
                {QUICK.map((one) => (
                  <button
                    key={one.key}
                    type="button"
                    data-mhome-quick={one.key}
                    onClick={() => openQuick(one.key)}
                    className="flex items-center gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 text-left dark:border-slate-700"
                  >
                    <svg viewBox="0 0 24 24" style={{ width: 19, height: 19 }} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-indigo-500 dark:text-indigo-300">
                      <path d={one.d} />
                    </svg>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold">{one.label}</span>
                      <span className="block text-[10.5px] text-slate-400">{one.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* 第二步：写字 */}
            {quick.key && (
              <div>
                <p className="px-1 pb-1 text-[11px] text-slate-400">
                  {quick.key === "info" ? "随手记一条" : quick.key === "todo" ? "加一个待办" : "新建笔记（第一行当标题）"}
                </p>
                <textarea
                  data-mhome-quick-input
                  autoFocus
                  rows={3}
                  value={quick.text}
                  onChange={(event) => setQuick({ ...quick, text: event.target.value })}
                  placeholder={quick.key === "note" ? "写点什么…" : "写点什么…"}
                  className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-mhome-quick-save
                    disabled={busy}
                    onClick={() => void submitQuick()}
                    className="rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white disabled:opacity-60"
                  >
                    {busy ? "保存中…" : "记下"}
                  </button>
                  <button
                    type="button"
                    data-mhome-quick-back
                    onClick={() => setQuick({ key: "", text: "" })}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-[13px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  >
                    换个类型
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              data-mhome-quick-close
              onClick={() => setQuick(null)}
              className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
