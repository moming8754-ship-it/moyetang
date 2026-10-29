/**
 * 手机版 · 日程（M19.5 / v2.6.0）
 *
 * 照设计稿 `.spike\M18D-rest-zones.html`（日程三格）+ `M18E-v2-supplement.html`（月视图 + 倒计时）：
 *   ① 今天：今日时间轴（按 `plannedAt` 排）+ 今天要做的
 *   ② 一周：**横滑 7 天**（电脑版是一整月大格子，小屏看不清）→ 点某天看那天的日报
 *   ③ 月：7 列网格 + **倒计时挂在"目标日"那格**（琥珀小标签）+ 「＋ 倒计时」**就地填**（不跳页、不弹窗）
 *   ④ 日报的**手写部分**：每条没跟进的写一句"为什么"，外加"当天小结"（`dailyNoteSet`）
 *
 * ⚠️ 逻辑复用电脑版：`dateKey`（本地时区）、`daysLeftOf` / `countdownText` / `countdownShort`、
 *    `dailyGet` / `dailyNoteSet`、`createCountdown` / `deleteCountdown`、`todoCreate`。
 * ⚠️ 「完成了什么」是**从待办算出来的**，只有手写那部分才存文件（跟电脑版同一个事实来源）。
 */
import { useEffect, useMemo, useState } from "react";

import { dailyGet, dailyNoteSet } from "../../features/api";
import { countdownShort, countdownText, daysLeftOf } from "../../features/countdown/time";
import { dateKey } from "../../features/schedule/aggregate";
import type { Countdown, DailyReport } from "../../features/types";
import { formatStamp } from "../../shared/daytime";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

/** 本地日期 → `YYYY-MM-DD`（**不用 toISOString**，那是 UTC） */
function keyOf(date: Date): string {
  return dateKey(date);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

const WEEK_LABEL = ["日", "一", "二", "三", "四", "五", "六"];

export default function ScheduleZone() {
  const todos = useData((s) => s.todos);
  const countdowns = useData((s) => s.countdowns);
  const refreshAll = useData((s) => s.refresh);
  const createCountdown = useData((s) => s.createCountdown);
  const deleteCountdown = useData((s) => s.deleteCountdown);
  const toast = useUi((s) => s.toast);

  const [tab, setTab] = useState<"today" | "week" | "month">("today");
  const [selected, setSelected] = useState<string>(keyOf(new Date()));
  const [cursor, setCursor] = useState<Date>(new Date());
  const [report, setReport] = useState<DailyReport | null>(null);
  const [why, setWhy] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState("");
  const [cdOpen, setCdOpen] = useState(false);
  const [cdTitle, setCdTitle] = useState("");
  const [cdDate, setCdDate] = useState("");
  const [cdDel, setCdDel] = useState<Countdown | null>(null);

  const todayKey = keyOf(new Date());

  /** 一周 7 天（从今天往后排，跟设计稿"横滑 7 天"一致） */
  const week = useMemo(() => {
    const base = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const day = addDays(base, index);
      return { key: keyOf(day), label: WEEK_LABEL[day.getDay()], day: day.getDate(), isToday: keyOf(day) === todayKey };
    });
  }, [todayKey]);

  /** 某天要做的（设了那天的时间 或 那天到期） */
  const todosOf = (dayKey: string) =>
    todos.filter(
      (one) =>
        one.status === "open" &&
        ((one.plannedAt && dateKey(one.plannedAt) === dayKey) || (one.dueAt && dateKey(one.dueAt) === dayKey)),
    );

  const timeline = useMemo(
    () =>
      todos
        .filter((one) => one.status === "open" && one.plannedAt && dateKey(one.plannedAt) === todayKey)
        .sort((a, b) => (a.plannedAt ?? "").localeCompare(b.plannedAt ?? "")),
    [todos, todayKey],
  );

  /** 打开某天的日报（手写部分） */
  useEffect(() => {
    let alive = true;
    void dailyGet(selected)
      .then((one) => {
        if (!alive) return;
        setReport(one);
        const map: Record<string, string> = {};
        let day = "";
        for (const note of one.notes ?? []) {
          if (note.key === "day") day = note.text;
          else if (note.key.startsWith("todo:")) map[note.key.slice(5)] = note.text;
        }
        setWhy(map);
        setSummary(day);
      })
      .catch(() => setReport(null));
    return () => {
      alive = false;
    };
  }, [selected]);

  /** 月视图：当前 cursor 所在月 */
  const month = useMemo(() => {
    const year = cursor.getFullYear();
    const monthIndex = cursor.getMonth();
    const first = new Date(year, monthIndex, 1);
    const days: { key: string; day: number; inMonth: boolean }[] = [];
    // 补齐到周一开头
    const lead = (first.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) {
      const d = addDays(first, i - lead);
      days.push({ key: keyOf(d), day: d.getDate(), inMonth: false });
    }
    const total = new Date(year, monthIndex + 1, 0).getDate();
    for (let i = 1; i <= total; i++) {
      const d = new Date(year, monthIndex, i);
      days.push({ key: keyOf(d), day: i, inMonth: true });
    }
    while (days.length % 7 !== 0) {
      const d = addDays(new Date(year, monthIndex, total), days.length - lead - total + 1);
      days.push({ key: keyOf(d), day: d.getDate(), inMonth: false });
    }
    return { year, monthIndex, days };
  }, [cursor]);

  const countdownsOf = (dayKey: string) => countdowns.filter((one) => one.date === dayKey);

  const saveWhy = async (todoId: string) => {
    const text = (why[todoId] ?? "").trim();
    await dailyNoteSet(selected, "todo:" + todoId, text);
    const one = await dailyGet(selected);
    setReport(one);
    toast("记下了", "success");
  };

  const saveSummary = async () => {
    await dailyNoteSet(selected, "day", summary.trim());
    const one = await dailyGet(selected);
    setReport(one);
    toast("小结记下了", "success");
  };

  const dayTodos = todosOf(selected);

  return (
    <div data-mobile-zone="schedule" className="relative flex h-full flex-col">
      {/* 三个视图 */}
      <div className="flex shrink-0 gap-1.5 px-3 pt-3">
        {(
          [
            { key: "today", label: "今天" },
            { key: "week", label: "一周" },
            { key: "month", label: "月" },
          ] as { key: "today" | "week" | "month"; label: string }[]
        ).map((one) => (
          <button
            key={one.key}
            type="button"
            data-msch-tab={one.key}
            data-msch-tab-active={tab === one.key ? "1" : "0"}
            onClick={() => setTab(one.key)}
            className={
              "rounded-full border px-3 py-1 text-[11.5px] " +
              (tab === one.key
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
            }
          >
            {one.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-20 pt-2">
        {/* ① 今天 */}
        {tab === "today" && (
          <>
            <p className="px-1 py-1.5 text-[11px] text-slate-400">
              今天 · {todayKey}
            </p>
            <div data-msch-timeline className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {timeline.length === 0 && (
                <p className="px-3 py-6 text-center text-[12.5px] text-slate-400">
                  今天还没有安排时间的待办（在待办卡片上「设定时间」就会出现在这里）。
                </p>
              )}
              {timeline.map((todo) => (
                <div key={todo.id} data-msch-timeline-item={todo.id} className="flex items-center gap-2.5 px-3 py-2.5">
                  <span className="w-11 shrink-0 text-[11px] tabular-nums text-slate-400">
                    {todo.plannedAt ? formatStamp(todo.plannedAt).slice(-5) : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{todo.title}</span>
                </div>
              ))}
            </div>

            <p className="px-1 py-1.5 pt-3 text-[11px] text-slate-400">今天要做的 · {todosOf(todayKey).length} 条</p>
            <ul data-msch-today-list className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {todosOf(todayKey).map((todo) => (
                <li key={todo.id} data-msch-today-item={todo.id} className="px-3 py-2.5 text-[13px]">
                  {todo.title}
                </li>
              ))}
              {todosOf(todayKey).length === 0 && (
                <li className="px-3 py-5 text-center text-[12.5px] text-slate-400">今天没有要做的了</li>
              )}
            </ul>
          </>
        )}

        {/* ② 一周：横滑 7 天 + 那天的日报 */}
        {tab === "week" && (
          <>
            <div data-msch-week className="flex gap-1.5 overflow-x-auto pb-2">
              {week.map((one) => (
                <button
                  key={one.key}
                  type="button"
                  data-msch-week-day={one.key}
                  data-msch-week-day-active={selected === one.key ? "1" : "0"}
                  onClick={() => setSelected(one.key)}
                  className={
                    "flex w-11 shrink-0 flex-col items-center rounded-xl border py-1.5 " +
                    (selected === one.key
                      ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-500/15"
                      : "border-slate-200 dark:border-slate-700")
                  }
                >
                  <span className="text-[10px] text-slate-400">{one.label}</span>
                  <span className="text-[15px] font-bold tabular-nums">{one.day}</span>
                  <span className="text-[9.5px] text-slate-400">{todosOf(one.key).length}</span>
                </button>
              ))}
            </div>

            {/* 某天的日报 */}
            <div data-msch-report className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              <p data-msch-report-date className="text-[12.5px] font-bold">
                {selected} 的日报
              </p>
              <p className="mt-1 text-[10.5px] text-slate-400">
                「完成了什么」是从待办算出来的；下面这些**手写的**才会存进文件（同步时要用的就是它）。
              </p>

              <div className="mt-2">
                <p className="text-[11px] text-slate-400">那天要做的（{dayTodos.length}）</p>
                {dayTodos.map((todo) => (
                  <div key={todo.id} data-msch-report-todo={todo.id} className="border-b border-slate-100 py-2 dark:border-slate-800">
                    <p className="text-[12.5px]">{todo.title}</p>
                    <div className="mt-1 flex gap-2">
                      <input
                        data-msch-report-input={todo.id}
                        value={why[todo.id] ?? ""}
                        onChange={(event) => setWhy({ ...why, [todo.id]: event.target.value })}
                        placeholder="为什么没跟进？（写一句）"
                        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-[12px] dark:border-slate-700 dark:bg-slate-800"
                      />
                      <button
                        type="button"
                        data-msch-report-save={todo.id}
                        onClick={() => void saveWhy(todo.id)}
                        className="rounded-lg bg-indigo-600 px-2.5 text-[12px] text-white"
                      >
                        记下
                      </button>
                    </div>
                  </div>
                ))}
                {dayTodos.length === 0 && <p className="py-2 text-[12px] text-slate-400">那天没有要做的。</p>}
              </div>

              <p className="mt-3 text-[11px] text-slate-400">当天小结</p>
              <textarea
                data-msch-report-day-input
                rows={2}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="今天怎么样…"
                className="w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-msch-report-day-save
                onClick={() => void saveSummary()}
                className="mt-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-[12.5px] text-white"
              >
                记下小结
              </button>
              {report && report.notes.length > 0 && (
                <p data-msch-report-saved className="mt-2 text-[10.5px] text-emerald-600">
                  这天已经写了 {report.notes.length} 条手写内容
                </p>
              )}
            </div>
          </>
        )}

        {/* ③ 月视图 + 倒计时 */}
        {tab === "month" && (
          <>
            <div className="flex items-center justify-between px-1 py-1.5">
              <span data-msch-month-label className="text-[13px] font-bold">
                {month.year} 年 {month.monthIndex + 1} 月
              </span>
              <span className="flex gap-2 text-[11.5px] text-indigo-600 dark:text-indigo-300">
                <button type="button" data-msch-nav-prev onClick={() => setCursor(new Date(month.year, month.monthIndex - 1, 1))}>
                  ‹
                </button>
                <button type="button" data-msch-nav-today onClick={() => { setCursor(new Date()); setSelected(todayKey); }}>
                  今天
                </button>
                <button type="button" data-msch-nav-next onClick={() => setCursor(new Date(month.year, month.monthIndex + 1, 1))}>
                  ›
                </button>
              </span>
            </div>

            <div data-msch-month className="grid grid-cols-7 gap-1">
              {["一", "二", "三", "四", "五", "六", "日"].map((one) => (
                <span key={one} className="text-center text-[10px] text-slate-400">
                  {one}
                </span>
              ))}
              {month.days.map((one) => {
                const cds = countdownsOf(one.key);
                const isToday = one.key === todayKey;
                const isPicked = one.key === selected;
                return (
                  <button
                    key={one.key}
                    type="button"
                    data-msch-month-day={one.key}
                    data-msch-month-day-today={isToday ? "1" : "0"}
                    onClick={() => setSelected(one.key)}
                    className={
                      "relative h-14 rounded-lg border p-1 text-left " +
                      (isPicked
                        ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-500/15"
                        : isToday
                          ? "border-indigo-300 dark:border-indigo-500/60"
                          : "border-slate-200 dark:border-slate-800") +
                      (one.inMonth ? "" : " opacity-40")
                    }
                  >
                    <span className="text-[11px] tabular-nums">{one.day}</span>
                    {cds.slice(0, 1).map((cd) => (
                      <span
                        key={cd.id}
                        data-msch-month-cd={cd.id}
                        className="absolute inset-x-0.5 bottom-0.5 truncate rounded border border-amber-300 bg-amber-50 px-0.5 text-[8.5px] text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                      >
                        {countdownShort(daysLeftOf(cd.date))}
                        {cds.length > 1 ? " +" + (cds.length - 1) : ""}
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>

            {/* 倒计时：就地加（不跳页、不弹窗） */}
            <div className="mt-3 flex items-center justify-between px-1">
              <span className="text-[11px] text-slate-400">
                {selected} 的倒计时（{countdownsOf(selected).length}）
              </span>
              <button
                type="button"
                data-msch-cd-add
                onClick={() => {
                  setCdOpen(true);
                  setCdDate(selected);
                }}
                className="rounded-full border border-slate-200 px-2.5 py-0.5 text-[11px] text-indigo-600 dark:border-slate-700 dark:text-indigo-300"
              >
                ＋ 倒计时
              </button>
            </div>

            {cdOpen && (
              <div data-msch-cd-form className="mt-2 rounded-xl border border-indigo-300 bg-white p-2.5 dark:border-indigo-500/50 dark:bg-slate-900">
                <p className="pb-1 text-[11px] text-slate-400">新建倒计时（默认用你选中的 {selected}）</p>
                <input
                  data-msch-cd-title
                  value={cdTitle}
                  onChange={(event) => setCdTitle(event.target.value)}
                  placeholder="比如：交实验报告"
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
                />
                <input
                  data-msch-cd-date
                  value={cdDate}
                  onChange={(event) => setCdDate(event.target.value)}
                  placeholder="2026-10-20"
                  className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[12.5px] tabular-nums dark:border-slate-700 dark:bg-slate-800"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-msch-cd-save
                    onClick={async () => {
                      const title = cdTitle.trim();
                      if (!title || !cdDate.trim()) {
                        toast("标题和日期都要填", "error");
                        return;
                      }
                      const one = await createCountdown(title, cdDate.trim());
                      if (one) {
                        void refreshAll();
                        setCdTitle("");
                        setCdOpen(false);
                        toast("加好了：" + countdownText(daysLeftOf(one.date)), "success");
                      }
                    }}
                    className="rounded-xl bg-indigo-600 px-3 py-1.5 text-[12.5px] text-white"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    data-msch-cd-cancel
                    onClick={() => setCdOpen(false)}
                    className="rounded-xl border border-slate-200 px-3 py-1.5 text-[12.5px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            <div data-msch-cd-list className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {countdownsOf(selected).map((cd) => (
                <div key={cd.id} data-msch-cd-item={cd.id} className="flex items-center gap-2 px-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{cd.title}</span>
                  <span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    {countdownText(daysLeftOf(cd.date))}
                  </span>
                  <button type="button" data-msch-cd-del={cd.id} onClick={() => setCdDel(cd)} className="shrink-0 text-[11px] text-rose-600 dark:text-rose-400">
                    删
                  </button>
                </div>
              ))}
              {countdownsOf(selected).length === 0 && (
                <p className="px-3 py-5 text-center text-[12.5px] text-slate-400">这天没有倒计时</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* 倒计时删除二次确认 */}
      {cdDel && (
        <div data-msch-cd-confirm className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6" onClick={() => setCdDel(null)}>
          <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] leading-relaxed">删掉倒计时「{cdDel.title}」？删之前会自动留一份档。</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-msch-cd-confirm-del
                onClick={() => {
                  const one = cdDel;
                  setCdDel(null);
                  void deleteCountdown(one.id);
                }}
                className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white"
              >
                删除
              </button>
              <button type="button" data-msch-cd-confirm-cancel onClick={() => setCdDel(null)} className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
