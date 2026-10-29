/**
 * 树状图的自动布局（M4）—— **纯函数，不碰 React、不碰 DOM**，所以能单独测。
 *
 * # 方向
 * **根在左，子节点逐层向右展开**（用户 2026-09-21 选定；定稿设计文档 §4.3「树左右展开」）。
 *
 * # 为什么不用 dagre / React Flow
 * 1. React Flow 的核心能力是"自由摆放节点 + 任意连线"——那正好是红线里的**无限画布**，
 *    而 PRD 只要求"折叠/拖拽调层级、缩放平移"，节点坐标永远由布局算出来；
 * 2. 装包要绕沙箱的 npm 缓存（M3 踩过）；
 * 3. 左→右 tidy tree 本身就是 60 行，还天然带折叠。
 *
 * # 算法（确定性、O(n)、三趟）
 * 1. **后序**：算每个节点的"子树占位高" `height`（折叠/无子就是自己那块的高度）；
 * 2. **层对齐**：同深度的节点左边缘 x 相同，`layerX[d] = layerX[d-1] + 最宽节点 + GAP_X`；
 * 3. **前序**：在父节点分到的竖直区间里，把子节点依次排下去，父节点自己居中。
 *
 * # 关键取舍：节点尺寸在布局**之前**就能算出来
 * 用 `getBoundingClientRect` 量真实尺寸再二次布局，会让每敲一个字整张图抖一下。
 * 所以这里**自己按字符估宽**：宽度连续取值（**不再分三档**）、行数按真实换行算，
 * 文字**一律不截断** —— M4.2 用户反馈「三档宽度会把长文字截掉，不能接受」。
 *
 * 估算的规矩是**宁可多算、不可少算**：估宽偏大只是卡片右侧空一点；
 * 估行偏少会让卡片高度不够、文字压出卡片外。中文是 1em 方块，估得准；
 * 拉丁字母按偏大的字宽取，连续单词整体不折行（对应 `overflow-wrap: break-word`）。
 * 换来的是**零测量、零抖动、纯函数**（`measureNode` 可以单独测）。
 */
import type { TreeNode } from "../types";

/** 层间距（父节点右边缘 → 子节点左边缘） */
export const GAP_X = 72;
/** 兄弟间距 */
export const GAP_Y = 16;
/** 画布内容四周留白 */
export const PAD = 32;

/**
 * 布局参数（**可选**，缺省值就是上面那三个常量）。
 *
 * 为什么要它：手机端屏幕窄，同样的 72/32 间距会让树"还没展开就出屏"了 ——
 * 手机那边传更小的 `gapX / gapY / pad`（**字号不动**，见 `FONT_SIZE`），
 * 电脑版不传 → 输出与以前**逐像素一致**（M4 那套验收盯着这条）。
 */
export interface LayoutOptions {
  gapX?: number;
  gapY?: number;
  pad?: number;
}

/** 正文字号（必须与 `TreeCanvas` 节点上的 `text-[13px]` 一致） */
const FONT_SIZE = 13;
/** 行高（必须与 `leading-[22px]` 一致） */
const LINE_H = 22;
/** 卡片横向内边距：`px-3` ×2 + 左右描边 */
const PAD_X = 12 * 2 + 2;
/** 卡片纵向内边距：`py-2` ×2 + 上下描边 */
const PAD_Y = 8 * 2 + 2;
/** 卡片内子元素之间的间距：`gap-1.5` */
const GAP_IN = 6;
/** 〔联动信息〕来源小标签占的高度 */
const BADGE_H = 16;
/** 节点里缩略图那块的高度 */
const THUMB_H = 58;
/** 宽度余量：宁可宽 2px，也别让最长那一行被迫折成两行 */
const SLACK = 2;

/** 节点最小宽度：太短的字也不缩成小方块，看着才整齐 */
export const MIN_W = 132;
/**
 * 节点最大宽度：**只是"别排成一条长龙"**，超了就在卡片里换行。
 * 换行不是截断 —— 文字一个都不会少。
 */
export const MAX_W = 360;

/**
 * 空节点的占位文案。
 * ⚠️ 渲染与 `measureNode` **必须用同一份**：占位文字比节点宽的话会压出卡片。
 */
export const EMPTY_NODE_TEXT = "（空节点，双击写点东西）";

export interface LayoutNode {
  id: string;
  /** 左上角坐标（已含 PAD） */
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  /** 有子节点（决定要不要画折叠小圆点） */
  hasChildren: boolean;
  /**
   * 折叠时藏起来几个节点（含所有后代）；没折叠 = 0。
   * 折叠小圆点上显示的就是它 —— 让用户知道"这一枝有东西，只是收起来了"。
   */
  hiddenCount: number;
  /** 原文（渲染用；空文字时界面显示占位） */
  text: string;
  assetPath?: string;
  sourceInfoId?: string;
  collapsed: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** 父节点右边缘中点 */
  px: number;
  py: number;
  /** 子节点左边缘中点 */
  cx: number;
  cy: number;
}

export interface TreeLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** 内容包围盒（已含四周 PAD） */
  width: number;
  height: number;
  byId: Map<string, LayoutNode>;
  /** 可见节点的阅读顺序（自上而下、自左而右）—— 键盘 ↑↓ 用它 */
  order: LayoutNode[];
}

const EMPTY: TreeLayout = {
  nodes: [],
  edges: [],
  width: 0,
  height: 0,
  byId: new Map(),
  order: [],
};

/** 中日韩文字 / 全角标点：在等宽意义上占满一个 1em 方块 */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0xa4cf) || // 部首扩展 ~ 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe30 && code <= 0xfe4f) || // 中日韩兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角字符
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** 明显比一般字符窄的（微软雅黑 13px 量级） */
const NARROW = "iljtfrI|.,:;'!()[]{}/\\\"`";
/** 明显比一般字符宽的 */
const WIDE = "WM@%&mw";

/**
 * 单个字符的宽度（px）。
 *
 * ⚠️ **一律往大估**：估宽偏大只是卡片右侧空一点；
 * 估窄会让实际折行比预计多、卡片高度不够、文字压出卡片外。
 * 中文是 1em 方块，估得准；拉丁字母按微软雅黑 13px 的偏大值取。
 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (isWideChar(code)) return FONT_SIZE;
  if (code === 0x20 || code === 0x09) return 4;
  if (code > 0xffff) return FONT_SIZE * 1.15; // emoji 之类通常比 1em 还宽
  if (NARROW.includes(ch)) return 5;
  if (WIDE.includes(ch)) return 12.5;
  if (code >= 0x41 && code <= 0x5a) return 9.5; // 大写字母比小写宽
  return 8;
}

/** 一段文字（不含换行）的估算宽度 */
export function textPx(line: string): number {
  let width = 0;
  for (const ch of line) width += charWidth(ch);
  return width;
}

/**
 * 把一行切成"可断点"：中日韩逐字可断，连续 ASCII 单词算一整块
 * （对应 `overflow-wrap: break-word` —— 只有整词都放不下时才拆词）。
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let word = "";
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (isWideChar(code) || code === 0x20 || code === 0x09) {
      if (word) {
        tokens.push(word);
        word = "";
      }
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

/**
 * 一段文字在 `availW` 里要排几行。
 *
 * 与 `measureNode` 同一个原则：**宁可多算一行**
 * （多算只是卡片底部空一点，少算会让文字压出卡片外）。
 */
function wrapCount(line: string, availW: number): number {
  if (line.length === 0) return 1;
  let rows = 1;
  let used = 0;
  for (const token of tokenize(line)) {
    const width = textPx(token);
    if (used + width <= availW) {
      used += width;
      continue;
    }
    if (token === " " || token === "\t") {
      // 行尾空白会被 CSS 吃掉：直接换行，且不占新行的宽度
      rows += 1;
      used = 0;
      continue;
    }
    if (width <= availW) {
      // 整块挪到下一行（行首空白同样被吃掉，这里也不计）
      rows += 1;
      used = width;
      continue;
    }
    // 这一块自己就比一行还宽（长单词 / 超长串）→ 逐字符塞满
    if (used > 0) {
      rows += 1;
      used = 0;
    }
    for (const ch of token) {
      const cw = charWidth(ch);
      if (used + cw > availW) {
        rows += 1;
        used = 0;
      }
      used += cw;
    }
  }
  return rows;
}

/**
 * 节点卡片该多大（纯函数：给定节点，尺寸就定了，不需要先渲染）。
 *
 * - **宽**：按最长的那个逻辑行连续算，夹在 `MIN_W`~`MAX_W` 之间；
 * - **高**：按**真实换行行数**算（不再"最多三行"），再加来源标签 / 缩略图占的高度。
 *
 * 于是"一屏能看到全部文字"这件事由尺寸保证，渲染那边**不许再 clamp**。
 */
export function measureNode(node: TreeNode): { w: number; h: number } {
  // 空节点显示的是占位文案，尺寸得按占位文案算，否则占位文字会压出卡片
  const display = node.text.trim() ? node.text : EMPTY_NODE_TEXT;
  const logicalLines = display.split("\n");

  let widest = 0;
  for (const line of logicalLines) widest = Math.max(widest, textPx(line));

  const w = Math.min(MAX_W, Math.max(MIN_W, PAD_X + widest + SLACK));

  const availW = w - PAD_X;
  let rows = 0;
  for (const line of logicalLines) rows += wrapCount(line, availW);

  let h = PAD_Y + rows * LINE_H;
  if (node.sourceInfoId) h += GAP_IN + BADGE_H;
  if (node.assetPath) h += GAP_IN + THUMB_H;
  return { w, h };
}

/** 一个节点下面（不含自己）一共多少个后代 —— 折叠小圆点上的数字 */
export function countDescendants(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/** 后序：算出每个可见节点的"子树占位高" */
interface Measured {
  node: TreeNode;
  size: { w: number; h: number };
  depth: number;
  children: Measured[];
  /** 这一枝（含自己）竖直方向要占多少 */
  height: number;
}

function measureTree(node: TreeNode, depth: number, gapY: number): Measured {
  const size = measureNode(node);
  // 折叠 = 子树完全不参与布局（"看不见"就是"不存在"）
  const children = (node.collapsed ? [] : node.children).map((child) =>
    measureTree(child, depth + 1, gapY),
  );

  let height = size.h;
  if (children.length > 0) {
    const stack =
      children.reduce((sum, child) => sum + child.height, 0) + (children.length - 1) * gapY;
    height = Math.max(size.h, stack);
  }
  return { node, size, depth, children, height };
}

/**
 * 布局一整棵树。`root` 为空时返回空布局（界面自己显示"补上中心主题"）。
 * `opts` 不传 = 桌面版那套间距（行为与 M4 完全一致）。
 */
export function layoutTree(root?: TreeNode, opts?: LayoutOptions): TreeLayout {
  if (!root) return { ...EMPTY, byId: new Map(), order: [] };

  const gapX = opts?.gapX ?? GAP_X;
  const gapY = opts?.gapY ?? GAP_Y;
  const pad = opts?.pad ?? PAD;

  const tree = measureTree(root, 0, gapY);

  // ── 第二趟：层对齐（同深度左边缘一致，看起来才是"层次"而不是"随机树"）
  const layerWidth: number[] = [];
  const walkLayers = (item: Measured) => {
    layerWidth[item.depth] = Math.max(layerWidth[item.depth] ?? 0, item.size.w);
    item.children.forEach(walkLayers);
  };
  walkLayers(tree);

  const layerX: number[] = [];
  for (let depth = 0; depth < layerWidth.length; depth += 1) {
    layerX[depth] =
      depth === 0 ? pad : layerX[depth - 1] + layerWidth[depth - 1] + gapX;
  }

  // ── 第三趟：前序分配 y（父节点在自己的区间里居中，子节点依次往下排）
  const nodes: LayoutNode[] = [];
  const place = (item: Measured, top: number) => {
    const { node, size } = item;
    nodes.push({
      id: node.id,
      x: layerX[item.depth],
      y: top + (item.height - size.h) / 2 + pad,
      w: size.w,
      h: size.h,
      depth: item.depth,
      hasChildren: node.children.length > 0,
      hiddenCount: node.collapsed ? countDescendants(node) : 0,
      text: node.text,
      assetPath: node.assetPath,
      sourceInfoId: node.sourceInfoId,
      collapsed: node.collapsed,
    });

    if (item.children.length === 0) return;
    const stack =
      item.children.reduce((sum, child) => sum + child.height, 0) +
      (item.children.length - 1) * gapY;
    let cursor = top + (item.height - stack) / 2;
    for (const child of item.children) {
      place(child, cursor);
      cursor += child.height + gapY;
    }
  };
  place(tree, 0);

  const byId = new Map(nodes.map((node) => [node.id, node]));

  // ── 连线：父右中点 → 子左中点
  const edges: LayoutEdge[] = [];
  const link = (item: Measured) => {
    const parent = byId.get(item.node.id);
    if (!parent) return;
    for (const child of item.children) {
      const childNode = byId.get(child.node.id);
      if (!childNode) continue;
      edges.push({
        from: parent.id,
        to: childNode.id,
        px: parent.x + parent.w,
        py: parent.y + parent.h / 2,
        cx: childNode.x,
        cy: childNode.y + childNode.h / 2,
      });
      link(child);
    }
  };
  link(tree);

  const width = nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + pad;
  const height = nodes.reduce((max, node) => Math.max(max, node.y + node.h), 0) + pad;

  // 阅读顺序：先按 y（自上而下），同一水平带上按 x
  const order = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);

  return { nodes, edges, width, height, byId, order };
}

/** 连线路径（三次贝塞尔，思维导图那种柔顺的曲线）；`gapX` 不传就用桌面那套 */
export function edgePath(edge: LayoutEdge, gapX: number = GAP_X): string {
  const half = gapX * 0.5;
  return [
    `M ${edge.px} ${edge.py}`,
    `C ${edge.px + half} ${edge.py}`,
    `${edge.cx - half} ${edge.cy}`,
    `${edge.cx} ${edge.cy}`,
  ].join(" ");
}

/**
 * 连线路径 · **小米思维笔记那种「括号式」**（2026-10-06，用户钦点：手机版照搬小米）。
 *
 * 形状：从父节点右边缘**横着出去一小段** → **竖着**对齐到子节点的中线 → 再**横着**进子节点左边缘，
 * 三个拐角都是小圆角。跟贝塞尔的区别只是"看着更像思维笔记、不那么柔"——**跟同步毫无关系**
 * （连线是纯渲染，一个字节都不落盘），所以电脑版继续用贝塞尔，两边各看各的。
 */
export function bracketPath(edge: LayoutEdge, radius = 6): string {
  const lead = Math.max(6, edge.cx - edge.px) * 0.45; // 先横着出去多远
  const x1 = edge.px + lead;
  const dir = edge.cy >= edge.py ? 1 : -1; // 往下还是往上拐
  const r = Math.min(radius, Math.abs(edge.cy - edge.py) / 2, lead);
  if (Math.abs(edge.cy - edge.py) < 1) {
    // 一条直线（父子在同一个高度）—— 直接横着连，别画多余的拐角
    return `M ${edge.px} ${edge.py} L ${edge.cx} ${edge.cy}`;
  }
  return [
    `M ${edge.px} ${edge.py}`,
    `L ${x1 - r} ${edge.py}`,
    `Q ${x1} ${edge.py} ${x1} ${edge.py + dir * r}`,
    `L ${x1} ${edge.cy - dir * r}`,
    `Q ${x1} ${edge.cy} ${x1 + r} ${edge.cy}`,
    `L ${edge.cx} ${edge.cy}`,
  ].join(" ");
}

/** 拖拽落点落在节点的哪一段 */
export type DropZone = "before" | "inside" | "after";

export interface HitResult {
  node: LayoutNode;
  zone: DropZone;
}

/**
 * 命中测试（**世界坐标**，调用方自己把屏幕坐标换算过来）。
 *
 * 三段判定：
 * - 上 28% → 插到它**前面**（同级）
 * - 下 28% → 插到它**后面**（同级）
 * - 中间 44% → 变成它的**子节点**
 *
 * 从后往前遍历：后画的节点在上层，命中优先（节点不会重叠，但保持这个习惯）。
 */
export function hitTest(layout: TreeLayout, wx: number, wy: number): HitResult | null {
  for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
    const node = layout.nodes[index];
    if (wx < node.x || wx > node.x + node.w) continue;
    if (wy < node.y || wy > node.y + node.h) continue;
    const relative = (wy - node.y) / node.h;
    const zone: DropZone = relative < 0.28 ? "before" : relative > 0.72 ? "after" : "inside";
    return { node, zone };
  }
  return null;
}

/** 缩放范围（下限定 0.4：再小就什么都看不清了，宁可让用户平移） */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2;

/** 把缩放值夹到合法范围 */
export function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export interface Viewport {
  /** 世界层平移（屏幕像素） */
  tx: number;
  ty: number;
  /** 缩放倍数 */
  k: number;
}

/**
 * 算出"把整张图塞进视口"的视口参数（首次进入 / 切笔记 / 点 ⌖ 归位都用它）。
 *
 * 缩放上限是 **1**：图小的时候不要放大到糊脸，1:1 就是最舒服的阅读比例。
 */
export function fitViewport(
  layout: TreeLayout,
  viewW: number,
  viewH: number,
): Viewport {
  if (layout.width <= 0 || layout.height <= 0 || viewW <= 0 || viewH <= 0) {
    return { tx: 0, ty: 0, k: 1 };
  }
  const margin = 24;
  const k = clampScale(
    Math.min(1, (viewW - margin * 2) / layout.width, (viewH - margin * 2) / layout.height),
  );
  const tx = (viewW - layout.width * k) / 2;
  const ty = (viewH - layout.height * k) / 2;
  return { tx, ty, k };
}

/** 以某个屏幕点为锚缩放（滚轮缩放用它，手感才是"往光标那儿推"） */
export function zoomAt(viewport: Viewport, nextScale: number, sx: number, sy: number): Viewport {
  const k = clampScale(nextScale);
  const ratio = k / viewport.k;
  return {
    k,
    tx: sx - (sx - viewport.tx) * ratio,
    ty: sy - (sy - viewport.ty) * ratio,
  };
}

/** 屏幕坐标 → 世界坐标 */
export function screenToWorld(viewport: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - viewport.tx) / viewport.k, y: (sy - viewport.ty) / viewport.k };
}
