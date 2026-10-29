/**
 * 待办卡片（M5-2）。
 *
 * 布局照 PRD §5.3 的四角：**左上 标题 ｜ 左下 设定时间 ｜ 右上【开始】｜ 右下 ⚙**，
 * 卡片底部单独一行是**来源标注**（可点击跳回那篇笔记 / 那条信息）。
 *
 * 勾选框想了一下还是放在标题左边：四角已经被 PRD 占满了，而"勾选完成"是
 * 这个页面最常用的动作，藏进 ⚙ 里等于没有。视觉上它仍属于左上那一角。
 *
 * ⚠️ 拖动走的是**自己的指针逻辑**（阈值 5px），不是原生 DnD：
 * 卡片里有按钮、有输入框，原生 DnD 会跟点击打架（M4 在树上踩过一模一样的坑）。
 */
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Modal from "../../components/Modal";
import { formatStamp } from "../../shared/daytime";
import { useData } from "../../store/data";
import type { Quadrant, Todo, TodoRepeat } from "../types";
import { pomodoroEffective } from "../types";
import {
  QUADRANT_LABEL,
  QUADRANT_ORDER,
  dueText,
  focusText,
  fromLocalInput,
  isOverdue,
  toLocalInput,
} from "./time";

/** ⚙ 里那排重复按钮（M9-6）；`value = null` 是"不重复" */
const REPEAT_CHOICES: { value: TodoRepeat | null; label: string }[] = [
  { value: null, label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
];

/**
 * C 批（2026-10-02）：「到期前先提醒我一下」的三档预设。
 *
 * ⚠️ 用户点的方案是**只给三档预设**（不给自定义输入框）—— 少一个输入框、少一处出错。
 * 时间由**前端**按 `dueAt - N 分钟` 算好后交给后端（后端不做时间运算，规则只此一份）。
 */
const EARLY_MINUTES = [10, 30, 60] as const;

/** 卡片上那枚 🔁 徽标写什么 */
const REPEAT_LABEL: Record<TodoRepeat, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
};

export interface TodoActions {
  toggleDone: (todo: Todo, done: boolean) => void;
  setTitle: (todo: Todo, title: string) => void;
  setPlanned: (todo: Todo, plannedAt: string | null) => void;
  /** 设/清截止日期（M9-1）；`null` = 清掉 */
  setDue: (todo: Todo, dueAt: string | null) => void;
  /** 设/清重复规则（M9-6）；`null` = 不重复 */
  setRepeat: (todo: Todo, repeat: TodoRepeat | null) => void;
  /** 子任务（M9-2） */
  addSubtask: (todo: Todo, text: string) => void;
  toggleSubtask: (todo: Todo, subtaskId: string, done: boolean) => void;
  removeSubtask: (todo: Todo, subtaskId: string) => void;
  setQuadrant: (todo: Todo, quadrant: Quadrant | null) => void;
  scheduleRemind: (todo: Todo, fireAt: string, key?: string, note?: string) => void;
  /** C 批：删掉某一条提醒（只删点名那条） */
  deleteReminder: (reminderId: string) => void;
  startPomodoro: (todo: Todo) => void;
  /**
   * v1.15.0：设**这条待办自己的番茄时长**（用户拍板：每条各设各的）。
   *
   * `minutes` = 分钟数（1~999）｜ `null` = **恢复跟随设置里的全局值**。
   */
  setCustomMinutes: (todo: Todo, minutes: number | null) => void;
  /** M15：收进档案库（从执行区挪走，随时能取出） */
  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：`archive` 这个动作 + 那行 `archiveEnabled`
  //    原来在这儿（⚙ 里那颗「收进档案库」用的）—— 那颗按用户要求去掉了，两个都不用了。
  remove: (todo: Todo) => void;
}

interface TodoCardProps {
  todo: Todo;
  actions: TodoActions;
  /** 来源那一行显示什么（标题由页面查好传进来） */
  sourceText: string;
  /** 点来源跳过去；没有可跳的去向时不给 */
  onOpenSource?: () => void;
  /**
   * 来源是不是已经没了。
   *
   * 页面会把两种情况合起来判断：① 后端标了 `sourceRemoved`；
   * ② 那篇笔记 / 那条信息**本身已经不存在了**（M5 之前攒下的老孤儿是没有标记的）。
   */
  sourceRemoved?: boolean;
  /** 正在被拖动（半透明） */
  dragging?: boolean;
  /** 拖动时插到这一张前面（画一条插入线） */
  dropBefore?: boolean;
  /** 从别处跳过来定位到这一条（短暂高亮一下，和信息区那套一致） */
  highlight?: boolean;
  /** 按下卡片（页面据此判断"这是拖动还是点击"） */
  onCardPointerDown?: (event: ReactPointerEvent<HTMLElement>, todo: Todo) => void;
  /** 刚刚拖过一把 —— 这时候的 click 不该当成"点标题编辑" */
  wasDragged?: () => boolean;
  /**
   * D 批（2026-10-04）：点卡片右下角的 ⋮ 打开「移到分组…」。
   *
   * **不传这两个 props 时，卡片上一个多出来的字都没有** —— "已完成"归档区复用同一个卡片，
   * 那边不传（归档区已经有"按完成月份分组"了，再加一层只会乱）。
   */
  onGroupMenu?: () => void;
  /** 「移到分组」小菜单是不是开在这一张上（开着时 ⋮ 高亮） */
  groupMenuOpen?: boolean;
  /** 这张待办现在在哪个分组（只用在 ⋮ 的 tooltip 上） */
  group?: string;
}

export default function TodoCard({
  todo,
  actions,
  sourceText,
  onOpenSource,
  sourceRemoved,
  dragging,
  dropBefore,
  highlight,
  onCardPointerDown,
  wasDragged,
  onGroupMenu,
  groupMenuOpen,
  group,
}: TodoCardProps) {
  const done = todo.status === "done";
  /** M15：启用了「档案区」才显示「收进档案库」（没启用的话档案库没有入口，收进去等于不见了） */
  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：这里原来是
  //    `const archiveEnabled = useData((state) => state.config.archive.enabled);`
  //    —— 那颗「收进档案库」去掉之后就不用了。
  const removed = sourceRemoved ?? todo.source.sourceRemoved === true;
  /** 逾期了没有（M9-1）—— **已完成的不算逾期**：事情做完了就别再催 */
  const overdue = !done && isOverdue(todo.dueAt);
  /** 子任务进度（M9-2） */
  const subtasks = todo.subtasks ?? [];
  const subtasksDone = subtasks.filter((sub) => sub.done).length;
  const allSubtasksDone = subtasks.length > 0 && subtasksDone === subtasks.length;
  /**
   * 这条待办累计**有效**专注多少秒（M9-3 起；M13-B 改成"有效"）：
   * 作废的那次算 0，锁屏/休眠暂停掉的那段扣掉 —— 没中断过时和原来一模一样。
   */
  const focusSeconds = todo.pomodoros.reduce((sum, one) => sum + pomodoroEffective(one), 0);
  /** M13-B：最近一次被打断的番茄（「⚠ 中断 N 次」那个记号用它的次数） */
  const lastInterrupted = [...todo.pomodoros]
    .reverse()
    .find((one) => (one.interruptedTimes ?? 0) > 0);
  /** M13-B：这条待办一共作废过几次（作废也要留痕，所以这里单独数） */
  const voidedCount = todo.pomodoros.filter((one) => one.voided).length;
  /**
   * C 批（2026-10-02）：**这条待办现在排着哪些提醒**（多条）。
   *
   * ⚠️ 真源是 `reminders.json`（经 store 的 `reminders` 拿到），**不是** `todo.reminderAt` ——
   * 那个字段现在只留"最靠前的那条"，多条提醒它记不下（见后端 `todo_schedule_remind` 的注释）。
   */
  const allReminders = useData((s) => s.reminders);
  const myReminders = allReminders
    .filter((one) => one.kind === "todo-remind" && one.refId === todo.id && one.status === "pending")
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);
  const [panel, setPanel] = useState(false);
  const [plannedDraft, setPlannedDraft] = useState(() => toLocalInput(todo.plannedAt));
  const [dueDraft, setDueDraft] = useState(() => toLocalInput(todo.dueAt));
  /** 子任务输入框里正在打的东西（还没提交） */
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [remindDraft, setRemindDraft] = useState("");
  /** v1.15.0：⚙ 里"番茄时长"那一行正在输入的数字（还没提交） */
  const [customMinutesDraft, setCustomMinutesDraft] = useState("");
  /** 设置里的全局番茄时长（这条待办没自己设过时，面板与提示都用它） */
  const globalFocusMinutes = useData((state) => state.config.focus.customMinutes);
  const committed = useRef(false);

  const startEdit = () => {
    setDraft(todo.title);
    committed.current = false;
    setEditing(true);
  };

  /** 提交标题：空标题不接受（原样退回，别把待办弄成没名字的） */
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next && next !== todo.title) actions.setTitle(todo, next);
  };

  const openPanel = () => {
    setPlannedDraft(toLocalInput(todo.plannedAt));
    setDueDraft(toLocalInput(todo.dueAt));
    setRemindDraft("");
    setCustomMinutesDraft("");
    setPanel(true);
  };

  /**
   * v1.15.0：把 ⚙ 里输入的分钟数提交上去。
   *
   * 只认 **1~999 的整数**（跟后端 `store::todo::set_custom_minutes` 的把关一致）：
   * 越界就当没输（清空输入框），绝不把 0 / 1000 这种值发出去 ——
   * 界面上"0 或空"表达的是**恢复跟随设置**，那是另一个按钮的事。
   */
  const commitCustomMinutes = () => {
    const value = Math.round(Number(customMinutesDraft));
    if (!Number.isFinite(value) || value < 1 || value > 999) {
      setCustomMinutesDraft("");
      return;
    }
    actions.setCustomMinutes(todo, value);
    setCustomMinutesDraft("");
  };

  return (
    <>
      <div
        data-todo-id={todo.id}
        data-todo-title={todo.title}
        data-todo-done={done ? "1" : "0"}
        data-todo-quadrant={todo.quadrant ?? ""}
        data-todo-source={todo.source.kind}
        data-todo-source-removed={removed ? "1" : "0"}
        onPointerDown={(event) => onCardPointerDown?.(event, todo)}
        className={`relative flex flex-col gap-2 border-l-2 px-3 py-2.5 transition-colors ${
          /* D 批（2026-10-04）：**线分层** —— 卡片不再各包一个圆角框（一屏十几个框会眼瞎），
             改成"贴身行 + 行间细线（父级 `divide-y`）+ 左侧色条表达状态"：
             逾期 = 玫瑰色条；跳转定位 = 琥珀色条 + 浅底 + 一圈琥珀环（那一圈是**临时**的，
             几秒后自己消失 —— "框只在需要它说话的时候出现"）；其余 = 透明条 + 悬停浅底。
             ⚠️ `data-todo-*` 那一串钩子一个没动（验收脚本全靠它们）。 */
          !done && overdue
            ? "border-l-rose-400"
            : highlight
              ? "border-l-amber-400"
              : "border-l-transparent"
        } ${
          highlight
            ? "bg-amber-50/70 ring-2 ring-amber-400 ring-offset-1 dark:bg-amber-500/10"
            : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
        } ${done ? "opacity-70" : ""} ${dragging ? "opacity-40" : ""} ${
          dropBefore ? "ring-2 ring-indigo-400 ring-offset-1" : ""
        }`}
      >
        {/* 上排：左上 勾选框 + 标题 ｜ 右上【开始】 */}
        <div className="flex items-start gap-2">
          <button
            type="button"
            data-todo-check={todo.id}
            title={done ? "取消完成" : "标为完成"}
            aria-checked={done}
            role="checkbox"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              actions.toggleDone(todo, !done);
            }}
            className={`mt-0.5 shrink-0 rounded px-1 text-base leading-5 ${
              done
                ? "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10"
                : "text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            {done ? "☑" : "☐"}
          </button>

          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                // 进编辑态时**把旧名字整段选中**：否则光标落在末尾，一打字就变成"旧名新名"接在一起
                // （2026-09-26 用户就是被这个绊了一下，以为是"改不了名字"）
                onFocus={(event) => event.currentTarget.select()}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    commit();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    committed.current = true; // Esc = 放弃，别让随后的 blur 又提交一次
                    setEditing(false);
                  }
                }}
                className="w-full rounded-md border border-indigo-300 bg-white px-2 py-0.5 text-sm outline-none dark:border-indigo-500 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
              />
            ) : (
              <button
                type="button"
                data-todo-title-btn={todo.id}
                // M11 前置（2026-09-26，方案①）：笔记来源的待办**照样能在执行区改名** ——
                // 改完名字就归执行区（后端 `TodoSource::renamed` 记一笔，笔记同步不再覆盖它）。
                title="点一下改标题"
                onClick={(event) => {
                  event.stopPropagation();
                  if (wasDragged?.()) return; // 刚拖过一把，不算点击
                  startEdit();
                }}
                className={`block w-full truncate text-left text-sm ${
                  done ? "text-slate-400 line-through dark:text-slate-500" : ""
                }`}
              >
                {todo.title}
              </button>
            )}
          </div>

          <button
            type="button"
            data-todo-start={todo.id}
            title="开始番茄钟（正计时 / 倒计时 / 不计时）"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              actions.startPomodoro(todo);
            }}
            className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
          >
            ▶ 开始
          </button>
        </div>

        {/* 下排：左下 设定时间 ｜ 右下 ⚙ */}
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <button
            type="button"
            data-todo-planned={todo.id}
            title="设定时间（今日时间轴按它排）"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPanel();
            }}
            className="rounded px-1 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            🕐 {todo.plannedAt ? formatStamp(todo.plannedAt) : "没设时间"}
          </button>

          {/* 截止日期（M9-1）：**逾期就标红**，而且只在没完成时才红（完成了就不催了） */}
          {todo.dueAt && (
            <button
              type="button"
              data-todo-due={todo.id}
              data-todo-overdue={overdue ? "1" : "0"}
              title={
                overdue
                  ? `已逾期：截止 ${formatStamp(todo.dueAt)}（点它去 ⚙ 里改）`
                  : `截止 ${formatStamp(todo.dueAt)}（点它去 ⚙ 里改）`
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                openPanel();
              }}
              className={`rounded px-1 ${
                overdue
                  ? "bg-rose-50 font-medium text-rose-600 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25"
                  : "hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              ⏳ {dueText(todo.dueAt)}
            </button>
          )}

          {/* 重复（M9-6）：有规则就标出来，不然用户不知道勾完为什么会自己多一条 */}
          {todo.repeat && (
            <button
              type="button"
              data-todo-repeat-badge={todo.id}
              data-todo-repeat={todo.repeat}
              title={`${REPEAT_LABEL[todo.repeat]}重复：做完这条会自动派下一条（点它去 ⚙ 里改）`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                openPanel();
              }}
              className="rounded bg-violet-50 px-1 text-violet-600 hover:bg-violet-100 dark:bg-violet-500/15 dark:text-violet-300 dark:hover:bg-violet-500/25"
            >
              🔁 {REPEAT_LABEL[todo.repeat]}
            </button>
          )}

          {/* 已经排进某个象限的，在待办集里也标一下（B3：两边都显示，得让人知道它在哪儿） */}
          {todo.quadrant && (
            <span
              data-todo-quadrant-badge={todo.id}
              title="它也在下面的四象限里"
              className="rounded bg-indigo-50 px-1 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
            >
              {QUADRANT_LABEL[todo.quadrant]}
            </span>
          )}

          {todo.reminderAt && (
            <span data-todo-remind-at={todo.id} className="text-amber-600 dark:text-amber-400">
              ⏰ {formatStamp(todo.reminderAt)}
            </span>
          )}

          {todo.pomodoros.length > 0 && (
            <span
              data-todo-pomodoro-count={todo.id}
              data-todo-focus-seconds={focusSeconds}
              data-todo-voided-count={voidedCount}
              title={`番茄钟记录 ${todo.pomodoros.length} 次，累计有效专注 ${focusText(focusSeconds)}${
                voidedCount > 0 ? `（其中 ${voidedCount} 次作废）` : ""
              }`}
              className="text-rose-500 dark:text-rose-400"
            >
              🍅 {todo.pomodoros.length}
              {focusSeconds > 0 && ` · ${focusText(focusSeconds)}`}
            </span>
          )}

          {/* M13-B：被打断过的记号（用户 2026-09-26 选的花样带次数）
              ⚠️ 只在"作废 / 有疑似离开"的番茄上出现，没被打断过的待办一个多余的字都没有 */}
          {lastInterrupted && (
            <span
              data-todo-interrupted={todo.id}
              data-todo-interrupted-times={lastInterrupted.interruptedTimes ?? 0}
              title={`最近一次（${lastInterrupted.at.slice(0, 16).replace("T", " ")}）疑似离开 ${focusText(
                lastInterrupted.interruptedSeconds ?? 0,
              )}${lastInterrupted.voided ? " · 已作废" : " · 已计入"}${
                voidedCount > 0 ? `；共作废 ${voidedCount} 次` : ""
              }`}
              className="text-amber-600 dark:text-amber-400"
            >
              ⚠ 中断 {lastInterrupted.interruptedTimes ?? 1} 次
            </span>
          )}

          <button
            type="button"
            data-todo-gear={todo.id}
            title="设置：分类 / 再次设定时间提醒 / 删除"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPanel();
            }}
            className="ml-auto rounded px-1.5 py-0.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ⚙
          </button>

          {/* D 批：移到分组（**只在页面传了 onGroupMenu 时才出现** —— 归档区不传） */}
          {onGroupMenu && (
            <button
              type="button"
              data-todo-group-btn={todo.id}
              title={group ? `移到分组…（现在在「${group}」）` : "移到分组…"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onGroupMenu();
              }}
              className={`rounded px-1.5 py-0.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${
                groupMenuOpen ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100" : ""
              }`}
            >
              ⋮
            </button>
          )}
        </div>

        {/* 子任务进度（M9-2）：有子任务才显示；点它直接开 ⚙ 去勾 */}
        {subtasks.length > 0 && (
          <button
            type="button"
            data-todo-subtask-progress={todo.id}
            data-todo-subtask-done={subtasksDone}
            data-todo-subtask-total={subtasks.length}
            title="点它去 ⚙ 里勾子任务"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openPanel();
            }}
            className="flex w-full items-center gap-2 rounded px-1 text-left text-[11px] text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <span className={allSubtasksDone ? "text-emerald-600 dark:text-emerald-400" : ""}>
              ☑ {subtasksDone}/{subtasks.length}
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <span
                className={`block h-full rounded-full ${
                  allSubtasksDone ? "bg-emerald-500" : "bg-indigo-500"
                }`}
                style={{ width: `${Math.round((subtasksDone / subtasks.length) * 100)}%` }}
              />
            </span>
          </button>
        )}

        {/* 底部：来源标注（PRD 5.3） */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-1.5 text-[11px] dark:border-slate-800">
          {onOpenSource ? (
            <button
              type="button"
              data-todo-source-link={todo.id}
              title="点它跳回来源"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpenSource();
              }}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 hover:bg-indigo-100 hover:text-indigo-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-300"
            >
              {sourceText} →
            </button>
          ) : (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {sourceText}
            </span>
          )}

          {removed && (
            <span
              data-todo-source-removed-tag={todo.id}
              title="认知区里那条 -[] 标记已经被删掉了。这条待办不会被自动删掉，你可以自己决定留还是删。"
              className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            >
              来源已移除
            </span>
          )}

          {todo.quadrant && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {QUADRANT_LABEL[todo.quadrant]}
            </span>
          )}
        </div>
      </div>

      {panel && (
        <Modal title={`待办设置 · ${todo.title}`} onClose={() => setPanel(false)}>
          <div className="flex flex-col gap-5">
            {/* 设定时间 */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">设定时间</h3>
              <p className="mt-0.5 text-[11px] text-slate-400">
                设了时间的待办会出现在左侧「今日时间轴」上（只排今天）。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="datetime-local"
                  data-todo-planned-input
                  value={plannedDraft}
                  onChange={(event) => setPlannedDraft(event.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:bg-slate-800"
                />
                <button
                  type="button"
                  data-todo-planned-save
                  onClick={() => {
                    actions.setPlanned(todo, fromLocalInput(plannedDraft));
                    setPanel(false);
                  }}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  保存
                </button>
                <button
                  type="button"
                  data-todo-planned-clear
                  onClick={() => {
                    actions.setPlanned(todo, null);
                    setPlannedDraft("");
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  清掉
                </button>
              </div>
            </section>

            {/* 截止日期（M9-1）：和"设定时间"分开两栏 —— 它们是两件事 */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                截止日期（最晚什么时候得做完）
              </h3>
              <p className="mt-1 text-[11px] text-slate-400">
                过了这个点卡片上会标红「逾期」。跟上面的「设定时间」是两回事：那个是"打算什么时候做"。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  data-todo-due-input
                  type="datetime-local"
                  value={dueDraft}
                  onChange={(event) => setDueDraft(event.target.value)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="button"
                  data-todo-due-save
                  onClick={() => actions.setDue(todo, fromLocalInput(dueDraft))}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  保存
                </button>
                <button
                  type="button"
                  data-todo-due-clear
                  onClick={() => {
                    actions.setDue(todo, null);
                    setDueDraft("");
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  清掉
                </button>
              </div>
            </section>

            {/* 重复（M9-6）：勾完自动派下一条 */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">重复</h3>
              <p className="mt-1 text-[11px] text-slate-400">
                设了重复之后，**勾完这一条会自动多出一条下一次的**：时间往后推、子任务重新来一遍、
                状态回到未完成。漏掉的几次不会补出来（补出来只是一堆逾期）。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-todo-repeat-group={todo.id}>
                {REPEAT_CHOICES.map((choice) => {
                  const active = (todo.repeat ?? null) === choice.value;
                  return (
                    <button
                      key={choice.value ?? "none"}
                      type="button"
                      data-todo-repeat-set={choice.value ?? "none"}
                      data-todo-repeat-active={active ? "1" : "0"}
                      onClick={() => actions.setRepeat(todo, choice.value)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs ${
                        active
                          ? "bg-indigo-600 font-medium text-white"
                          : "border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                      }`}
                    >
                      {choice.label}
                    </button>
                  );
                })}
              </div>
              {todo.repeatFrom && (
                <p data-todo-repeat-from={todo.repeatFrom} className="mt-1 text-[11px] text-slate-400">
                  它是上一次做完之后自动派出来的（取消那边那条的完成状态不会把它撤掉）。
                </p>
              )}
            </section>

            {/* 子任务（M9-2）：勾、删、加 */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                子任务（{subtasksDone}/{subtasks.length}）
              </h3>
              {subtasks.length === 0 ? (
                <p className="mt-1 text-[11px] text-slate-400">
                  把这件事拆成几步，卡片上就会显示进度（比如 `2/5`）。
                </p>
              ) : (
                <ul data-subtask-list className="mt-2 flex flex-col gap-1">
                  {subtasks.map((sub) => (
                    <li key={sub.id} data-subtask={sub.id} className="flex items-center gap-2">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          data-subtask-check={sub.id}
                          checked={sub.done}
                          onChange={(event) =>
                            actions.toggleSubtask(todo, sub.id, event.target.checked)
                          }
                          className="shrink-0"
                        />
                        <span
                          className={`min-w-0 flex-1 truncate text-xs ${
                            sub.done ? "text-slate-400 line-through" : ""
                          }`}
                        >
                          {sub.text}
                        </span>
                      </label>
                      <button
                        type="button"
                        data-subtask-remove={sub.id}
                        title="删掉这一步"
                        onClick={() => actions.removeSubtask(todo, sub.id)}
                        className="shrink-0 rounded px-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex items-center gap-2">
                <input
                  data-subtask-input
                  value={subtaskDraft}
                  onChange={(event) => setSubtaskDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && subtaskDraft.trim()) {
                      actions.addSubtask(todo, subtaskDraft.trim());
                      setSubtaskDraft("");
                    }
                  }}
                  placeholder="加一步…（回车）"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="button"
                  data-subtask-add
                  disabled={!subtaskDraft.trim()}
                  onClick={() => {
                    actions.addSubtask(todo, subtaskDraft.trim());
                    setSubtaskDraft("");
                  }}
                  className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                >
                  加
                </button>
              </div>
            </section>

            {/* 调整分类（四象限） */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                调整分类
              </h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-todo-quadrant-btn="none"
                  onClick={() => actions.setQuadrant(todo, null)}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${
                    todo.quadrant
                      ? "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                      : "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                  }`}
                >
                  不分
                </button>
                {QUADRANT_ORDER.map((key) => (
                  <button
                    key={key}
                    type="button"
                    data-todo-quadrant-btn={key}
                    onClick={() => actions.setQuadrant(todo, key as Quadrant)}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      todo.quadrant === key
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                        : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                    }`}
                  >
                    {QUADRANT_LABEL[key]}
                  </button>
                ))}
              </div>
            </section>

            {/* v1.15.0：这条待办自己的番茄时长（用户拍板 B：每条各设各的，没设就跟随设置） */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                番茄时长
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-400" data-todo-custom-minutes={todo.id}>
                {todo.customMinutes
                  ? `这条用 ${todo.customMinutes} 分钟（点「▶ 开始」就用它）`
                  : `跟随设置（${globalFocusMinutes} 分钟）`}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  data-todo-custom-minutes-input
                  inputMode="numeric"
                  value={customMinutesDraft}
                  onChange={(event) =>
                    setCustomMinutesDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitCustomMinutes();
                  }}
                  placeholder={`${todo.customMinutes ?? globalFocusMinutes}`}
                  className="w-16 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <span className="text-[11px] text-slate-400">分钟（1~999）</span>
                <button
                  type="button"
                  data-todo-custom-minutes-save
                  disabled={!customMinutesDraft}
                  onClick={commitCustomMinutes}
                  className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  设成这个
                </button>
                {todo.customMinutes ? (
                  <button
                    type="button"
                    data-todo-custom-minutes-reset
                    onClick={() => actions.setCustomMinutes(todo, null)}
                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    恢复跟随设置
                  </button>
                ) : null}
              </div>
            </section>

            {/* 再次设定时间提醒 */}
            <section>
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                再次设定时间提醒
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-400">
                觉得这件事还得再做一遍 / 还没结束 → 挑个时间，到点会在「首页动态区」出现。
                <br />
                <b>C 批起可以排好几条</b>（同一个时间点是改、不同时间点各留一条），能一条条删。
              </p>

              {/* ───── 已经排着的提醒（C 批：多条 + 一条条删）───── */}
              <ul className="mt-2 flex flex-col gap-1" data-todo-remind-list>
                {myReminders.length === 0 && (
                  <li className="text-[11px] text-slate-400">还没排提醒</li>
                )}
                {myReminders.map((one) => (
                  <li
                    key={one.id}
                    data-todo-remind-item={one.id}
                    className="flex items-center gap-2 rounded-lg bg-amber-50 px-2 py-1 text-[11.5px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
                  >
                    <span className="font-mono">{formatStamp(one.fireAt)}</span>
                    {one.payload.note && <span className="text-amber-700/80">{one.payload.note}</span>}
                    <button
                      type="button"
                      data-todo-remind-delete={one.id}
                      title="删掉这一条（同一条待办的其他提醒不动）"
                      onClick={() => actions.deleteReminder(one.id)}
                      className="ml-auto rounded px-1.5 text-amber-700 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>

              <div className="mt-2 flex items-center gap-2">
                <input
                  type="datetime-local"
                  data-todo-remind-input
                  value={remindDraft}
                  onChange={(event) => setRemindDraft(event.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:bg-slate-800"
                />
                <button
                  type="button"
                  data-todo-remind-save
                  disabled={!remindDraft}
                  onClick={() => {
                    const fireAt = fromLocalInput(remindDraft);
                    if (!fireAt) return;
                    actions.scheduleRemind(todo, fireAt);
                    setRemindDraft("");
                  }}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  加一条提醒
                </button>
              </div>

              {/* ───── C 批：到期前先提醒我一下（三档预设，没填截止日期就说明一下）───── */}
              <div className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
                <p className="text-[11px] text-slate-400">
                  到期前先提醒我一下{todo.dueAt ? "" : "（要先在上面填「截止日期」）"}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {EARLY_MINUTES.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      data-todo-remind-early={minutes}
                      disabled={!todo.dueAt}
                      onClick={() => {
                        const due = new Date(todo.dueAt!);
                        const at = new Date(due.getTime() - minutes * 60_000);
                        if (at.getTime() <= Date.now()) {
                          // 提前提醒的时间点已经过去了 —— 不静默失败，给一句人话
                          actions.scheduleRemind(todo, due.toISOString());
                          return;
                        }
                        actions.scheduleRemind(
                          todo,
                          at.toISOString(),
                          `early:${minutes}`,
                          `提前 ${minutes} 分钟`,
                        );
                      }}
                      className="rounded-lg border border-amber-300 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100 disabled:opacity-40 dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/10"
                    >
                      提前 {minutes} 分钟
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：⚙ 里那颗「收进档案库」
                **也按用户要求去掉了**（档案区的入口只留两处：认知区笔记的行菜单 ＋ 档案库的「＋ 新建」）。 */}

            {/* 删除 */}
            <section className="border-t border-slate-200 pt-4 dark:border-slate-800">
              <button
                type="button"
                data-todo-delete={todo.id}
                onClick={() => {
                  actions.remove(todo);
                  setPanel(false);
                }}
                className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
              >
                删除这条待办
              </button>
              <p className="mt-1 text-[11px] text-slate-400">
                会再问一次。删掉之后 `todos.json` 的上一版还在 `.bak` 里。
              </p>
            </section>
          </div>
        </Modal>
      )}
    </>
  );
}
