/**
 * 今日时间轴（雏形，M5-7）。
 *
 * PRD §5.3：**把当日待办按设定时间排成一条竖线**（无日历、不跨天）；
 * 10.4 那条：没有设定时间的待办**不进入时间轴**。
 *
 * "雏形"的意思是：只做今天、只做一条竖线，不做日历、不做单日行程
 * （完整日程是第二版的东西，在 PRD §9 的红线里）。
 */
import type { Todo } from "../types";
import { hhmm, minutesOfDay } from "./time";

interface TimelineProps {
  /** 已经过滤好：只该传"今天 + 有 plannedAt"的待办 */
  todos: Todo[];
  /** 点时间轴上一条 → 跳到下面那张卡片 */
  onJump: (todo: Todo) => void;
}

export default function TodayTimeline({ todos, onJump }: TimelineProps) {
  const sorted = [...todos].sort((a, b) => minutesOfDay(a.plannedAt ?? "") - minutesOfDay(b.plannedAt ?? ""));

  if (sorted.length === 0) {
    return (
      <div
        data-timeline
        data-timeline-count="0"
        className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400 dark:border-slate-700"
      >
        <p>今天还没有安排时间的待办。</p>
        <p className="mt-1 text-[11px]">在待办卡片左下角点「没设时间」就能设。</p>
      </div>
    );
  }

  return (
    <div data-timeline data-timeline-count={sorted.length} className="flex flex-col">
      {sorted.map((todo, index) => {
        const done = todo.status === "done";
        const last = index === sorted.length - 1;
        return (
          <button
            key={todo.id}
            type="button"
            data-timeline-item={todo.id}
            data-timeline-time={todo.plannedAt ?? ""}
            title="点它跳到下面这张卡片"
            onClick={() => onJump(todo)}
            className="group flex items-stretch gap-2 text-left"
          >
            {/* 左侧：时间 + 竖线 */}
            <div className="flex w-12 shrink-0 flex-col items-end pt-0.5">
              <span
                className={`font-mono text-xs tabular-nums ${
                  done ? "text-slate-400 line-through dark:text-slate-500" : "text-slate-600 dark:text-slate-300"
                }`}
              >
                {hhmm(todo.plannedAt ?? "")}
              </span>
            </div>

            <div className="flex flex-col items-center">
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ring-2 ${
                  done
                    ? "bg-slate-300 ring-slate-200 dark:bg-slate-600 dark:ring-slate-700"
                    : "bg-indigo-500 ring-indigo-200 dark:ring-indigo-500/30"
                }`}
              />
              {!last && (
                <span className="w-px flex-1 bg-slate-200 group-hover:bg-indigo-300 dark:bg-slate-700" />
              )}
            </div>

            {/* 右侧：标题 */}
            <div className="min-w-0 flex-1 pb-3">
              <p
                className={`truncate text-xs ${
                  done ? "text-slate-400 line-through dark:text-slate-500" : "text-slate-700 dark:text-slate-200"
                }`}
              >
                {todo.title}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
