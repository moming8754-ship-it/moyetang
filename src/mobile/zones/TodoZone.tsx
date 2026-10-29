/**
 * 手机版 · 执行区（M19.4 / v2.5.0）
 *
 * 照设计稿 `.spike\M18D-rest-zones.html`（执行区三格）+ `M18E-v2-supplement.html`（分组 + 线分层）：
 *   ① 待办集：分组折叠（有名字的组在前、"未分组"最后）+ 每条可勾 + ⋮ 菜单
 *   ② 十字待办：**手机上不做拖动** —— 四格各自「挑一条放进来」（电脑版是拖）
 *   ③ 番茄：极简计时面板（开始/暂停/结束 → 记一次番茄）
 *      ⚠️ **完整版（软锁、暂停/中断、须知、多次记录）在 M20 做**，这一版只保证"能开始、能记下来"。
 *
 * ⚠️ 逻辑复用电脑版：`setTodoDone` / `setTodoQuadrant` / `setTodoGroup` / `deleteTodo` /
 *    `addPomodoro` / `setFocusRef`；新建走 `api.todoCreate` + `refresh`（跟首页快速记录同一条路）。
 * ⚠️ 视觉：**线分层**（一个面板 + 条目间细线），四象限是**一个网格 + 十字线**、颜色缩成标题前小圆点。
 */
import { useEffect, useMemo, useState } from "react";

import { todoCreate } from "../../features/api";
import type { Quadrant, Todo, TodoRepeat } from "../../features/types";
import { fromLocalInput, toLocalInput } from "../../features/todos/time";
import { formatStamp } from "../../shared/daytime";
import { useData } from "../../store/data";

import FocusPanel from "./FocusPanel";
import { registerBackLayer } from "../back";

const QUADRANTS: { key: Quadrant; label: string; hint: string; dot: string }[] = [
  { key: "q1", label: "重要且紧急", hint: "马上做", dot: "#fb7185" },
  { key: "q2", label: "重要但不急", hint: "安排着做", dot: "#34d399" },
  { key: "q3", label: "不重要但紧急", hint: "尽快做", dot: "#fbbf24" },
  { key: "q4", label: "都不", hint: "有空再说", dot: "#818cf8" },
];

/** ⑦（2026-10-11 用户反馈第 7 条）：重复规则那三档（跟电脑版 ⚙ 里一个意思） */
const REPEATS: { key: TodoRepeat | "none"; label: string }[] = [
  { key: "none", label: "不重复" },
  { key: "daily", label: "每天" },
  { key: "weekly", label: "每周" },
  { key: "monthly", label: "每月" },
];

export default function TodoZone() {
  const todos = useData((s) => s.todos);
  const refresh = useData((s) => s.refresh);
  const setTodoDone = useData((s) => s.setTodoDone);
  const setTodoQuadrant = useData((s) => s.setTodoQuadrant);
  const setTodoGroup = useData((s) => s.setTodoGroup);
  const deleteTodo = useData((s) => s.deleteTodo);
  // ⑦ 属性面板要用的那一串（全部是电脑版 ⚙ 里已经在用的 action，手机版只是补上门）
  const setTodoTitle = useData((s) => s.setTodoTitle);
  const setTodoPlanned = useData((s) => s.setTodoPlanned);
  const setTodoDue = useData((s) => s.setTodoDue);
  const setTodoRepeat = useData((s) => s.setTodoRepeat);
  const addSubtask = useData((s) => s.addSubtask);
  const toggleSubtask = useData((s) => s.toggleSubtask);
  const removeSubtask = useData((s) => s.removeSubtask);
  const scheduleTodoRemind = useData((s) => s.scheduleTodoRemind);

  const [tab, setTab] = useState<"collection" | "cross">("collection");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = useState<Todo | null>(null);
  const [confirmDel, setConfirmDel] = useState<Todo | null>(null);
  const [groupPickFor, setGroupPickFor] = useState<Todo | null>(null);
  const [newGroup, setNewGroup] = useState("");
  const [pickFor, setPickFor] = useState<Quadrant | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  /**
   * ⑦ 属性面板（2026-10-11 用户反馈第 7 条：「手机版的待办，还没有像电脑版那样提前设置
   * 待办属性的功能」）。**开着的那条待办 id** —— 面板里的输入框都从这里派生初值。
   */
  const [propsForId, setPropsForId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [plannedDraft, setPlannedDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");
  const [remindDraft, setRemindDraft] = useState("");
  const [subDraft, setSubDraft] = useState("");

  /** M20：专注**整屏页**（引擎复用电脑版 Rust；点「▶ 开始」把它打开） */
  const [focusTodo, setFocusTodo] = useState<Todo | null>(null);

  /** ⑦ 属性面板对应的那条待办：从 `todos` 里取**最新的一份**（改完立刻反映在面板上） */
  const propsFor = propsForId ? (todos.find((one) => one.id === propsForId) ?? null) : null;

  /**
   * 打开属性面板：把这条待办的现值填进各个输入框。
   * ⚠️ 时间一律走 `features/todos/time.ts` 的 `toLocalInput` / `fromLocalInput`
   *    （`todos.json` 存的是带时区的 ISO，`datetime-local` 只认本地时间，中间必须转一道）。
   */
  const openProps = (todo: Todo) => {
    setPropsForId(todo.id);
    setTitleDraft(todo.title);
    setPlannedDraft(toLocalInput(todo.plannedAt));
    setDueDraft(toLocalInput(todo.dueAt));
    setRemindDraft(toLocalInput(todo.reminderAt));
    setSubDraft("");
    setMenuFor(null);
  };

  // P0-2：返回手势先关浮层
  const backSheetOpen = !!(menuFor || confirmDel || pickFor || propsForId);
  useEffect(() => {
    if (!backSheetOpen) return;
    return registerBackLayer(() => {
      setMenuFor(null);
      setConfirmDel(null);
      setPickFor(null);
      setPropsForId(null);
      return true;
    });
  }, [backSheetOpen]);

  const openTodos = useMemo(() => todos.filter((one) => one.status === "open"), [todos]);

  /** 分组：有名字的在前（字典序），"未分组"永远最后 */
  const groups = useMemo(() => {
    const named = Array.from(new Set(todos.map((one) => one.group ?? "").filter((one) => one.trim() !== ""))).sort();
    return [...named, ""];
  }, [todos]);

  const byQuadrant = (key: Quadrant) => openTodos.filter((one) => one.quadrant === key);
  /** 还没进象限的（"挑一条放进来"的候选） */
  const unplaced = openTodos.filter((one) => !one.quadrant);




  return (
    <div data-mobile-zone="todo" className="relative flex h-full flex-col">
      {/* 顶部两个视图 */}
      <div className="flex shrink-0 gap-1.5 px-3 pt-3">
        {(
          [
            { key: "collection", label: "待办集" },
            { key: "cross", label: "十字待办" },
          ] as { key: "collection" | "cross"; label: string }[]
        ).map((one) => (
          <button
            key={one.key}
            type="button"
            data-mtodo-tab={one.key}
            data-mtodo-tab-active={tab === one.key ? "1" : "0"}
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
        {/* ① 待办集 */}
        {tab === "collection" &&
          groups.map((group) => {
            const rows = openTodos.filter((one) => (one.group ?? "") === group);
            if (rows.length === 0) return null;
            const isCollapsed = collapsed[group] === true;
            return (
              <div key={group || "__none"} data-mtodo-group={group}>
                <button
                  type="button"
                  data-mtodo-group-toggle={group}
                  onClick={() => setCollapsed({ ...collapsed, [group]: !isCollapsed })}
                  className="flex w-full items-center justify-between px-1 py-2 text-[11px] text-slate-400"
                >
                  <span>{group || "未分组"} {isCollapsed ? "▸" : "▾"}</span>
                  <span>{rows.length} 条</span>
                </button>
                {!isCollapsed && (
                  <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                    {rows.map((todo) => (
                      <li key={todo.id} data-mtodo-row={todo.id} className="flex items-center gap-2.5 p-3">
                        <button
                          type="button"
                          data-mtodo-check={todo.id}
                          aria-label="完成这条"
                          onClick={() => void setTodoDone(todo.id, true)}
                          className="h-[15px] w-[15px] shrink-0 rounded border-[1.5px] border-slate-300 dark:border-slate-600"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px]">{todo.title}</p>
                          <p className="mt-0.5 text-[10.5px] text-slate-400">
                            {todo.plannedAt ? "今天 " + formatStamp(todo.plannedAt) : "没设时间"}
                            {todo.customMinutes ? " · 这条用 " + todo.customMinutes + " 分钟" : ""}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-mtodo-start={todo.id}
                          aria-label="开始专注"
                          title="开始专注"
                          onClick={() => setFocusTodo(todo)}
                          className="shrink-0 rounded-lg bg-indigo-600 px-2 py-1 text-[11px] text-white"
                        >
                          ▶ 开始
                        </button>
                        <button
                          type="button"
                          data-mtodo-menu={todo.id}
                          aria-label="这条的操作"
                          onClick={() => setMenuFor(todo)}
                          className="shrink-0 px-1 text-slate-400"
                        >
                          ⋮
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        {tab === "collection" && openTodos.length === 0 && (
          <p data-mtodo-empty className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-[13px] text-slate-400 dark:border-slate-700">
            还没有待办。点右下角的 ＋ 加一条。
          </p>
        )}

        {/* ② 十字待办（一个网格 + 十字线；不做拖动 → 点格子挑一条） */}
        {tab === "cross" && (
          <div data-mtodo-quad-grid className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
            {QUADRANTS.map((one, index) => {
              const rows = byQuadrant(one.key).slice(0, 3);
              const total = byQuadrant(one.key).length;
              return (
                <div
                  key={one.key}
                  data-mtodo-quad={one.key}
                  className={
                    "min-h-[120px] p-2.5 " +
                    (index % 2 === 0 ? "border-r border-slate-200 dark:border-slate-800 " : "") +
                    (index < 2 ? "border-b border-slate-200 dark:border-slate-800 " : "")
                  }
                >
                  <p className="mb-1.5 flex items-center gap-1.5 text-[10.5px] text-slate-400">
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: one.dot }} />
                    {one.label}
                    <span className="ml-auto">{one.hint}</span>
                  </p>
                  {rows.map((todo) => (
                    <p key={todo.id} data-mtodo-quad-item={todo.id} className="truncate text-[12px]">
                      {todo.title}
                    </p>
                  ))}
                  {total > 3 && <p className="text-[10px] text-slate-400">还有 {total - 3} 条…</p>}
                  {rows.length === 0 && <p className="text-[10.5px] text-slate-300 dark:text-slate-600">空的</p>}
                  <button
                    type="button"
                    data-mtodo-quad-pick={one.key}
                    onClick={() => setPickFor(one.key)}
                    className="mt-2 rounded-lg border border-slate-200 px-2 py-0.5 text-[10.5px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  >
                    ＋ 挑一条
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 「＋」新建待办 */}
      <button
        type="button"
        data-mtodo-fab
        aria-label="新建待办"
        onClick={() => setNewOpen(true)}
        className="absolute bottom-4 right-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg active:bg-indigo-700"
      >
        <svg viewBox="0 0 24 24" style={{ width: 22, height: 22 }} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {/* M20：专注整屏页（引擎复用电脑版 Rust：锁屏/睡过自动暂停、疑似离开、结算以后端快照为准） */}
      {focusTodo && <FocusPanel todo={focusTodo} onClose={() => setFocusTodo(null)} />}

      {/* 新建待办 */}
      {newOpen && (
        <div data-mtodo-new-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setNewOpen(false)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-sm font-bold">加一个待办</p>
            <input
              data-mtodo-new-input
              autoFocus
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="要做什么…"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                data-mtodo-new-save
                onClick={() => {
                  const title = newTitle.trim();
                  if (!title) return;
                  setNewOpen(false);
                  setNewTitle("");
                  void todoCreate(title).then(() => refresh());
                }}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white"
              >
                加上
              </button>
              <button type="button" data-mtodo-new-close onClick={() => setNewOpen(false)} className="rounded-xl border border-slate-200 px-3 py-2 text-[13px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                收起
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑦ 属性面板（2026-10-11 用户反馈第 7 条）—— 手机上也能"提前把属性设好"。
          电脑版在卡片 ⚙ 弹窗里；这里照它的语义做一套手机版，**用的全是同一个 store action**。 */}
      {propsFor && (
        <div
          data-mtodo-props-sheet
          className="absolute inset-0 z-40 flex flex-col justify-end bg-slate-900/40"
          onClick={() => setPropsForId(null)}
        >
          <div
            className="max-h-[85%] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="truncate px-1 pb-2 text-[13px] font-bold">待办属性 · {propsFor.title}</p>

            {/* 标题 */}
            <p className="px-1 pt-1 text-[11px] text-slate-400">标题</p>
            <div className="mt-1 flex gap-1.5">
              <input
                data-mtodo-props-title
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] outline-none dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mtodo-props-title-save
                disabled={!titleDraft.trim()}
                onClick={() => void setTodoTitle(propsFor.id, titleDraft.trim())}
                className="shrink-0 rounded-lg bg-indigo-600 px-3 text-[12px] font-medium text-white disabled:opacity-40"
              >
                存
              </button>
            </div>

            {/* 设定时间（= 排到今天的执行区时间轴） */}
            <p className="px-1 pt-3 text-[11px] text-slate-400">设定时间（今天的执行区时间轴）</p>
            <div className="mt-1 flex gap-1.5">
              <input
                type="datetime-local"
                data-mtodo-props-planned
                value={plannedDraft}
                onChange={(event) => setPlannedDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] outline-none dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mtodo-props-planned-save
                onClick={() => void setTodoPlanned(propsFor.id, fromLocalInput(plannedDraft))}
                className="shrink-0 rounded-lg bg-indigo-600 px-3 text-[12px] font-medium text-white"
              >
                存
              </button>
              <button
                type="button"
                data-mtodo-props-planned-clear
                onClick={() => {
                  setPlannedDraft("");
                  void setTodoPlanned(propsFor.id, null);
                }}
                className="shrink-0 rounded-lg border border-slate-200 px-2.5 text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
              >
                清
              </button>
            </div>

            {/* 截止日期 */}
            <p className="px-1 pt-3 text-[11px] text-slate-400">截止日期</p>
            <div className="mt-1 flex gap-1.5">
              <input
                type="datetime-local"
                data-mtodo-props-due
                value={dueDraft}
                onChange={(event) => setDueDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] outline-none dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mtodo-props-due-save
                onClick={() => void setTodoDue(propsFor.id, fromLocalInput(dueDraft))}
                className="shrink-0 rounded-lg bg-indigo-600 px-3 text-[12px] font-medium text-white"
              >
                存
              </button>
              <button
                type="button"
                data-mtodo-props-due-clear
                onClick={() => {
                  setDueDraft("");
                  void setTodoDue(propsFor.id, null);
                }}
                className="shrink-0 rounded-lg border border-slate-200 px-2.5 text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
              >
                清
              </button>
            </div>

            {/* 提醒（到下点在首页动态区出现） */}
            <p className="px-1 pt-3 text-[11px] text-slate-400">到点提醒我</p>
            <div className="mt-1 flex gap-1.5">
              <input
                type="datetime-local"
                data-mtodo-props-remind
                value={remindDraft}
                onChange={(event) => setRemindDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] outline-none dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mtodo-props-remind-save
                disabled={!remindDraft}
                onClick={() => {
                  const fireAt = fromLocalInput(remindDraft);
                  if (!fireAt) return;
                  void scheduleTodoRemind(propsFor.id, fireAt);
                  setRemindDraft("");
                }}
                className="shrink-0 rounded-lg bg-amber-600 px-3 text-[12px] font-medium text-white disabled:opacity-40"
              >
                加一条
              </button>
            </div>
            {propsFor.reminderAt && (
              <p className="mt-1 px-1 text-[11px] text-amber-600 dark:text-amber-300">
                已排：{toLocalInput(propsFor.reminderAt).replace("T", " ")}
              </p>
            )}

            {/* 重复 */}
            <p className="px-1 pt-3 text-[11px] text-slate-400">重复</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {REPEATS.map((one) => {
                const active = (propsFor.repeat ?? "none") === one.key;
                return (
                  <button
                    key={one.key}
                    type="button"
                    data-mtodo-props-repeat={one.key}
                    onClick={() => void setTodoRepeat(propsFor.id, one.key === "none" ? null : one.key)}
                    className={`rounded-full px-2.5 py-1 text-[12px] ${
                      active
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {one.label}
                  </button>
                );
              })}
            </div>

            {/* 象限 */}
            <p className="px-1 pt-3 text-[11px] text-slate-400">四象限</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {QUADRANTS.map((one) => {
                const active = propsFor.quadrant === one.key;
                return (
                  <button
                    key={one.key}
                    type="button"
                    data-mtodo-props-quad={one.key}
                    onClick={() => void setTodoQuadrant(propsFor.id, active ? null : one.key)}
                    className={`rounded-full px-2.5 py-1 text-[12px] ${
                      active
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: one.dot }} />
                    {one.label}
                  </button>
                );
              })}
            </div>

            {/* 子任务 */}
            <p className="px-1 pt-3 text-[11px] text-slate-400">
              子任务{propsFor.subtasks?.length ? `（${propsFor.subtasks.filter((s) => s.done).length}/${propsFor.subtasks.length}）` : ""}
            </p>
            <ul className="mt-1">
              {(propsFor.subtasks ?? []).map((sub) => (
                <li key={sub.id} data-mtodo-props-sub={sub.id} className="flex items-center gap-2 border-b border-slate-100 py-1.5 dark:border-slate-800">
                  <input
                    type="checkbox"
                    data-mtodo-props-sub-toggle={sub.id}
                    checked={sub.done}
                    onChange={(event) => void toggleSubtask(propsFor.id, sub.id, event.target.checked)}
                  />
                  <span className={`min-w-0 flex-1 truncate text-[12.5px] ${sub.done ? "text-slate-400 line-through" : ""}`}>
                    {sub.text}
                  </span>
                  <button
                    type="button"
                    data-mtodo-props-sub-del={sub.id}
                    onClick={() => void removeSubtask(propsFor.id, sub.id)}
                    className="shrink-0 px-1 text-[12px] text-rose-600 dark:text-rose-400"
                  >
                    删
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex gap-1.5">
              <input
                data-mtodo-props-sub-input
                value={subDraft}
                onChange={(event) => setSubDraft(event.target.value)}
                placeholder="加一条子任务…"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] outline-none dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mtodo-props-sub-add
                disabled={!subDraft.trim()}
                onClick={() => {
                  void addSubtask(propsFor.id, subDraft.trim());
                  setSubDraft("");
                }}
                className="shrink-0 rounded-lg bg-indigo-600 px-3 text-[12px] font-medium text-white disabled:opacity-40"
              >
                加
              </button>
            </div>

            <button
              type="button"
              data-mtodo-props-close
              onClick={() => setPropsForId(null)}
              className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              收起
            </button>
          </div>
        </div>
      )}

      {/* 单条菜单 */}
      {menuFor && (
        <div data-mtodo-menu-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setMenuFor(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="truncate px-1 pb-2 text-[13px] font-bold">{menuFor.title}</p>
            <button type="button" data-mtodo-menu-action="done" onClick={() => { const one = menuFor; setMenuFor(null); void setTodoDone(one.id, true); }} className="w-full py-2.5 text-left text-[13px]">
              标完成
            </button>
            {/* ⑦（2026-10-11 用户反馈第 7 条）：手机版补上"提前设属性"这个门 ——
                电脑版在卡片上的 ⚙ 里（时间/截止/重复/子任务/象限），手机版原来只有这三项。 */}
            <button type="button" data-mtodo-menu-action="props" onClick={() => openProps(menuFor)} className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] dark:border-slate-800">
              ⚙ 属性…（时间 / 截止 / 重复 / 子任务）
            </button>
            <button type="button" data-mtodo-menu-action="group" onClick={() => { setGroupPickFor(menuFor); setMenuFor(null); }} className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] dark:border-slate-800">
              移到分组…
            </button>
            <button type="button" data-mtodo-menu-action="delete" onClick={() => { setConfirmDel(menuFor); setMenuFor(null); }} className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] text-rose-600 dark:border-slate-800 dark:text-rose-400">
              删除…
            </button>
            <button type="button" data-mtodo-menu-close onClick={() => setMenuFor(null)} className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* 移到分组 */}
      {groupPickFor && (
        <div data-mtodo-group-sheet className="absolute inset-0 z-40 flex flex-col justify-end bg-slate-900/40" onClick={() => setGroupPickFor(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">移到分组</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" data-mtodo-group-pick="__none" onClick={() => { const one = groupPickFor; setGroupPickFor(null); void setTodoGroup(one.id, ""); }} className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] dark:bg-slate-800">
                未分组
              </button>
              {groups.filter((one) => one).map((one) => (
                <button key={one} type="button" data-mtodo-group-pick={one} onClick={() => { const target = groupPickFor; setGroupPickFor(null); void setTodoGroup(target.id, one); }} className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] dark:bg-slate-800">
                  {one}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                data-mtodo-group-new-input
                value={newGroup}
                onChange={(event) => setNewGroup(event.target.value)}
                placeholder="新分组名…"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mtodo-group-new-save
                onClick={() => {
                  const target = groupPickFor;
                  const name = newGroup.trim();
                  setGroupPickFor(null);
                  setNewGroup("");
                  if (target && name) void setTodoGroup(target.id, name);
                }}
                className="rounded-lg bg-indigo-600 px-3 text-[12px] text-white"
              >
                建
              </button>
            </div>
            <button type="button" data-mtodo-group-close onClick={() => setGroupPickFor(null)} className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* 十字待办：挑一条放进来（电脑版是拖，手机上是点） */}
      {pickFor && (
        <div data-mtodo-pick-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setPickFor(null)}>
          <div className="max-h-[70%] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">挑一条放进「{QUADRANTS.find((one) => one.key === pickFor)?.label}」</p>
            {unplaced.length === 0 && <p className="py-2 text-[12px] text-slate-400">没有还没分象限的待办了。</p>}
            {unplaced.map((todo) => (
              <button
                key={todo.id}
                type="button"
                data-mtodo-pick-item={todo.id}
                onClick={() => {
                  const q = pickFor;
                  setPickFor(null);
                  void setTodoQuadrant(todo.id, q);
                }}
                className="w-full border-b border-slate-100 py-2 text-left text-[12.5px] dark:border-slate-800"
              >
                {todo.title}
              </button>
            ))}
            <button type="button" data-mtodo-pick-close onClick={() => setPickFor(null)} className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* 删除二次确认 */}
      {confirmDel && (
        <div data-mtodo-confirm className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6" onClick={() => setConfirmDel(null)}>
          <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] leading-relaxed">删掉「{confirmDel.title}」？删之前会自动留一份档。</p>
            <div className="mt-3 flex gap-2">
              <button type="button" data-mtodo-confirm-del onClick={() => { const one = confirmDel; setConfirmDel(null); void deleteTodo(one.id); }} className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white">
                删除
              </button>
              <button type="button" data-mtodo-confirm-cancel onClick={() => setConfirmDel(null)} className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
