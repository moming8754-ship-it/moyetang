/**
 * 十字待办 · 2×2 四象限（M5-5）。
 *
 * PRD §5.3：**重要且紧急 ｜ 不重要但紧急 ｜ 重要但不急 ｜ 都不**；
 * 卡片可从待办集**拖入**某象限（自动记录 `quadrant` 属性），**也能拖回**。
 *
 * 这里只负责画格子：拖拽的命中判定由页面用 `elementFromPoint` +
 * `closest('[data-quadrant]')` 做（整页一个拖动状态，比每个格子各自监听稳得多）。
 * 卡片本身复用待办集那一套（勾选 / 开始 / ⚙ 都在），所以传进来一个 `renderCard`。
 */
import type { ReactNode } from "react";
import type { Quadrant, Todo } from "../types";
import { QUADRANT_LABEL, QUADRANT_ORDER } from "./time";

interface QuadrantBoardProps {
  groups: Record<Quadrant, Todo[]>;
  renderCard: (todo: Todo) => ReactNode;
  /** 拖动时鼠标正压着哪个象限（高亮用） */
  activeQuadrant: Quadrant | null;
  /** 拖动进行中（让空象限也显眼一点，知道可以往里放） */
  dragging: boolean;
  /**
   * #8（2026-10-21）：空格子里那句提示。
   * 执行区里是"把卡片拖进来"；搬到首页后没有拖拽，得换一句（首页那个传自己的）。
   */
  emptyHint?: string;
}


/**
 * 标题前面那个**小圆点**的颜色（D 批，2026-10-04）。
 *
 * 原来靠"整格一圈彩色虚线框"来区分四个象限 —— 一屏四个彩框加待办卡片的框，
 * 框线太多、眼睛没有落点（用户原话："万一这些圆角矩形太多了就会眼瞎"）。
 * 现在四个格子合成**一个网格 + 内部十字线**，颜色缩到标题前面这一个小点。
 */
const DOT: Record<Quadrant, string> = {
  q1: "bg-rose-400",
  q2: "bg-amber-400",
  q3: "bg-sky-400",
  q4: "bg-slate-400",
};

const HINT: Record<Quadrant, string> = {
  q1: "马上做",
  q2: "尽快做",
  q3: "安排着做",
  q4: "有空再说",
};

export default function QuadrantBoard({
  groups,
  renderCard,
  activeQuadrant,
  dragging,
  emptyHint = "把卡片拖进来",
}: QuadrantBoardProps) {
  return (
    <div
      data-quadrant-board
      /* D 批：**一个网格 + 内部十字线**（原来是四个各自带彩色虚线框的圆角卡片） */
      className="grid grid-cols-2 border-l border-t border-slate-200 dark:border-slate-800"
    >
      {QUADRANT_ORDER.map((key) => {
        const quadrant = key as Quadrant;
        const items = groups[quadrant] ?? [];
        const active = activeQuadrant === quadrant;
        return (
          <section
            key={quadrant}
            data-quadrant={quadrant}
            data-quadrant-count={items.length}
            /* ⚠️ 拖拽落点那一套（`data-quadrant` + 高亮）完全没变，只是外观从"虚线框"
               换成"网格 + 拖拽时亮出虚线"（框只在需要它说话的时候出现）。 */
            className={`flex min-h-32 flex-col gap-2 border-b border-r border-slate-200 p-3 transition-colors dark:border-slate-800 ${
              active
                ? "bg-indigo-50/70 outline-2 -outline-offset-2 outline-dashed outline-indigo-400 dark:bg-indigo-500/10"
                : ""
            }`}
          >
            <header className="flex items-baseline justify-between">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[quadrant]}`} />
                {QUADRANT_LABEL[quadrant]}
              </h3>
              <span className="text-[10px] text-slate-400">{HINT[quadrant]}</span>
            </header>

            {items.length === 0 ? (
              <p className="m-auto py-3 text-center text-[11px] text-slate-400">
                {dragging ? "松手放到这里" : emptyHint}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((todo) => (
                  <li key={todo.id}>{renderCard(todo)}</li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
