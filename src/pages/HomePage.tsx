import { useEffect, useState } from "react";
import { useUi } from "../store/ui";
import { useData } from "../store/data";
import { mottoList } from "../features/api";
import { formatStamp } from "../shared/daytime";
import { infoHeadline } from "../shared/reminderText";
import { dateKey } from "../features/schedule/aggregate";
import { attribution, todayMotto } from "../features/skills/mottos";
import QuadrantBoard from "../features/todos/Quadrant";
import type { Motto, Quadrant, Todo } from "../features/types";

/**
 * 首页：**只有一块常驻动态区**（提醒 / 最近待办）。
 *
 * ⚠️ 右侧的「入口列表」2026-09-21 按用户要求**去掉了**：六个区在左侧导航里一直都在，
 * 首页再放一遍是重复（PRD §3.1 画的是"动态区在左、入口列表在右"，这里有意偏离）。
 * 动态区规则（PRD §3.2）：**没东西时不显示卡片**，只有一句"今天这里还是空的"的提示。
 */
export default function HomePage() {
  const setView = useUi((s) => s.setView);
  const reminders = useData((s) => s.reminders);
  const todos = useData((s) => s.todos);
  const minutes = useData((s) => s.config.reminders.infoStaleMinutes);
  const config = useData((s) => s.config);
  const setFocusRef = useData((s) => s.setFocusRef);
  const linkToNote = useData((s) => s.linkToNote);
  const linkToTodo = useData((s) => s.linkToTodo);
  const [mottos, setMottos] = useState<Motto[]>([]);

  useEffect(() => {
    let alive = true;
    const loadMottos = () => {
      void mottoList()
        .then((items) => {
          if (alive) setMottos(items);
        })
        .catch(() => {
          // 首页格言是附加内容：读不到就安静隐藏，别打断首页主流程。
        });
    };
    loadMottos();
    window.addEventListener("focus", loadMottos);
    return () => {
      alive = false;
      window.removeEventListener("focus", loadMottos);
    };
  }, []);
  // PRD §3.2：每张卡片右上角「×」**临时收起**（重开程序会回来；永久关掉去设置）
  const hiddenCards = useUi((s) => s.hiddenHomeCards);
  const hideHomeCard = useUi((s) => s.hideHomeCard);

  /**
   * 两类提醒都要显示：
   * - `info-stale`：45 分钟没联动的信息；
   * - `todo-remind`：「再次设定时间提醒」到点的**待办**（M5 新增的去向）。
   */
  const liveReminders = reminders
    .filter((item) => item.status === "fired")
    .sort((a, b) => b.fireAt.localeCompare(a.fireAt))
    .slice(0, 3);
  const recentTodos = todos
    .filter((todo) => todo.status === "open")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);

  const showReminders =
    config.homeSticky.reminders && liveReminders.length > 0 && !hiddenCards.includes("reminders");
  const showTodos =
    config.homeSticky.recentTodos && recentTodos.length > 0 && !hiddenCards.includes("todos");
  const showDynamic = showReminders || showTodos;
  const homeMotto = todayMotto(mottos);

  /** 点待办卡片 → 跳执行区并定位该待办（PRD 3.3） */
  const goToTodo = (id: string) => {
    setFocusRef({ kind: "todo", id });
    setView("todo");
  };

  /**
   * M11-B：**今天还剩几件事**（没完成的，算"设了今天的时间"或"今天到期"）。
   *
   * 🔴 首页**不放日历**（V1 的规矩，PRD §3.2 那条），所以这里就一行字 + 一个入口：
   *    "今天有 N 件事 → 去日程页"。要看日历/一周，去日程页。
   * ⚠️ 日期一律按**本地时区**算（`dateKey`），后端存的是 UTC。
   */
  const todayKey = dateKey(new Date());
  const todayCount = todos.filter(
    (todo) =>
      todo.status === "open" &&
      ((todo.plannedAt && dateKey(todo.plannedAt) === todayKey) ||
        (todo.dueAt && dateKey(todo.dueAt) === todayKey)),
  ).length;

  /**
   * #8（2026-10-21 · 用户反馈第二批）：十字待办（四象限）从执行区**搬到首页右侧**。
   *
   * - 首页只负责**看** ＋ 点一条跳执行区定位；**分类本身**仍走执行区卡片 ⚙ 里那排
   *   「调整分类」按钮 —— 首页没有待办集，原来那套"把卡片拖进格子"在这里不成立。
   * - 开关 `homeSticky.quadrant`：跟另外几项常驻项一致，设置里能关掉。
   */
  const quadGroups: Record<Quadrant, Todo[]> = {
    q1: todos.filter((todo) => todo.status === "open" && todo.quadrant === "q1"),
    q2: todos.filter((todo) => todo.status === "open" && todo.quadrant === "q2"),
    q3: todos.filter((todo) => todo.status === "open" && todo.quadrant === "q3"),
    q4: todos.filter((todo) => todo.status === "open" && todo.quadrant === "q4"),
  };
  const renderQuadCard = (todo: Todo) => (
    <button
      type="button"
      data-home-quadrant-todo={todo.id}
      data-todo-id={todo.id}
      title="点它跳到执行区并定位这条待办"
      onClick={() => goToTodo(todo.id)}
      className="flex w-full items-center gap-1.5 rounded px-0.5 py-1 text-left text-[11px] text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-300"
    >
      <span className="text-slate-400">☐</span>
      <span className="min-w-0 flex-1 truncate">{todo.title}</span>
    </button>
  );

  const todayCard = (
    <button
      type="button"
      data-home-today
      data-home-today-count={todayCount}
      title="去日程页看今天和接下来几天"
      onClick={() => setView("schedule")}
      className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/60 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/10"
    >
      <span className="font-medium">今天</span>
      <span className="text-slate-400">·</span>
      <span className="text-slate-500 dark:text-slate-400">
        {todayCount > 0 ? `${todayCount} 件事还没做` : "没有安排"}
      </span>
      <span className="ml-auto text-xs text-indigo-500 dark:text-indigo-400">去日程页 →</span>
    </button>
  );

  return (
    <div className="flex h-full gap-8 p-8">
      <div className="flex w-full max-w-sm flex-col gap-4">
        {/* 首页每日格言：跟挂件 / 专注小窗共用同一套“本地日期哈希”，当天固定不变。 */}
        {homeMotto && (
          <section
            data-home-motto
            data-home-motto-id={homeMotto.id}
            className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-amber-50 p-5 dark:border-indigo-500/20 dark:from-indigo-500/10 dark:via-slate-900 dark:to-amber-500/5"
          >
            <p className="text-[11px] font-medium tracking-[0.16em] text-indigo-500 dark:text-indigo-300">
              今日一句
            </p>
            <blockquote className="mt-2 text-[15px] leading-7 text-slate-700 dark:text-slate-200">
              {homeMotto.text}
            </blockquote>
            <p className="mt-2 text-right text-[11px] text-slate-400">{attribution(homeMotto)}</p>
          </section>
        )}

        {/* ① 常驻动态区 */}
        {showDynamic && (
          <section className="flex w-full max-w-sm flex-col gap-4">
          {todayCard}
          {showReminders && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-500/30 dark:bg-amber-500/10">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">提醒</h2>
                {/* PRD §3.2：卡片右上角 × **临时收起**（重开程序会回来） */}
                <button
                  type="button"
                  data-home-hide="reminders"
                  title="临时收起（重开程序会回来；想永久关掉去设置）"
                  onClick={() => hideHomeCard("reminders")}
                  className="-mr-1 -mt-1 rounded-lg px-1.5 text-sm leading-5 text-amber-700/70 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-200/70 dark:hover:bg-amber-500/20"
                >
                  ×
                </button>
              </div>
              <ul className="mt-3 flex flex-col gap-3">
                {liveReminders.map((reminder) => {
                  const isTodo = reminder.kind === "todo-remind";
                  return (
                    <li
                      key={reminder.id}
                      data-home-reminder={reminder.kind}
                      className="text-xs text-amber-900/90 dark:text-amber-200/90"
                    >
                      <p className="font-medium">
                        {isTodo
                          ? `你设的提醒到点了：${reminder.payload.text}`
                          : `你在 ${minutes} 分钟前的〔${reminder.payload.categoryText}〕信息还没推进下一步`}
                      </p>
                      <p className="mt-0.5 truncate text-amber-800/80 dark:text-amber-200/70">
                        {infoHeadline(reminder.payload.text)}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <p className="text-amber-700/60 dark:text-amber-300/50">
                          {formatStamp(reminder.fireAt)}
                        </p>
                        {isTodo ? (
                          <button
                            type="button"
                            data-home-reminder-go={reminder.refId}
                            onClick={() => goToTodo(reminder.refId)}
                            className="rounded-lg bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700"
                          >
                            去开始
                          </button>
                        ) : (
                          <>
                            {/* PRD 10.6：点首页提醒里的【联动到认知区】→ 直接完成联动，
                                不用再进信息区点一遍 */}
                            <button
                              type="button"
                              data-home-reminder-link={reminder.refId}
                              onClick={() => void linkToNote(reminder.refId)}
                              className="rounded-lg bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700"
                            >
                              联动到认知区
                            </button>
                            <button
                              type="button"
                              data-home-reminder-todo={reminder.refId}
                              onClick={() => void linkToTodo(reminder.refId)}
                              className="rounded-lg bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200 dark:ring-amber-500/40"
                            >
                              建为待办
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                onClick={() => setView("info")}
                className="mt-4 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                去信息区处理
              </button>
            </div>
          )}

          {showTodos && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-sm font-semibold">最近待办</h2>
                {/* PRD §3.2：卡片右上角 × **临时收起**（重开程序会回来） */}
                <button
                  type="button"
                  data-home-hide="todos"
                  title="临时收起（重开程序会回来；想永久关掉去设置）"
                  onClick={() => hideHomeCard("todos")}
                  className="-mr-1 -mt-1 rounded-lg px-1.5 text-sm leading-5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  ×
                </button>
              </div>
              <ul className="mt-3 flex flex-col gap-2">
                {recentTodos.map((todo) => (
                  <li key={todo.id}>
                    <button
                      type="button"
                      data-home-todo={todo.id}
                      title="点它跳到执行区并定位这条待办"
                      onClick={() => goToTodo(todo.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <span className="text-slate-400">☐</span>
                      <span className="min-w-0 flex-1 truncate">{todo.title}</span>
                      <span className="shrink-0 text-slate-400">
                        {todo.source.kind === "info"
                          ? "来自信息"
                          : todo.source.kind === "note"
                            ? "来自笔记"
                            : "手动"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setView("todo")}
                className="mt-4 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                去执行区
              </button>
            </div>
          )}
          </section>
        )}

        {/* ② 右侧**不再放入口列表**（2026-09-21 用户反馈：
            "既然软件左侧都有那几个区域了，在首页我觉得就不用在右侧也放出来了，
             那个地方就保留提醒和以后新版本的首页功能就够了"）。
            所以首页现在只有左边这一块动态区，右边留给"以后的首页功能"。
            ⚠️ 这是**有意偏离 PRD §3.1**（那里画的是"动态区在左、入口列表在右"）——
            六个区在左侧导航里一直都在，首页再放一遍是重复。 */}
        {!showDynamic && (
          <section
            data-home-empty
            className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-dashed border-slate-300 p-6 text-sm text-slate-400 dark:border-slate-700"
          >
            {todayCard}
            <p className="font-medium text-slate-500 dark:text-slate-300">今天这里还是空的</p>
            <p className="text-xs leading-relaxed">
              记一条信息、建一个待办、或者设一个提醒 —— 到点了这里就会出现提醒和最近待办。
            </p>
          </section>
        )}
      </div>

      {/* ③ 右侧：十字待办（#8 · 2026-10-21 从执行区搬过来）
          ⚠️ 这一块是**常驻项**：开了就一直在这儿（空的时候四格给提示），
             不像上面那两张卡"没东西就不显示" —— 用户要的是"一眼能看见优先级"。 */}
      {config.homeSticky.quadrant && (
        <section data-home-quadrant className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">十字待办</h2>
            <button
              type="button"
              data-home-quadrant-go
              onClick={() => setView("todo")}
              className="text-xs text-indigo-500 hover:underline dark:text-indigo-400"
            >
              去执行区调整 →
            </button>
          </div>
          <QuadrantBoard
            groups={quadGroups}
            renderCard={renderQuadCard}
            activeQuadrant={null}
            dragging={false}
            emptyHint="执行区 ⚙ 里选一个象限"
          />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            分类还在执行区：卡片右下角 ⚙ →「调整分类」。点这里的一条能跳过去定位它。
          </p>
        </section>
      )}
    </div>
  );
}
