/**
 * 树状图画布（M4-1 / M4-2 / M4-3 / M4-5）。
 *
 * # 三层结构
 * ```
 * <div class="容器">            ← 剪裁 + 接滚轮缩放 / 空白拖动平移 / 键盘
 *   <svg>                        ← 只画连线（pointer-events: none）
 *   <div class="world">          ← transform: translate(tx,ty) scale(k)
 *       {节点卡片 × N}           ← HTML div，坐标由 layout.ts 算出来
 *   </div>
 *   <div class="overlay">        ← 三图标工具条 / 拖拽浮标，**不随缩放变小**
 * </div>
 * ```
 *
 * # 为什么节点是 HTML 而不是 SVG `<rect>`
 * 图片缩略图、行内 `<textarea>`、Tailwind 样式都是 HTML 的原生强项；
 * 而且验收脚本能直接 `document.querySelector('button[title="加子节点"]')` —— 可验证性差一个量级。
 *
 * # 为什么三图标不随缩放变小
 * 缩小是为了"看全貌"，不是"编辑"。编辑永远发生在 1:1 附近，
 * 按钮保持 28px 才能在任何缩放级别都点得准。
 *
 * # 红线
 * 节点坐标**永远**由 `layoutTree` 算出来 —— 拖拽改的是**层级/顺序**，不是坐标。
 * 这里没有"把节点摆到任意位置"的能力（那是被划掉的「认知区无限画布」）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  EMPTY_NODE_TEXT,
  edgePath,
  fitViewport,
  hitTest,
  layoutTree,
  screenToWorld,
  zoomAt,
} from "./layout";
import type { DropZone, HitResult, Viewport } from "./layout";
import { checkMove, findNode, parentOf } from "./treeOps";
import { AssetImage } from "../../components/AssetImage";
import type { TreeNode } from "../types";

/** 三个图标按钮的边长（px） */
const TOOL_SIZE = 28;
/** 一次点击移动超过这么多像素才算"拖"（否则算点选） */
const DRAG_THRESHOLD = 5;

/** 画布给外面用的一点点能力（图片拖放要靠它做命中测试） */
export interface TreeCanvasApi {
  /** 屏幕坐标（相对画布左上角）→ 命中哪个节点 */
  hitTestScreen: (sx: number, sy: number) => HitResult | null;
  /** 回到 1:1 并居中 */
  fit: () => void;
}

/** 撤销/重做给画布的那点信息（真正的栈在 `TreeNotePane` 里） */
export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  /** 下一步会撤销/重做什么（写在按钮 title 上，别让用户猜） */
  undoLabel: string | null;
  redoLabel: string | null;
  undo: () => void;
  redo: () => void;
}

/** 画布需要的全部动作（真正的实现和错误处理在 `TreeNotePane` 里） */
export interface TreeActions {
  select: (id: string | null) => void;
  startEdit: (id: string, initialText?: string) => void;
  /** 提交并退出编辑（Esc / 失焦） */
  commitEdit: (id: string, text: string) => void;
  /**
   * 只把文字存住，**不退出编辑**（编辑态防抖自动保存用）。
   *
   * ⚠️ 为什么必须有这一条：WebView 里程序化 `blur()` 不一定触发 React 的 `onBlur`，
   * 光靠"失焦提交"会让用户点走时丢掉刚敲的字（验收时真逮到了）。
   */
  saveText: (id: string, text: string) => void;
  /** 提交 + 新建同级 + 进入编辑（Enter，编辑态） */
  commitAndSibling: (id: string, text: string) => void;
  /** 提交 + 新建子级 + 进入编辑（Tab，编辑态） */
  commitAndChild: (id: string, text: string) => void;
  addChild: (id: string) => void;
  addSibling: (id: string) => void;
  remove: (id: string) => void;
  toggleCollapse: (id: string, collapsed: boolean) => void;
  move: (nodeId: string, targetId: string, zone: DropZone) => void;
  setImage: (id: string, assetPath: string | null) => void;
  openImage: (assetPath: string) => void;
  openInfo: (infoId: string) => void;
}

interface TreeCanvasProps {
  root: TreeNode;
  selectedId: string | null;
  editingId: string | null;
  /** 拖图片进来时悬停的节点（由 pane 的窗口级拖放监听算出来） */
  imageDropId: string | null;
  /** 撤销/重做（栈在 pane 里，画布只负责露出按钮和快捷键） */
  history: HistoryInfo;
  actions: TreeActions;
  apiRef: { current: TreeCanvasApi | null };
}

export default function TreeCanvas({
  root,
  selectedId,
  editingId,
  imageDropId,
  history,
  actions,
  apiRef,
}: TreeCanvasProps) {
  const layout = useMemo(() => layoutTree(root), [root]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [viewport, setViewport] = useState<Viewport>({ tx: 0, ty: 0, k: 1 });
  const [editValue, setEditValue] = useState("");
  /** 正在平移（只用来切光标；ref 变了不会重渲染） */
  const [panning, setPanning] = useState(false);
  /** 拖拽中的浮标位置（屏幕坐标）；null = 没在拖 */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ hit: HitResult; ok: boolean; reason?: string } | null>(
    null,
  );
  /**
   * 落点提示的 **ref 副本** —— `endPointer` 只读它，不读 state。
   *
   * ⚠️ 真踩过：真实拖拽是 mousePressed → 一串 mouseMove → **紧接着** mouseReleased，
   * 中间没有等待。`onPointerMove` 里 `setDropHint(...)` 之后 React 还没重渲染，
   * 而 `endPointer` 的闭包里 `dropHint` 还是上一轮的值（通常是 null）→
   * **落点判定整个丢掉，拖拽白做**。
   * 用合成事件测的时候我在每个 move 之间都 `await sleep(...)`，恰好掩盖了它
   * （这就是"合成事件全绿、真手一拖就废"的又一处）。
   * 所以状态给渲染用、ref 给事件用，两边同时更新。
   */
  const dropHintRef = useRef<{ hit: HitResult; ok: boolean; reason?: string } | null>(null);
  const applyDropHint = (next: { hit: HitResult; ok: boolean; reason?: string } | null) => {
    dropHintRef.current = next;
    setDropHint(next);
  };
  /**
   * 刚拖完 → 把紧随其后的那次 `click` 吃掉。
   *
   * 卡片里的缩略图不再拦截 pointerdown（不然拖不动带图的节点），
   * 于是"从图片上拖一把再松手"会在 img 上产生一个 click →
   * 误弹大图查看器。用它挡掉。
   */
  const justDragged = useRef(false);

  /** 这次 fit 是为哪个根节点做的（根 id 变了才重新 fit，改内容不重置视口） */
  const fittedFor = useRef<string | null>(null);
  /** 键盘直接敲字进入编辑时，先把那个字符带上 */
  const pendingText = useRef<string | null>(null);
  /** 当前这个编辑会话是不是已经把文字装进 textarea 了（防止 layout 变化冲掉输入） */
  const editSeeded = useRef<string | null>(null);
  /** 这个编辑会话里已经存住的文字（防抖保存靠它判断"有没有新东西要存"） */
  const editSaved = useRef<string>("");
  /** `actions` 每次渲染都可能换身份；防抖里通过它拿最新那份，避免旧闭包 + 避免重置计时器 */
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  /** 拖拽状态放 ref（pointermove 里读，不引起额外渲染） */
  const dragState = useRef<{
    nodeId: string;
    startX: number;
    startY: number;
    active: boolean;
    /** 指针捕获是不是已经拿下了（只有真开始拖才拿，见 onPointerMove 的注释） */
    captured: boolean;
  } | null>(null);
  const panState = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);

  // ── 容器尺寸（fit 要用）
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(element);
    setSize({ w: element.clientWidth, h: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  // ── 首次拿到尺寸 / 换了根节点 → 自动 fit（图小的时候不放大，1:1 最舒服）
  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return;
    if (fittedFor.current === root.id) return;
    fittedFor.current = root.id;
    setViewport(fitViewport(layout, size.w, size.h));
  }, [layout, root.id, size.w, size.h]);

  const fit = useCallback(() => {
    setViewport(fitViewport(layout, size.w, size.h));
  }, [layout, size.w, size.h]);

  // ── 交给外面的 API（图片拖放要按屏幕坐标找节点）
  useEffect(() => {
    apiRef.current = {
      hitTestScreen: (sx, sy) => {
        const world = screenToWorld(viewport, sx, sy);
        return hitTest(layout, world.x, world.y);
      },
      fit,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, fit, layout, viewport]);

  // ── 滚轮缩放：React 的 onWheel 是被动的（preventDefault 不生效），所以手工挂原生监听
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // 反馈·1022 #3：**必须按住 Ctrl（Mac 上是 ⌘）才缩放**。
      // 之前普通滚轮一动就缩放 —— 画布长了想往下滚一下就误触（用户原话「容易误触」）。
      // 不按修饰键就**什么都不做、也不 preventDefault**，让事件照常往上冒。
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      setViewport((view) => zoomAt(view, view.k * Math.exp(-event.deltaY * 0.0015), sx, sy));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // ── 进入编辑态时把文字装进 textarea
  //
  // ⚠️ 这里有两个坑，都踩过：
  // 1. 依赖里**不能**放 `layout`：别处联动进来一个节点会让 layout 变，
  //    那样正在打的字会被冲掉。所以用"每个编辑会话只装一次"（`editSeeded`）。
  // 2. 新建的节点**不会**立刻出现在 layout 里（后端刚建完，新的 note 还在路上），
  //    这时候不能装空字符串，要等它出现 —— 否则新节点的输入框是空的而不是"新节点"。
  useEffect(() => {
    if (!editingId) {
      editSeeded.current = null;
      setEditValue("");
      return;
    }
    if (editSeeded.current === editingId) return;
    const node = layout.byId.get(editingId);
    if (!node) return;
    editSeeded.current = editingId;
    const text = pendingText.current ?? node.text;
    pendingText.current = null;
    editSaved.current = text; // 刚装进去的就是"已存住"的基准
    setEditValue(text);
  }, [editingId, layout]);

  // ── 编辑态**防抖自动保存**：停下打字 900ms 就把文字存住，但**不退出编辑**
  //
  // ⚠️ 这是修一条真 bug：节点文字原本只在 Enter / Tab / Esc / 失焦 时保存，
  // 而 WebView 里程序化 `blur()` 不一定触发 React 的 `onBlur` ——
  // 用户双击写完、直接去点别的地方，那段字就没了。
  // 加上防抖兜底后，哪天哪条路都能存住（和 `DocNotePane` 一个节奏）。
  //
  // 依赖只放 `editingId` / `editValue`：`layout` 变了（比如刚存完）不该重置计时器，
  // 所以"要不要存"用 ref 里的基准比，而不是用 layout 里的节点文字。
  useEffect(() => {
    if (!editingId || editSeeded.current !== editingId) return;
    if (editValue === editSaved.current) return;
    const timer = window.setTimeout(() => {
      editSaved.current = editValue;
      actionsRef.current.saveText(editingId, editValue);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [editingId, editValue]);

  // ── 指针流水线：空白拖动=平移；节点拖动=调层级/顺序
  /**
   * 捕获指针。
   *
   * ⚠️ 一定要包 try：`setPointerCapture` 对"不是当前活跃指针"的 id 会抛
   * `InvalidPointerId`。验收脚本是用合成 PointerEvent 驱动的（`dispatchEvent`），
   * 那种 id 并不是真活跃指针 —— 不包起来的话每个脚本点击都会在控制台刷一片红，
   * 还会把 handler 后面的代码打断。
   */
  const capturePointer = (pointerId: number) => {
    try {
      containerRef.current?.setPointerCapture(pointerId);
    } catch {
      /* 合成事件 / 指针已经松开：不影响功能，捕获只是让拖到窗口外也收得到 move */
    }
  };

  /** 释放指针捕获（没捕获过会抛，所以先问一句） */
  const releaseCapture = (pointerId: number) => {
    const element = containerRef.current;
    if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    containerRef.current?.focus();
    actions.select(null);
    panState.current = {
      startX: event.clientX,
      startY: event.clientY,
      tx: viewport.tx,
      ty: viewport.ty,
    };
    setPanning(true);
    capturePointer(event.pointerId);
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation(); // 别让它变成空白平移
    containerRef.current?.focus();
    actions.select(nodeId);
    if (editingId === nodeId) return; // 编辑态里点自己是在放光标

    justDragged.current = false; // 新的手势开始，清掉上一次的"刚拖过"标记
    dragState.current = {
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      captured: false,
    };
    // ⚠️ 这里**故意不**立刻 setPointerCapture —— 见 onPointerMove 里那段注释。
    // 一句话：按下就捕获会把 click / dblclick 的目标改道到容器上，
    // 于是"双击节点改文字"对真实用户完全失效（但合成事件测不出来）。
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panState.current;
    if (pan) {
      setViewport((view) => ({
        ...view,
        tx: pan.tx + (event.clientX - pan.startX),
        ty: pan.ty + (event.clientY - pan.startY),
      }));
      return;
    }

    const drag = dragState.current;
    if (!drag) return;
    const moved =
      Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    if (!drag.active && moved < DRAG_THRESHOLD) return;
    drag.active = true;
    // ⚠️ **到这一步才捕获指针**，这是"双击改文字"能用的关键。
    //
    // 曾经在 pointerdown 里就 setPointerCapture，结果：指针一旦被容器捕获，
    // 浏览器会把随后的 pointerup 也投递给容器，而 `click` / `dblclick` 的目标
    // 按"按下与松开目标的最近公共祖先"算 → 变成**画布容器**，
    // 节点卡片上的 `onDoubleClick` 永远不触发。
    // 用户实测："包括中心主题在内，所有节点都不能双击编辑文字"。
    //
    // 而验收脚本当时用的是 `dispatchEvent(new MouseEvent('dblclick'))`，
    // 直接派发到节点上、绕过了命中测试与捕获 → 一路绿灯。**假绿灯，最坑。**
    if (!drag.captured) {
      capturePointer(event.pointerId);
      drag.captured = true;
    }
    setGhost({ x: event.clientX, y: event.clientY });

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const world = screenToWorld(viewport, event.clientX - rect.left, event.clientY - rect.top);
    const hit = hitTest(layout, world.x, world.y);
    if (!hit) {
      applyDropHint(null);
      return;
    }
    const check = checkMove(root, drag.nodeId, hit.node.id, hit.zone);
    applyDropHint({ hit, ok: check.ok, reason: check.reason });
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panState.current) {
      panState.current = null;
      setPanning(false);
      releaseCapture(event.pointerId);
      return;
    }

    const drag = dragState.current;
    dragState.current = null;
    const wasActive = drag?.active;
    // ⚠️ 读 ref，不读 state（真实拖拽在最后一次 move 之后立刻松开，state 还没刷新）
    const hint = dropHintRef.current;
    setGhost(null);
    applyDropHint(null);
    releaseCapture(event.pointerId);

    if (wasActive) justDragged.current = true; // 松手后紧跟着的 click 要吃掉（别误开大图）
    if (!drag || !wasActive || !hint || !hint.ok) return;
    // 落到自己身上 = 什么都不做（Rust 那边也当无动作）
    if (hint.hit.node.id === drag.nodeId) return;
    actions.move(drag.nodeId, hint.hit.node.id, hint.hit.zone);
  };

  // ── 键盘（选中态；编辑态由 textarea 自己管）
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editingId) return;
    // 撤销 / 重做：Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y（用户反馈里点名要的）
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        history.undo();
        return;
      }
      if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        history.redo();
        return;
      }
      if (key === "0") {
        event.preventDefault();
        fit();
        return;
      }
    }
    if (!selectedId) return;
    const node = layout.byId.get(selectedId);

    switch (event.key) {
      case "Enter":
        event.preventDefault();
        actions.addSibling(selectedId);
        return;
      case "Tab":
        event.preventDefault();
        actions.addChild(selectedId);
        return;
      case "Delete":
        event.preventDefault();
        actions.remove(selectedId);
        return;
      case "F2":
        event.preventDefault();
        actions.startEdit(selectedId);
        return;
      case "Escape":
        event.preventDefault();
        actions.select(null);
        return;
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const index = layout.order.findIndex((one) => one.id === selectedId);
        if (index < 0) return;
        const next = layout.order[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (next) actions.select(next.id);
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        // 展开着的先收起来，收着的（或叶子）才往父节点跳 —— 和文件树一个习惯
        if (node?.hasChildren && !node.collapsed) {
          actions.toggleCollapse(selectedId, true);
          return;
        }
        const parent = parentOf(root, selectedId);
        if (parent) actions.select(parent.id);
        return;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (node?.hasChildren && node.collapsed) {
          actions.toggleCollapse(selectedId, false);
          return;
        }
        const self = findNode(root, selectedId);
        const first = self?.children[0];
        if (first) actions.select(first.id);
        return;
      }
      default:
        // 直接敲字 = 进入编辑，且那个字已经在里面了（"随手就能往下长"）
        if (
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          event.preventDefault();
          pendingText.current = event.key;
          actions.startEdit(selectedId);
        }
    }
  };

  const selected = selectedId ? layout.byId.get(selectedId) : undefined;

  // ── 三图标工具条：贴在选中节点的右上角外侧，**不随缩放变小**
  const toolbar = (() => {
    if (!selected || editingId === selected.id) return null;
    const barW = TOOL_SIZE * 3 + 12;
    const rawLeft = viewport.tx + (selected.x + selected.w) * viewport.k - 8;
    const rawTop = viewport.ty + selected.y * viewport.k - TOOL_SIZE - 6;
    const left = Math.min(Math.max(rawLeft, 4), Math.max(4, size.w - barW - 4));
    // 顶到画布外面就翻到节点下沿
    const top =
      rawTop < 4
        ? Math.min(
            viewport.ty + (selected.y + selected.h) * viewport.k + 6,
            Math.max(4, size.h - TOOL_SIZE - 4),
          )
        : Math.min(rawTop, Math.max(4, size.h - TOOL_SIZE - 4));
    const isRoot = selected.id === root.id;

    const button = (
      key: string,
      title: string,
      icon: ReactNode,
      disabled: boolean,
      onClick: () => void,
      tone: "danger" | "primary" | "normal",
    ) => (
      <button
        key={key}
        type="button"
        title={title}
        aria-label={title}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        // 圆形描边按钮（2026-09-22 收尾小改动：原来是 emoji + 方形按钮，用户说难看）。
        // 静止时三个长得一样、只有悬停才染色（删除染红 / 加子节点染靛），好看又不丢提示。
        className={`flex items-center justify-center rounded-full border shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
          tone === "danger"
            ? "border-slate-200 bg-white text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
            : tone === "primary"
              ? "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-300"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
        }`}
        style={{ width: TOOL_SIZE, height: TOOL_SIZE }}
      >
        {icon}
      </button>
    );

    return (
      <div
        data-tree-toolbar
        className="pointer-events-auto absolute flex gap-1.5"
        style={{ left, top }}
      >
        {button(
          "remove",
          isRoot ? "中心主题不能删（它是整棵树的根）" : "删除这个节点和它的整个分支",
          <ToolIconTrash />,
          isRoot,
          () => actions.remove(selected.id),
          "danger",
        )}
        {button(
          "child",
          "加子节点",
          <ToolIconAddChild />,
          false,
          () => actions.addChild(selected.id),
          "primary",
        )}
        {button(
          "sibling",
          isRoot ? "中心主题没有同级节点" : "加同级节点",
          <ToolIconAddSibling />,
          isRoot,
          () => actions.addSibling(selected.id),
          "normal",
        )}
      </div>
    );
  })();

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-tree-canvas
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onKeyDown={onKeyDown}
      // 画布内一律不要原生拖拽（图片/选中文字）—— 会跟自己的拖拽手势打架
      onDragStart={(event) => event.preventDefault()}
      onDoubleClick={(event) => {
        // 兜底：**真实双击**有可能被指针捕获改道到容器上（见 onPointerMove 里那段注释）。
        // 节点自己的 onDoubleClick 处理过了就跳过；没处理到就按坐标命中一次。
        // 双保险 —— 这道兜底存在的意义就是"哪天捕获行为又变了也不至于不能用"。
        if ((event.target as HTMLElement | null)?.closest?.("[data-node-id]")) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const world = screenToWorld(viewport, event.clientX - rect.left, event.clientY - rect.top);
        const hit = hitTest(layout, world.x, world.y);
        if (hit) actions.startEdit(hit.node.id);
      }}
      className="relative h-full min-h-0 w-full touch-none select-none overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 outline-none dark:border-slate-800 dark:bg-slate-950"
      style={{
        cursor: panning ? "grabbing" : "default",
        backgroundImage:
          "radial-gradient(circle, rgb(148 163 184 / 0.28) 1px, transparent 1px)",
        backgroundSize: `${20 * viewport.k}px ${20 * viewport.k}px`,
        backgroundPosition: `${viewport.tx}px ${viewport.ty}px`,
      }}
    >
      {/* 世界层：连线 + 节点同一套 transform，永远对齐 */}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.k})`,
          width: layout.width,
          height: layout.height,
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          {layout.edges.map((edge) => (
            <path
              key={`${edge.from}-${edge.to}`}
              d={edgePath(edge)}
              className="text-slate-300 dark:text-slate-700"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            />
          ))}
        </svg>

        {layout.nodes.map((node) => {
          const isEditing = editingId === node.id;
          const isSelected = selectedId === node.id;
          const isDropTarget = dropHint?.hit.node.id === node.id;
          const isImageDrop = imageDropId === node.id;
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              data-node-text={node.text}
              // 画布里的拖拽全是自己实现的：禁止原生 DnD，否则抓到图片/文字会开始浏览器拖拽、
              // 把后续 pointermove/pointerup 全吞掉（带图的节点就彻底拖不动了）
              draggable={false}
              onPointerDown={(event) => onNodePointerDown(event, node.id)}
              onDoubleClick={() => actions.startEdit(node.id)}
              className={`absolute flex flex-col gap-1.5 rounded-xl border px-3 py-2 text-slate-800 shadow-sm transition-shadow dark:text-slate-100 ${
                isSelected
                  ? "border-indigo-500 ring-2 ring-indigo-400/60"
                  : "border-slate-300 dark:border-slate-700"
              } ${
                node.sourceInfoId
                  ? "border-l-2 border-l-indigo-400 bg-indigo-50/70 dark:border-l-indigo-500 dark:bg-indigo-500/10"
                  : "bg-white dark:bg-slate-900"
              } ${
                isImageDrop
                  ? "ring-2 ring-emerald-400 ring-offset-1"
                  : ""
              } ${isDropTarget ? (dropHint?.ok ? "ring-2 ring-emerald-400" : "ring-2 ring-rose-400") : ""} ${
                ghost && dragState.current?.nodeId === node.id ? "opacity-40" : ""
              }`}
              style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
            >
              {node.sourceInfoId && !isEditing && (
                <button
                  type="button"
                  title="这条是联动进来的信息，点它回信息区"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (node.sourceInfoId) actions.openInfo(node.sourceInfoId);
                  }}
                  className="pointer-events-auto w-fit rounded bg-indigo-100 px-1 text-[9px] leading-4 text-indigo-600 hover:bg-indigo-200 dark:bg-indigo-500/25 dark:text-indigo-300 dark:hover:bg-indigo-500/40"
                >
                  〔联动信息〕
                </button>
              )}

              {isEditing ? (
                <textarea
                  autoFocus
                  value={editValue}
                  onFocus={(event) => event.currentTarget.select()}
                  // 🔴 2026-10-20（用户反馈 #5）：「双击文本框后，里面原有的『新节点』三个字不会消失，
                  //    还要手动删」。病根：上面 `onFocus` 的全选已经被**双击的第二下**点掉了
                  //    （第二下点击 = 定位光标 = 取消选区）。所以双击时**再全选一次**。
                  onDoubleClick={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditValue(event.target.value)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onBlur={() => {
                    if (editingId) actions.commitEdit(editingId, editValue);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      actions.commitAndSibling(node.id, editValue);
                      return;
                    }
                    if (event.key === "Tab") {
                      event.preventDefault();
                      actions.commitAndChild(node.id, editValue);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      actions.commitEdit(node.id, editValue);
                    }
                  }}
                  className="min-h-0 w-full flex-1 resize-none rounded-md border border-indigo-300 bg-white px-1 text-[13px] leading-[22px] text-slate-800 outline-none dark:border-indigo-500 dark:bg-slate-800 dark:text-slate-100"
                  placeholder="写点什么…（Enter 新建同级 / Tab 新建子级 / Shift+Enter 换行）"
                />
              ) : (
                // ⚠️ 这里**绝对不能**加 line-clamp / overflow-hidden：
                // M4.2 用户反馈「长文字被截断不能接受」。行数已由 `measureNode` 算好、
                // 卡片高度按它给，所以文字一律完整显示，一个字都不许裁。
                <span className="whitespace-pre-wrap break-words text-[13px] leading-[22px]">
                  {node.text.trim() ? (
                    node.text
                  ) : (
                    <span className="text-slate-400 italic">{EMPTY_NODE_TEXT}</span>
                  )}
                </span>
              )}

              {node.assetPath && (
                <NodeThumb
                  relPath={node.assetPath}
                  editing={isEditing}
                  onOpen={() => {
                    if (justDragged.current) return; // 刚才那一把是拖拽，不是"看大图"
                    if (node.assetPath) actions.openImage(node.assetPath);
                  }}
                  onRemove={() => actions.setImage(node.id, null)}
                />
              )}

              {node.hasChildren && (
                <button
                  type="button"
                  data-fold-badge={node.id}
                  title={
                    node.collapsed
                      ? `展开这一枝（藏着 ${node.hiddenCount} 个节点）`
                      : "折叠这一枝"
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    actions.toggleCollapse(node.id, !node.collapsed);
                  }}
                  className={`absolute -right-3 top-1/2 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-full border px-1 text-[10px] font-medium shadow-sm transition-colors ${
                    node.collapsed
                      ? "border-indigo-400 bg-indigo-500 text-white hover:bg-indigo-600"
                      : "border-slate-300 bg-white text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {node.collapsed ? `+${node.hiddenCount}` : "−"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 浮层：三图标工具条（固定尺寸） + 拖拽浮标 */}
      <div className="pointer-events-none absolute inset-0">
        {toolbar}
        {ghost && dragState.current && (
          <div
            className={`pointer-events-none absolute z-10 max-w-56 rounded-lg border px-2 py-1 text-[11px] shadow-lg ${
              dropHint && !dropHint.ok
                ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300"
                : "border-slate-300 bg-white text-slate-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
            }`}
            style={{ left: ghost.x + 14, top: ghost.y + 12 }}
          >
            {dropHint
              ? dropHint.ok
                ? dropHint.hit.zone === "inside"
                  ? `放进「${labelOf(dropHint.hit.node.text)}」`
                  : `放到「${labelOf(dropHint.hit.node.text)}」${dropHint.hit.zone === "before" ? "前面" : "后面"}`
                : (dropHint.reason ?? "不能放到这里")
              : "松手放到空白 = 取消"}
          </div>
        )}
      </div>

      {/* 右下角：视图控制（撤销/重做 + 缩放 / 归位） */}
      <div
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl border border-slate-200 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/90"
      >
        <ViewButton
          title={history.canUndo ? `撤销：${history.undoLabel ?? ""}（Ctrl+Z）` : "没有可撤销的操作"}
          onClick={() => history.undo()}
          disabled={!history.canUndo}
        >
          ↶
        </ViewButton>
        <ViewButton
          title={history.canRedo ? `重做：${history.redoLabel ?? ""}（Ctrl+Shift+Z）` : "没有可重做的操作"}
          onClick={() => history.redo()}
          disabled={!history.canRedo}
        >
          ↷
        </ViewButton>
        <span className="mx-0.5 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <span className="px-1 font-mono text-[10px] text-slate-400">
          {Math.round(viewport.k * 100)}%
        </span>
        <ViewButton
          title="缩小"
          onClick={() =>
            setViewport((view) =>
              zoomAt(view, view.k / 1.2, size.w / 2, size.h / 2),
            )
          }
        >
          −
        </ViewButton>
        <ViewButton
          title="放大"
          onClick={() =>
            setViewport((view) => zoomAt(view, view.k * 1.2, size.w / 2, size.h / 2))
          }
        >
          ＋
        </ViewButton>
        <ViewButton title="回到 1:1 并居中（Ctrl+0）" onClick={fit}>
          ⌖
        </ViewButton>
      </div>

      {/* 左下角：操作提示（第一次用的人不用猜） */}
      <p className="pointer-events-none absolute bottom-3 left-3 max-w-[62%] text-[10px] leading-4 text-slate-400">
        双击改文字 · Enter 新建同级 · Tab 新建子级 · 拖节点调层级 · Ctrl+滚轮缩放 · 空白处拖动平移 ·
        选中节点后 Ctrl+V 粘图片 · Ctrl+Z 撤销
      </p>
    </div>
  );
}

function ViewButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-lg text-xs text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-800 dark:disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/** 节点里的缩略图（点看大图；编辑态右上角给个 × 去掉图） */
function NodeThumb({
  relPath,
  editing,
  onOpen,
  onRemove,
}: {
  relPath: string;
  editing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="relative h-[58px] w-full overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
      {/*
        ⚠️ `draggable={false}` 是必须的，踩过大坑：
        `pointerdown` 落在 `<img>` 上会触发**浏览器原生的图片拖拽**，
        一旦开始，页面就再也收不到 pointermove / pointerup ——
        表现是「**带图片的节点完全拖不动**」，而且拖拽手势会被整个吞掉。
        合成事件测不出来（`dispatchEvent` 不触发原生 DnD），又是真实输入才暴露的。
        缺图兜底（2026-10-06）搬进 `AssetImage` 之后，这条仍然由这里传进去。
      */}
      <AssetImage
        relPath={relPath}
        compact
        loading={
          <span className="flex h-full items-center justify-center text-[10px] text-slate-400">
            图片加载中…
          </span>
        }
        imgProps={{
          draggable: false,
          onClick: (event) => {
            event.stopPropagation();
            onOpen();
          },
          className: "h-full w-full cursor-zoom-in object-cover",
        }}
      />
      {editing && (
        <button
          type="button"
          title="去掉这张图（assets/ 里的原文件不动）"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-[11px] text-white hover:bg-rose-600"
        >
          ×
        </button>
      )}
    </div>
  );
}

/** 节点文字为空时给个能认出来的名字（浮标/提示里用） */
/* ── 三图标工具条用的内联描边图标（2026-09-22：换掉 emoji，**不装图标库**，手写三个） ── */

/** 删除这个节点和它的整个分支 */
function ToolIconTrash() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 6.5h17" />
      <path d="M18.5 6.5v12.2A2.3 2.3 0 0 1 16.2 21H7.8a2.3 2.3 0 0 1-2.3-2.3V6.5" />
      <path d="M9 6.5V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8v1.7" />
    </svg>
  );
}

/** 加子节点：一个节点 + 连线 + 圆圈加号 */
function ToolIconAddChild() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="3.6" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M5.4 12h4.1" />
      <circle cx="15.4" cy="12" r="5.4" />
      <path d="M15.4 9.6v4.8M13 12h4.8" />
    </svg>
  );
}

/** 加同级节点：一条分叉 + 右下角的加号角标 */
function ToolIconAddSibling() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5.5" cy="5.5" r="2.4" />
      <path d="M5.5 7.9v7.3" />
      <path d="M5.5 11.4h4.2a2.6 2.6 0 0 0 2.6-2.6V7.9" />
      <circle cx="16.8" cy="16.8" r="4.4" />
      <path d="M16.8 14.7v4.2M14.7 16.8h4.2" />
    </svg>
  );
}

function labelOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "（空节点）";
  return trimmed.length > 12 ? `${trimmed.slice(0, 12)}…` : trimmed;
}
