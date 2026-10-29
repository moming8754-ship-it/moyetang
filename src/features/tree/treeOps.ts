/**
 * 树状图上要用的**只读**小工具（M4）。
 *
 * ⚠️ 这里没有"改树"的函数 —— 改树一律走后端 `note_tree_*` 命令
 * （Rust 侧读盘拿最新再改，前端不可能覆盖掉别人写进去的节点）。
 * 留下的是布局、提示文案和**拖拽合法性预检**要用的查询。
 *
 * 拖拽预检的规则与 Rust `store::tree::move_node` 一一对应：
 * 前端拦是为了体验（拖的时候就知道不行、不给落点高亮），
 * 后端拦才是保证（前端漏了也不会真把一枝树弄丢）。
 */
import type { DropPosition, TreeNode } from "../types";
import type { DropZone } from "./layout";

/** 按 id 找节点 */
export function findNode(root: TreeNode | undefined, id: string): TreeNode | undefined {
  if (!root) return undefined;
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/** 节点的父节点 */
export function parentOf(root: TreeNode | undefined, id: string): TreeNode | undefined {
  if (!root) return undefined;
  if (root.children.some((child) => child.id === id)) return root;
  for (const child of root.children) {
    const hit = parentOf(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/** 整棵子树的节点数（含自己）—— "将删除 N 个节点"就是它 */
export function countNodes(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + countNodes(child), 1);
}

/** `id` 是不是 `ancestorId` 自己或它的后代（防环判定） */
export function isSelfOrDescendant(
  root: TreeNode | undefined,
  ancestorId: string,
  id: string,
): boolean {
  const ancestor = findNode(root, ancestorId);
  if (!ancestor) return false;
  return findNode(ancestor, id) !== undefined;
}

export interface MoveCheck {
  ok: boolean;
  /** 不行的时候给用户看的理由（拖拽时显示在浮标里） */
  reason?: string;
}

/**
 * 拖拽落点预检：跟 Rust `move_node` 的规则**逐条对齐**。
 *
 * 前端的价值是"拖的时候就看得出不行"（不给落点高亮、浮标写清理由），
 * 后端的价值是"就算前端漏了也不会真丢一枝"。
 */
export function checkMove(
  root: TreeNode | undefined,
  nodeId: string,
  targetId: string,
  zone: DropZone,
): MoveCheck {
  if (!root) return { ok: false, reason: "这棵树还没有中心主题" };
  if (nodeId === targetId) return { ok: false, reason: "这就是它自己" };

  if (nodeId === root.id) {
    return { ok: false, reason: "中心主题是整棵树的根，不能挪走" };
  }
  if (isSelfOrDescendant(root, nodeId, targetId)) {
    return { ok: false, reason: "不能把节点放进它自己的分支里" };
  }
  if (targetId === root.id && zone !== "inside") {
    return { ok: false, reason: "中心主题没有同级节点" };
  }
  return { ok: true };
}

/** 落点 → 后端要的 `DropPosition` */
export function zoneToPosition(zone: DropZone): DropPosition {
  return zone === "before" ? "before" : zone === "after" ? "after" : "child";
}

/**
 * 记下一个节点"现在挂在哪、排第几、整枝长什么样"。
 *
 * **撤销「删掉整枝」全靠它**：删之前先记下来，撤销时用
 * `note_tree_insert(父节点, index, subtree)` 原样插回去。
 * 找不到就返回 null（那就退化成"这一步不可撤销"，总比撤错了强）。
 */
export interface NodePlacement {
  parentId: string;
  index: number;
  subtree: TreeNode;
}

export function snapshotPlacement(
  root: TreeNode | undefined,
  nodeId: string,
): NodePlacement | null {
  if (!root || root.id === nodeId) return null; // 根节点不能被删/移，也就没有"原位"
  const parent = parentOf(root, nodeId);
  const node = findNode(root, nodeId);
  if (!parent || !node) return null;
  const index = parent.children.findIndex((child) => child.id === nodeId);
  if (index < 0) return null;
  return { parentId: parent.id, index, subtree: node };
}

/**
 * 把"移动某个节点"这一步反过来表述成一条可执行的命令参数。
 *
 * `move` 只接受「放到某个节点的 前面/后面/里面」，没有"插回第 N 位"这种写法，
 * 所以撤销时得按**原来的兄弟**来定位：原来是第一个就放到"下一个兄弟的前面"，
 * 否则放到"上一个兄弟的后面"；原来那个父节点没别的孩子就直接放进去。
 */
export function inverseMove(
  root: TreeNode | undefined,
  nodeId: string,
): { targetId: string; position: DropPosition } | null {
  const place = snapshotPlacement(root, nodeId);
  if (!place) return null;
  const parent = findNode(root, place.parentId);
  if (!parent) return null;
  const siblings = parent.children.filter((child) => child.id !== nodeId);

  if (siblings.length === 0) {
    // 那个父节点底下只有它 → 直接放回去当唯一的孩子
    return { targetId: parent.id, position: "child" };
  }
  if (place.index === 0) {
    return { targetId: siblings[0].id, position: "before" };
  }
  const prev = siblings[Math.min(place.index - 1, siblings.length - 1)];
  return { targetId: prev.id, position: "after" };
}

/** 删除节点前给二次确认弹窗写的提示。 */
export function removeHint(root: TreeNode | undefined, nodeId: string): string {
  const node = findNode(root, nodeId);
  if (!node) return "这个节点已经不在了。";
  const total = countNodes(node);
  const label = node.text.trim() || "（空节点）";
  if (total <= 1) {
    return `将删除节点「${label}」。`;
  }
  // ⚠️ 弹窗是**纯文本**，别在这里写 Markdown 星号 —— 会原样显示出来（验收时看到过）
  return `「${label}」下面还有 ${total - 1} 个节点，会连同整个分支一起删除（共 ${total} 个节点）。`;
}
