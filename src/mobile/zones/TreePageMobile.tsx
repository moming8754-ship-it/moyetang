/**
 * 手机端「树」的**整屏页**（P2-D / 树 B，2026-10-06）。
 *
 * 用户原话：「你不觉得太小了吗，光是看就不够用了，不如干脆一点，手机版就直接照搬小米笔记思维笔记的页面」。
 * 所以这一页**没有卡片外壳、没有「树/文本」切换**：
 *   顶栏（返回 / 标题 / ⋮）＋ **满屏树** ＋ 底排 4 颗图标，其余全给画布。
 *
 * # 底排那 4 颗（对"选中的节点"生效；没选中就灰着）
 * 🗑 删掉这个节点（连它下面一起，**先二次确认**）· ➜⊕ 加子节点 · ⤵⊕ 加同级 · 🖼 给它挂张图
 *
 * # 三条别改坏
 * ① **写盘只走操作式命令**（`note_tree_add_child` / `set_text` / `remove` / `move` / `set_image`），
 *    每次都拿后端返回的整篇笔记刷新界面 —— **绝不许**在手机上拼一棵新树写回去（P0-1 红线：
 *    那边还有电脑改过的节点，整棵覆盖就抹掉了）。
 * ② **正文没有消失**：树笔记的正文（`-[]` 待办那些）走 ⋮ 菜单里的「编辑正文」——
 *    这条路就是原来的文本页（P0-1 的「幂等追加」）；只是不再在顶栏摆一个"树/文本"切换。
 * ③ 底排是 flex 列的最后一个孩子 → 键盘弹起时**自然贴在键盘上沿**（`visualViewport` 兜底同 P2-C）。
 *
 * # 验收抓手（`tools\m19` 依赖）
 * `data-mctree-page` · `data-mctree-back` · `data-mctree-menu` · `data-mctree-menu-text`
 * `data-mctree-btn`(`remove`/`child`/`sibling`/`image`) · `data-mctree-actions` · `data-mctree-image-input`
 */
import { useEffect, useRef, useState } from "react";
import {
  assetWriteImage,
  noteExportDownloads,
  noteTreeAddChild,
  noteTreeAddSibling,
  noteTreeMove,
  noteTreeRemove,
  noteTreeSetImage,
  noteTreeSetText,
} from "../../features/api";
import type { Note, TreeNode } from "../../features/types";
import { fileToBase64 } from "../../shared/imageFile";
import { useUi } from "../../store/ui";
import ImageViewer from "../../components/ImageViewer";
import TreeCanvasMobile, { countNodes } from "./TreeCanvasMobile";

interface TreePageMobileProps {
  note: Note;
  /** 返回列表 */
  onBack: () => void;
  /** 点〔联动信息〕小标 → 跳回信息区 */
  onOpenInfo?: (infoId: string) => void;
  /** 每次操作后后端返回的整篇笔记 → 外层拿它刷新（**唯一的真源**） */
  onNoteChanged: (note: Note) => void;
  /** ⋮ →「编辑正文」：去原来的文本页（`-[]` 待办那条路） */
  onEditText: () => void;
}

/** 键盘挡住的高度（px）：`adjustResize` 时是 0；被盖住时把底排顶上去 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      setInset(overlap > 80 ? Math.round(overlap) : 0);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  return inset;
}

export default function TreePageMobile({
  note,
  onBack,
  onOpenInfo,
  onNoteChanged,
  onEditText,
}: TreePageMobileProps) {
  const toast = useUi((s) => s.toast);
  const askConfirm = useUi((s) => s.askConfirm);
  const inset = useKeyboardInset();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 点节点缩略图 → 看大图（2026-10-07 补：原来手机端点不开） */
  const [viewImg, setViewImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const root: TreeNode | null = note.root ?? null;
  const total = root ? countNodes(root) : 0;

  // 换笔记 → 选中与编辑态归位（不然会指到上一篇的节点 id 上）
  useEffect(() => {
    setSelectedId(null);
    setEditingId(null);
    setMenuOpen(false);
  }, [note.id]);

  /**
   * M27（v2.18.0）：把这篇树**存成文件**到手机「下载/东方摩耶堂/」。
   *
   * 导出的内容是「正文 + `## 大纲` 嵌套列表」（渲染逻辑在 Rust `store::export::tree_outline`），
   * 节点上挂的图会一起存进 `<笔记名>.assets/` 并把链接改成相对路径。
   */
  const exportTree = async () => {
    setMenuOpen(false);
    try {
      const report = await noteExportDownloads(note.id, "md", true);
      toast(
        `已存到「${report.file}」${report.images > 0 ? `（连 ${report.images} 张图）` : ""}`,
        "success",
      );
    } catch (error) {
      toast("存文件失败：" + String(error), "error");
    }
  };

  const run = async (label: string, task: () => Promise<{ note: Note; focusNodeId: string | null; removed?: number }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await task();
      onNoteChanged(result.note);
      return result;
    } catch (error) {
      toast(`${label}没成功：${String(error)}`, "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const addChild = async () => {
    if (!selectedId) return;
    await flushEdit();
    const result = await run("加子节点", () => noteTreeAddChild(note.id, selectedId, ""));
    if (result) {
      setSelectedId(result.focusNodeId);
      setEditingId(result.focusNodeId); // 新建的节点直接进改字状态（少点一下）
    }
  };

  const addSibling = async () => {
    if (!selectedId) return;
    await flushEdit();
    const result = await run("加同级", () => noteTreeAddSibling(note.id, selectedId, ""));
    if (result) {
      setSelectedId(result.focusNodeId);
      setEditingId(result.focusNodeId);
    }
  };

  const removeOne = () => {
    if (!selectedId) return;
    askConfirm({
      title: "删掉这个节点？",
      message: "它下面的子节点会一起删掉（删了之后两端同步也会跟着删，不是「只在这台设备上消失」）。",
      confirmText: "删掉",
      danger: true,
      onConfirm: () => {
        void (async () => {
          const result = await run("删除", () => noteTreeRemove(note.id, selectedId));
          if (result) {
            setSelectedId(result.focusNodeId);
            toast(result.removed && result.removed > 1 ? `删了 ${result.removed} 个节点` : "删掉了");
          }
        })();
      },
    });
  };

  const pickImage = async (file: File) => {
    if (!selectedId) return;
    try {
      const base64 = await fileToBase64(file);
      const rel = await assetWriteImage(base64);
      const result = await run("挂图", () => noteTreeSetImage(note.id, selectedId, rel));
      if (result) toast("图挂到节点上了（存在 assets/ 里）");
    } catch (error) {
      toast("挂图没成功：" + String(error), "error");
    }
  };

  const commitText = async (nodeId: string, text: string) => {
    setEditingId(null);
    const before = findText(root, nodeId);
    if (before !== null && before === text) return; // 没改就别白写一次盘
    await run("改文字", () => noteTreeSetText(note.id, nodeId, text));
  };

  /**
   * 🔴 2026-10-20（用户反馈 #3）：「**节点打完字，直接点「加同级」，刚打的字全消失了**」。
   *
   * 病根：底排那几颗按钮都写了 `onPointerDown={(e) => e.preventDefault()}`（为了防止按下时
   * 抢走焦点、把软键盘顶掉），副作用是 —— **编辑框永远不会 blur**，而改字是**只在 blur 时提交**的
   * （`TreeCanvasMobile` 的 `onBlur` → `onCommitText`）。于是点「加同级」时：刚打的字**还没落盘**，
   * 而 `noteTreeAddSibling` 拿的是**盘上那棵旧树**，回来的结果一 `onNoteChanged` 覆盖本地状态 →
   * **刚打的字就没了**。
   *
   * 修法：编辑框每敲一下就把当前文字存进这个 ref（`onDraftChange`），底排动作**动手之前
   * 先 `flushEdit()` 把它落盘**（并 await 完），再去做加节点/删节点。
   * ⇒ 顺序变成"先存字、再加节点"，字就不会被旧树覆盖。
   */
  const draftRef = useRef<{ id: string; text: string } | null>(null);
  const flushEdit = async () => {
    const pending = draftRef.current;
    draftRef.current = null;
    if (!pending || !pending.id) return;
    await commitText(pending.id, pending.text);
  };

  const moveNode = async (nodeId: string, targetId: string) => {
    const result = await run("移动节点", () => noteTreeMove(note.id, nodeId, targetId, "child"));
    if (result) toast("挪过去了");
  };

  const hasSelection = Boolean(selectedId);

  return (
    <div
      data-mctree-page
      data-mctree-note={note.id}
      // ⚠️ `data-mnote-tree` / `data-mcog-tree*` / `data-mcog-note` / `data-mcog-title` / `data-mcog-back`
      //    都是**验收抓手**（`tools\m19` 靠它们找页面、数节点、判断"有没有打开笔记"）：
      //    树页就是"手机上的树视图 + 打开了某篇笔记"，这些标记跟着它走（别因为换了页面就把抓手弄丢）。
      data-mnote-tree
      data-mcog-tree
      data-mcog-note={note.id}
      data-mcog-tree-count={total}
      className="flex h-full flex-col bg-white dark:bg-slate-900"
    >
      {/* 顶栏：返回 / 标题 / ⋮（⋮ 里放着「编辑正文」—— 树页不再摆"树/文本"切换） */}
      <header className="relative flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <button
          type="button"
          data-mctree-back
          data-mcog-back
          onClick={onBack}
          className="shrink-0 px-1 text-[13px] text-indigo-600 dark:text-indigo-300"
        >
          ‹ 返回
        </button>
        <p
          data-mctree-title
          data-mcog-title
          className="min-w-0 flex-1 truncate text-[13px] font-semibold"
        >
          {note.title || "未命名笔记"}
        </p>
        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{total} 节点</span>
        <button
          type="button"
          data-mctree-menu
          onClick={() => setMenuOpen((was) => !was)}
          className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[12px] dark:border-slate-700"
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="absolute right-2 top-full z-40 mt-1 w-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <button
              type="button"
              data-mctree-menu-text
              onClick={() => {
                setMenuOpen(false);
                onEditText();
              }}
              className="block w-full px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:active:bg-slate-800"
            >
              编辑正文
            </button>
            {/* M27（v2.18.0）：树笔记也存成文件（正文 + Markdown 大纲，图一起带走） */}
            <button
              type="button"
              data-mctree-menu-export
              onClick={() => void exportTree()}
              className="block w-full border-t border-slate-100 px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-800"
            >
              存到手机（Markdown）
            </button>
          </div>
        )}
      </header>

      {/* 满屏画布：整页剩下的地方全给它（用户要的就是"够大"） */}
      <div className="min-h-0 flex-1">
        {root ? (
          <TreeCanvasMobile
            root={root}
            fill
            onOpenInfo={onOpenInfo}
            onOpenImage={setViewImg}
            selectedId={selectedId}
            editingId={editingId}
            onSelect={(id) => {
              setSelectedId(id);
              setMenuOpen(false);
            }}
            onEditRequest={(id) => setEditingId(id)}
            onCommitText={(id, text) => void commitText(id, text)}
            // 每敲一下就把「正在改的那一格」记下来 —— 底排按钮动手前要拿它先落盘（见 flushEdit）
            onDraftChange={(id, text) => {
              draftRef.current = { id, text };
            }}
            onCancelEdit={() => {
              draftRef.current = null;
              setEditingId(null);
            }}
            onMoveNode={(id, target) => void moveNode(id, target)}
          />
        ) : (
          <p data-mctree-empty data-mcog-tree-empty className="p-4 text-[12.5px] text-slate-400">
            这篇树还没有节点（回电脑版建第一个节点，或者用 ⋮ →「编辑正文」写几行）
          </p>
        )}
      </div>

      {/* 底排 4 颗：对"选中的节点"生效 —— ⚠️ 留在 flex 列最后，键盘弹起时贴在键盘上沿 */}
      <div
        data-mctree-actions
        style={inset > 0 ? { transform: `translateY(-${inset}px)` } : undefined}
        className="flex shrink-0 items-center justify-around border-t border-slate-200 bg-white/95 py-2 dark:border-slate-800 dark:bg-slate-900/95"
      >
        {[
          { key: "remove", label: "🗑", hint: "删掉选中的节点（连子节点一起）", run: removeOne },
          { key: "child", label: "➜⊕", hint: "给它加一个子节点", run: () => void addChild() },
          { key: "sibling", label: "⤵⊕", hint: "在它后面加一个同级节点", run: () => void addSibling() },
          { key: "image", label: "🖼", hint: "给它挂一张图（存进 assets/）", run: () => fileRef.current?.click() },
        ].map((one) => (
          <button
            key={one.key}
            type="button"
            data-mctree-btn={one.key}
            data-mctree-btn-active={hasSelection ? "1" : "0"}
            title={one.hint}
            disabled={!hasSelection || busy}
            onPointerDown={(event) => event.preventDefault()}
            onClick={one.run}
            className={
              "flex h-10 w-16 items-center justify-center rounded-xl border text-[15px] transition-colors " +
              (hasSelection
                ? "border-slate-200 text-slate-700 active:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
                : "border-transparent text-slate-300 dark:text-slate-600")
            }
          >
            {one.label}
          </button>
        ))}
        <input
          ref={fileRef}
          data-mctree-image-input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = ""; // 清掉：同一张图选第二次也要能触发
            if (file) void pickImage(file);
          }}
        />
      </div>

      {/* 看大图：点节点里的缩略图打开（共用组件，跟信息区/奖状同一套） */}
      {viewImg && <ImageViewer relPath={viewImg} onClose={() => setViewImg(null)} />}

      <p className="shrink-0 pb-1 text-center text-[10.5px] text-slate-400">
        点节点选中 · 再点一下改字 · 长按拖到别的节点上就挪过去
      </p>
    </div>
  );
}

/** 在树里找某个节点的文字（提交前比一下"到底改没改"） */
function findText(node: TreeNode | null, id: string): string | null {
  if (!node) return null;
  if (node.id === id) return node.text;
  for (const child of node.children ?? []) {
    const hit = findText(child, id);
    if (hit !== null) return hit;
  }
  return null;
}
