/**
 * 手机端树状图画布（P2-B′ 起，2026-10-06；**树 B 起可编辑**）。
 *
 * 用户点名（原话）：手机那棵树「完全不是小米思维笔记、也不是电脑版的布局，是自己设计了新树；
 * 最基础的应该是**主题节点在左、树向右侧生长**」。所以这里跟 `features/tree/layout.ts` 同一套算法：
 * 根在左 · 子节点逐层向右 · **同层左边缘对齐** · 父子连线（手机用**小米括号式** `bracketPath`）·
 * `text-[13px] leading-[22px]`（**字号全项目统一，手机上缩的是间距不是字**）·
 * 联动节点左紫边 +〔联动信息〕· 有图显示缩略图 · **长文字绝不截断** · 空节点显示占位文字。
 *
 * 手机特有的四件事：
 * ① 间距比桌面紧（40 / 12 / 16）；
 * ② 树比屏幕宽 → **左右拖动**看右边（不自动把字缩小）；缩放是用户主动的（双指 / 滚轮 / 控件）；
 * ③ 折起来的节点显示 `+N`，**点开只影响本次查看**（纯本地状态，不写盘）；
 * ④ **树 B（2026-10-06）**：节点是**纯文字**（没有卡片框，照小米那页）· 点一下选中 · 再点一下就地改字 ·
 *    长按 350ms 拖走（松手落在谁身上就当谁的子节点）。
 *
 * ⚠️ 看/改**共用这一份画布**，不另抄一份：抄了就会"两边慢慢长歪"（布局算法尤其明显）。
 *    不传 `onSelect` 那一串 = 老样子（只看不改）。
 * ⚠️ 改树的写盘**只走操作式命令**（`note_tree_*`）：这里**不许**自己拼一棵新树写回去
 *    —— 那是 P0-1 红线（用正文重建 root 会把另一端的节点抹掉）。
 *
 * # 验收抓手（别改名，`tools\m19` 依赖）
 * `data-mctree-box` · `data-mctree-canvas` · `data-mctree-node`(+`-depth`/`-selected`) · `data-mctree-edge`
 * `data-mctree-more` · `data-mctree-empty-text` · `data-mctree-link-badge` · `data-mctree-fit` · `data-mctree-zoom`
 * `data-mctree-edit`（就地改字的输入框）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_NODE_TEXT,
  bracketPath,
  clampScale,
  hitTest,
  layoutTree,
  screenToWorld,
  zoomAt,
  type LayoutNode,
  type Viewport,
} from "../../features/tree/layout";
import { AssetImage } from "../../components/AssetImage";
import type { TreeNode } from "../../features/types";

/** 手机版间距：比桌面（72 / 16 / 32）紧 —— **动的是间距，不是字号** */
export const MOBILE_LAYOUT = { gapX: 40, gapY: 12, pad: 16 };
/** 画布高度：屏上这一块固定这么高，树在里头自己拖 */
const BOX_H = 300;
/** 按住多久算"长按拖动"（小米那种手感：350ms） */
const LONG_PRESS_MS = 350;

/** `maybeChild` 是不是 `ancestorId` 的子孙（拖拽时不许把节点拖进自己的子树 —— 后端也会挡，界面别先骗人） */
function isDescendant(root: TreeNode, ancestorId: string, maybeChild: string): boolean {
  const walk = (node: TreeNode): boolean => {
    if (node.id === ancestorId) {
      const inside = (one: TreeNode): boolean => {
        if (one.id === maybeChild) return true;
        return (one.children ?? []).some(inside);
      };
      return (node.children ?? []).some(inside);
    }
    return (node.children ?? []).some(walk);
  };
  return walk(root);
}

/** 数一棵子树有多少节点（含自己）—— 卡片右上角那颗「+N」与标题上的总数都用它 */
export function countNodes(node: TreeNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/**
 * 本地展开过的节点 → 造一份「折叠位被翻开」的树副本。
 * 只动 `collapsed` 这一个字段，**不碰任何数据**（纯渲染用）。
 *
 * ⚠️ 2026-10-06 修过一个真 bug：这里原本有个"没变化就别复制"的提前返回，
 *    但它只看了**直接子节点** —— 要展开的节点在第 2 层时，根节点会提前 return，
 *    整棵子树都没被走过 → **点「+N」什么都不会发生**（套件里表现为"点了没展开"）。
 *    现在改成：先递归到底，**只有真的一个字段都没变**才复用原对象。
 */
function withOpened(node: TreeNode, open: Record<string, boolean>): TreeNode {
  const collapsed = open[node.id] ? false : node.collapsed;
  const kids = node.children.map((child) => withOpened(child, open));
  const kidsChanged = kids.some((kid, index) => kid !== node.children[index]);
  if (collapsed === node.collapsed && !kidsChanged) return node;
  return { ...node, collapsed, children: kids };
}

interface TreeCanvasMobileProps {
  root: TreeNode;
  /** 点〔联动信息〕小标 → 跳回信息区（外层负责） */
  onOpenInfo?: (infoId: string) => void;
  /**
   * 树 B（2026-10-06）：**整屏页**才传下面这些 —— 不传就是老样子（只看不改）。
   * ⚠️ 看/改同一份画布，是为了不让"布局算法"被抄成两份（抄一份就会慢慢长歪）。
   */
  selectedId?: string | null;
  /** 点一下节点（第一次）→ 选中；点空白 → 取消选中 */
  onSelect?: (nodeId: string | null) => void;
  /** 再点一下**已选中**的节点 → 就地改文字 */
  onEditRequest?: (nodeId: string) => void;
  editingId?: string | null;
  onCommitText?: (nodeId: string, text: string) => void;
  /** 每敲一下报一次当前文字（父级用它做「底排按钮动手前先落盘」，见 `TreePageMobile` 的 `flushEdit`） */
  onDraftChange?: (nodeId: string, text: string) => void;
  onCancelEdit?: () => void;
  /** 长按拖动松手：把 `nodeId` 挂到 `targetId` 下面（小米那种"拖到谁身上就当它的子节点"） */
  onMoveNode?: (nodeId: string, targetId: string) => void;
  /**
   * 点节点里的缩略图 → 看大图（外层挂 `ImageViewer`）。
   *
   * 🔴 2026-10-07 补（用户报「手机版树状图导入图片后无法看见全图」）：
   *    节点里那张缩略图只有 46px 高，**点不开大图＝等于看不到图本身**；
   *    电脑版 `NodeThumb` 一直是「点缩略图看大图」，手机端这版漏了。
   */
  onOpenImage?: (relPath: string) => void;
  /** 高度：整屏页给 `flex-1`（父容器管高度）；不传就用画布老高度 300 */
  fill?: boolean;
}

export default function TreeCanvasMobile({
  root,
  onOpenInfo,
  selectedId = null,
  onSelect,
  onEditRequest,
  editingId = null,
  onCommitText,
  onDraftChange,
  onCancelEdit,
  onMoveNode,
  onOpenImage,
  fill = false,
}: TreeCanvasMobileProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<Viewport>({ tx: 0, ty: 0, k: 1 });
  /** 正在被拖走的节点（长按进入）＋ 手指当前在世界坐标里的位置 */
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 松手会挂到谁身上（高亮它） */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const shaped = useMemo(() => withOpened(root, open), [root, open]);
  const layout = useMemo(() => layoutTree(shaped, MOBILE_LAYOUT), [shaped]);

  // 换笔记 → 视口与本地展开都归位
  useEffect(() => {
    setView({ tx: 0, ty: 0, k: 1 });
    setOpen({});
  }, [root.id]);

  // ── 拖动 / 双指缩放（手机）＋ 滚轮缩放（电脑上预览手机界面时用） ──
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; k: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      dragStart.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      dragStart.current = null;
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const pinch = pinchStart.current;
    if (pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = pinch.dist > 0 ? dist / pinch.dist : 1;
      setView((current) => ({ ...current, k: clampScale(pinch.k * ratio) }));
      return;
    }

    const start = dragStart.current;
    if (!start) return;
    setView({
      tx: start.tx + (event.clientX - start.x),
      ty: start.ty + (event.clientY - start.y),
      k: view.k,
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) dragStart.current = null;
    // 点**空白**（没怎么动）= 取消选中。
    // ⚠️ 点在节点上的那次手势被节点的 `pointerdown` 拦住了，走不到这里；
    //    缩放控件那几个按钮也自己 stopPropagation（不然点一下就把选中弄丢）。
    if (
      start &&
      !dragging &&
      Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) < 8
    ) {
      onSelect?.(null);
    }
  };

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (event: WheelEvent) => {
      // 反馈·1022 #3：跟电脑树画布同一条规矩 —— **Ctrl+滚轮才缩放**（这条分支只在
      // 电脑上预览手机界面时走得到；真机是双指缩放，不经过这里）。
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((current) =>
        zoomAt(current, current.k * factor, event.clientX - rect.left, event.clientY - rect.top),
      );
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  /** 适应宽度：间距已经是最紧的了，所以这里只做「缩放归 1 + 横向归零」（**不缩字号**） */
  const fit = () => setView({ tx: 0, ty: 0, k: 1 });
  const expand = (id: string) => setOpen((prev) => ({ ...prev, [id]: true }));

  /**
   * 细胞坐标：屏幕坐标（clientX/Y）→ 画布里的世界坐标。
   * 拖动落点判定要靠它 —— 拿的是画布自己的 rect，不是窗口的。
   */
  const toWorld = (clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToWorld(view, clientX - rect.left, clientY - rect.top);
  };

  /** 手指底下的节点是谁（跳过被拖的那个 —— 不然它会一直命中自己） */
  const nodeAt = (clientX: number, clientY: number, skipId: string): string | null => {
    const world = toWorld(clientX, clientY);
    const hit = hitTest(layout, world.x, world.y);
    if (!hit) return null;
    const id = hit.node.id;
    if (id === skipId) return null;
    if (isDescendant(shaped, skipId, id)) return null;
    return id;
  };

  return (
    <div
      ref={boxRef}
      data-mctree-box
      // 验收抓手：拖动过程中**应用自己算出来的**世界坐标与落点（出问题时一眼看出是哪一步不对）
      data-mctree-drag={dragging ? `${Math.round(dragging.x)},${Math.round(dragging.y)}` : ""}
      data-mctree-drop={dropTarget ?? ""}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={
        "relative touch-none overflow-hidden bg-white dark:bg-slate-900 " +
        (fill
          ? "h-full w-full"
          : "rounded-xl border border-slate-200 dark:border-slate-700")
      }
      style={fill ? undefined : { height: BOX_H }}
    >
      <div
        data-mctree-canvas
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: layout.width,
          height: layout.height,
          transformOrigin: "0 0",
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
        }}
      >
        {/* 连线：颜色走 currentColor（跟电脑版一样）→ 主题 / 深色模式自动跟着变 */}
        <svg
          className="absolute left-0 top-0 overflow-visible text-slate-300 dark:text-slate-700"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map((one) => (
            <path
              key={one.from + ">" + one.to}
              data-mctree-edge
              d={bracketPath(one)}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            />
          ))}
        </svg>

        {layout.nodes.map((node) => (
          <Card
            key={node.id}
            node={node}
            onExpand={expand}
            onOpenInfo={onOpenInfo}
            selected={selectedId === node.id}
            editing={editingId === node.id}
            dropTarget={dropTarget === node.id}
            dragging={dragging?.id === node.id}
            onSelect={onSelect}
            onEditRequest={onEditRequest}
            onCommitText={onCommitText}
            onDraftChange={onDraftChange}
            onCancelEdit={onCancelEdit}
            onOpenImage={onOpenImage}
            onDragStart={(id) => {
              onCancelEdit?.();
              const node = layout.nodes.find((one) => one.id === id);
              setDragging({ id, x: node?.x ?? 0, y: node?.y ?? 0 });
            }}
            onDragMove={(id, clientX, clientY) => {
              const world = toWorld(clientX, clientY);
              setDragging({ id, x: world.x, y: world.y });
              setDropTarget(onMoveNode ? nodeAt(clientX, clientY, id) : null);
            }}
            onDragEnd={(id, clientX, clientY) => {
              const target = onMoveNode ? nodeAt(clientX, clientY, id) : null;
              setDragging(null);
              setDropTarget(null);
              if (target && onMoveNode) onMoveNode(id, target);
            }}
          />
        ))}
      </div>

      {/* 右上角：适应宽度 + 当前缩放 */}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <button
          type="button"
          data-mctree-fit
          onPointerDown={(event) => event.stopPropagation()}
          onClick={fit}
          className="rounded-lg border border-slate-200 bg-white/90 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-300"
        >
          适应宽度
        </button>
        <span
          data-mctree-zoom
          className="rounded-lg border border-slate-200 bg-white/90 px-2 py-1 text-[11px] tabular-nums text-slate-400 dark:border-slate-700 dark:bg-slate-800/90"
        >
          {Math.round(view.k * 100)}%
        </span>
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[10.5px] text-slate-400">
        左右拖动看右边 · 双指可缩放
      </p>
    </div>
  );
}

/**
 * 一个节点（**小米思维笔记那种纯文字节点**：没有卡片框、没有背景块）。
 *
 * 交互（树 B，2026-10-06）：
 * - **点一下** → 选中（选中才亮底，平时干净）；
 * - **再点一下** → 就地改文字（节点上盖一个输入框，回车/失焦提交、Esc 取消）；
 * - **长按 350ms 不动** → 把它拖走，松手落在谁身上就当谁的子节点（落点那块会画虚线框）。
 *
 * ⚠️ 为什么 `pointerdown` 要 `stopPropagation`：画布本身用 pointer 事件做**平移**，
 *    不拦住的话"按在节点上想选中"会被当成"拖画布"，节点永远点不动（电脑版踩过同类坑）。
 */
function Card({
  node,
  onExpand,
  onOpenInfo,
  selected,
  editing,
  dropTarget,
  dragging,
  onSelect,
  onEditRequest,
  onCommitText,
  onDraftChange,
  onCancelEdit,
  onDragStart,
  onDragMove,
  onDragEnd,
  onOpenImage,
}: {
  node: LayoutNode;
  onExpand: (id: string) => void;
  onOpenInfo?: (infoId: string) => void;
  selected: boolean;
  editing: boolean;
  dropTarget: boolean;
  dragging: boolean;
  onSelect?: (nodeId: string | null) => void;
  onEditRequest?: (nodeId: string) => void;
  onCommitText?: (nodeId: string, text: string) => void;
  /** 每敲一下报一次当前文字（父级用它做「底排按钮动手前先落盘」，见 `TreePageMobile` 的 `flushEdit`） */
  onDraftChange?: (nodeId: string, text: string) => void;
  onCancelEdit?: () => void;
  onDragStart: (id: string) => void;
  onDragMove: (id: string, clientX: number, clientY: number) => void;
  onDragEnd: (id: string, clientX: number, clientY: number) => void;
  /** 点缩略图看大图（2026-10-07 补：手机端原来点不开） */
  onOpenImage?: (relPath: string) => void;
}) {
  const linked = Boolean(node.sourceInfoId);
  const isRoot = node.depth === 0;
  /**
   * 就地改字的输入框：**非受控**（`defaultValue` + ref 取值）。
   *
   * 🔴 2026-10-06 踩：第一版是受控的（`value={draft}` + `onChange`），
   *    结果 `Input.insertText`（自动化/输入法那条路）打进去的字**被 React 重置回空**——
   *    表现是"输入框看着是聚焦的、字却打不进去"，套件里红了一串。非受控就没这问题，
   *    而且用户敲字时不再每敲一下重渲染一次（手机上更跟手）。
   *    ⚠️ 它只在 `editing` 为真时挂载 → 每次进编辑都是新挂载，`defaultValue` 自然是最新文字。
   */
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const readDraft = () => editRef.current?.value ?? "";
  const gesture = useRef<{
    x: number;
    y: number;
    timer: number | null;
    mode: "idle" | "drag";
    /** 这次手势是从**节点自己**按下去的（不是从它里面的小按钮冒泡上来的） */
    down: boolean;
  }>({
    x: 0,
    y: 0,
    timer: null,
    mode: "idle",
    down: false,
  });

  const cancelTimer = () => {
    if (gesture.current.timer !== null) {
      window.clearTimeout(gesture.current.timer);
      gesture.current.timer = null;
    }
  };

  const onNodePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editing) return; // 编辑态：手势归输入框
    event.stopPropagation(); // 别让画布把这当成"拖画布"
    cancelTimer();
    gesture.current = {
      x: event.clientX,
      y: event.clientY,
      mode: "idle",
      down: true,
      timer: window.setTimeout(() => {
        gesture.current.timer = null;
        gesture.current.mode = "drag";
        onDragStart(node.id);
      }, LONG_PRESS_MS),
    };
  };

  const onNodePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (g.mode === "drag") {
      onDragMove(node.id, event.clientX, event.clientY);
      return;
    }
    // 手指动了 → 这次不算长按（用户是在滑画布）
    if (Math.abs(event.clientX - g.x) + Math.abs(event.clientY - g.y) > 8) cancelTimer();
  };

  const onNodePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const wasDrag = g.mode === "drag";
    const startedHere = g.down;
    cancelTimer();
    gesture.current.mode = "idle";
    gesture.current.down = false;
    if (wasDrag) {
      onDragEnd(node.id, event.clientX, event.clientY);
      return;
    }
    // 🔴 2026-10-06 修的真 bug：`＋N`（折叠徽标）和〔联动信息〕小按钮只拦了 `pointerdown`，
    //    它们的 `pointerup` 会**冒泡到节点**上 —— 于是"点开 +N"会顺手把这个节点选中，
    //    后面"点第二个节点"就变成"给第一个节点加子节点/改文字"（m19 一晚上连着红 6 条就是这个）。
    //    判据：这次手势**必须是从节点自己按下去的**才算"点了一下节点"。
    if (!startedHere) return;
    // 短按：没选中 → 选中；已选中 → 改文字
    if (selected && onEditRequest) onEditRequest(node.id);
    else onSelect?.(node.id);
  };

  return (
    <div
      data-mctree-node={node.id}
      data-mctree-depth={node.depth}
      data-mctree-selected={selected ? "1" : "0"}
      onPointerDown={onNodePointerDown}
      onPointerMove={onNodePointerMove}
      onPointerUp={onNodePointerUp}
      onPointerCancel={onNodePointerUp}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      className={
        "absolute flex flex-col gap-1 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-100 " +
        (selected ? "bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-500/15 dark:ring-indigo-500/50 " : "") +
        (dropTarget
          ? "bg-emerald-50 outline outline-2 outline-dashed outline-emerald-400 dark:bg-emerald-500/15 "
          : "") +
        (dragging ? "opacity-50 " : "") +
        (linked ? "border-l-2 border-l-indigo-400 " : "")
      }
    >
      {linked && (
        <button
          type="button"
          data-mctree-link-badge
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (node.sourceInfoId) onOpenInfo?.(node.sourceInfoId);
          }}
          className="w-fit rounded bg-indigo-100 px-1 text-[9px] leading-4 text-indigo-600 dark:bg-indigo-500/25 dark:text-indigo-300"
        >
          〔联动信息〕
        </button>
      )}

      {/* ⚠️ 跟电脑版一条规矩：**不许** line-clamp / overflow-hidden，长文字一律完整显示 */}
      <span
        data-mctree-text
        className={
          "whitespace-pre-wrap break-words text-[13px] leading-[22px] " +
          // 根节点高亮（小米那页的观感）：只改颜色，不改字号 —— 字号全项目统一 13px
          (isRoot ? "font-semibold text-amber-600 dark:text-amber-300" : "")
        }
      >
        {node.text.trim() ? (
          node.text
        ) : (
          <span data-mctree-empty-text className="italic text-slate-400">
            {EMPTY_NODE_TEXT}
          </span>
        )}
      </span>

      {node.assetPath && (
        <span className="block h-[46px] overflow-hidden rounded-md border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
          <AssetImage
            relPath={node.assetPath}
            compact
            loading={
              <span className="flex h-full items-center justify-center text-[9.5px] text-slate-400">
                图
              </span>
            }
            imgProps={{
              draggable: false,
              // 🔴 点缩略图看大图（电脑版一直有；手机端 2026-10-07 才补上）。
              //    ⚠️ 必须把 pointer 事件拦住：不然这一次点击会**同时**被节点当成
              //    「点了我一下」→ 已经选中时还会直接进"就地改字"，两个动作打架。
              onPointerDown: (event) => event.stopPropagation(),
              onPointerUp: (event) => event.stopPropagation(),
              onClick: (event) => {
                event.stopPropagation();
                if (node.assetPath) onOpenImage?.(node.assetPath);
              },
              className: "h-full w-full cursor-zoom-in object-cover",
            }}
          />
        </span>
      )}

      {/* 就地改文字：盖在节点上（跟着画布一起缩放，所以位置永远对得上） */}
      {editing && (
        <textarea
          ref={editRef}
          data-mctree-edit={node.id}
          defaultValue={node.text}
          autoFocus
          // 🔴 2026-10-20（用户反馈 #5，手机侧同款）：新建节点的默认文字是「新节点」
          //    （Rust 的 `DEFAULT_NODE_TEXT`），进编辑时挡在那儿得手动删。
          //    **只在还是默认文字时全选**（一敲就覆盖）；已有正文的节点**不动** ——
          //    对正文全选会让「想改两个字」变成「全删重写」，更危险。
          onFocus={(event) => {
            if (event.currentTarget.value === "新节点") event.currentTarget.select();
          }}
          onDoubleClick={(event) => {
            if (event.currentTarget.value === "新节点") event.currentTarget.select();
          }}
          rows={1}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          // 🔴 2026-10-20（反馈 #3）：**每敲一下就报一次**，父级底排按钮动手前要拿它先落盘
        //    （底排按钮 `onPointerDown` 会 preventDefault，编辑框**不会 blur**，不主动报就永远提交不了）
        onChange={() => onDraftChange?.(node.id, readDraft())}
        onBlur={() => onCommitText?.(node.id, readDraft())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onCommitText?.(node.id, readDraft());
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancelEdit?.();
            }
          }}
          className="absolute inset-0 h-full w-full resize-none rounded-lg border-2 border-indigo-400 bg-white/95 px-2 py-1 text-[13px] leading-[22px] text-slate-800 outline-none dark:bg-slate-900/95 dark:text-slate-100"
        />
      )}

      {node.hiddenCount > 0 && (
        <button
          type="button"
          data-mctree-more={node.id}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onExpand(node.id);
          }}
          className="absolute -right-3 top-1/2 h-5 min-w-5 -translate-y-1/2 rounded-full border border-slate-300 bg-white px-1 text-[10.5px] tabular-nums text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          +{node.hiddenCount}
        </button>
      )}
    </div>
  );
}
