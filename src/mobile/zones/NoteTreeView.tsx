/**
 * 手机端「树」的卡片外壳（P2-B′，2026-10-06）。
 *
 * 布局与观感**照电脑版画布**（根在左、子节点逐层向右）—— 画布本体在 `TreeCanvasMobile`，
 * 这里只管外面这张卡片、节点总数与那句说明。
 *
 * 🔴 只读：手机上看树不改数据；改树回电脑版（P0-1 的「幂等追加」红线不动）。
 */
import type { TreeNode } from "../../features/types";
import TreeCanvasMobile, { countNodes } from "./TreeCanvasMobile";

interface NoteTreeViewProps {
  root: TreeNode | null | undefined;
  /** 点〔联动信息〕小标时跳回信息区（手机端目前没接跳转，留口子） */
  onOpenInfo?: (infoId: string) => void;
}

export default function NoteTreeView({ root, onOpenInfo }: NoteTreeViewProps) {
  const total = root ? countNodes(root) : 0;
  return (
    <div
      data-mcog-tree
      data-mcog-tree-count={total}
      data-mnote-tree
      className="mb-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12px] font-semibold text-slate-500">树状图</p>
        <span className="text-[11px] tabular-nums text-slate-400">{total} 个节点</span>
      </div>

      {!root ? (
        <p data-mcog-tree-empty className="text-[12.5px] text-slate-400">
          这篇树还没有节点
        </p>
      ) : (
        <TreeCanvasMobile root={root} onOpenInfo={onOpenInfo} />
      )}

      <p data-mcog-tree-hint className="mt-2 text-[11.5px] text-slate-400">
        跟电脑版同一套布局（根在左、往右长）；手机上先只能看、不能改树。「＋N」点开只影响这次查看，不改盘。
      </p>
    </div>
  );
}
