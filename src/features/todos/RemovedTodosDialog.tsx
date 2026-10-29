/**
 * 「来源已移除」待办的处理窗（2026-09-21 按用户要求做，A1 决策）。
 *
 * # 为什么要改成"先看再决定"
 * 原来执行区右上角是个按钮：「来源已移除 N 条 · **清理**」——一点 = 二次确认 = **真删**。
 * "清理"这词读起来像清垃圾，可它们其实是**来源没了、但人可能还没做完的事**：
 * `我一定要学会做饭`、`买牛奶` 就是这么从 `todos.json` 里没的（2026-09-20 真丢过一次，
 * 最后从 4.3 MB 的整包备份里捞回来）。
 *
 * 现在的规矩：
 * 1. **点按钮只是打开这个窗**（文案也从「清理」改成「查看」），一个字节都不删；
 * 2. 先列出来 —— 每条都写清"原来来自哪里"，让人自己判断；
 * 3. 删哪一条、或者全删，都是**单独的动作 + 单独二次确认**；
 * 4. 后端在真删之前会把当前的 `todos.json` 原样留一份到 `backups/`（只留最近 20 份），
 *    所以万一删错了还捞得回来 —— 这句话会写在确认框里。
 */
import Modal from "../../components/Modal";
import type { Todo } from "../types";

interface RemovedTodosDialogProps {
  todos: Todo[];
  onClose: () => void;
  /** 删掉其中一条（调用方负责二次确认 + 落盘） */
  onDeleteOne: (todo: Todo) => void;
  /** 全删（调用方负责二次确认 + 落盘） */
  onDeleteAll: () => void;
  busy?: boolean;
}

/** 来源那一行给人看的字 */
function sourceLabel(todo: Todo): string {
  const { kind, noteId, infoId, markerText } = todo.source;
  if (kind === "note") {
    return `原来自认知区的一篇笔记${markerText ? `（标记「${markerText}」）` : ""}${
      noteId ? "" : " · 连 id 都没记"
    }`;
  }
  if (kind === "info") return `原来自信息区的一条信息${infoId ? "" : " · 连 id 都没记"}`;
  return "手动建的（本来就没有来源）";
}

export default function RemovedTodosDialog({
  todos,
  onClose,
  onDeleteOne,
  onDeleteAll,
  busy,
}: RemovedTodosDialogProps) {
  return (
    <Modal
      title={`来源已移除的待办（${todos.length} 条）`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            data-removed-close
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            先留着
          </button>
          <button
            type="button"
            data-removed-delete-all
            disabled={busy || todos.length === 0}
            onClick={onDeleteAll}
            className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
          >
            全删掉（{todos.length} 条）
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          这些待办的**来源没了**（那条 `-[]` 标记被删掉了，或者整篇笔记 / 整条信息已经不在了），
          但事情本身你可能还没做。**留着完全不影响使用** —— 想删哪条就删哪条。
          真删之前程序会把当前的 `todos.json` 原样存一份到数据目录的 `backups/` 里，删错了还能捞回来。
        </p>

        <ul data-removed-list className="flex flex-col gap-2">
          {todos.map((todo) => (
            <li
              key={todo.id}
              data-removed-item={todo.id}
              className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700"
            >
              <span className="text-slate-400">{todo.status === "done" ? "☑" : "☐"}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-sm ${todo.status === "done" ? "text-slate-400 line-through" : ""}`}>
                  {todo.title}
                </span>
                <span className="truncate text-[11px] text-slate-400">{sourceLabel(todo)}</span>
              </span>
              <button
                type="button"
                data-removed-delete={todo.id}
                disabled={busy}
                onClick={() => onDeleteOne(todo)}
                className="shrink-0 rounded-lg border border-rose-300 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
              >
                删掉这条
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
