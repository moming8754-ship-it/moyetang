/**
 * 树状图笔记的编辑面板（M4）。
 *
 * 结构：标题栏（标题 / 状态 / 删除笔记）
 *      → {@link TreeCanvas}（真画布）
 *
 * # 写盘怎么走（这是 M4 最关键的一处决定）
 * 每个动作都调一条 `note_tree_*` 命令，Rust 侧**读盘拿最新 → 改一处 → 原子写**。
 * **不是**"前端改完整棵树再整篇写回"—— 那样有个真实的覆盖竞态：
 * 树笔记会被后端自己改（`info_link_note` 往根节点下加联动节点），
 * 前端握着一份旧树写回就把刚联动进来的节点抹掉了。操作式读的是盘上最新版，
 * 结构上不可能覆盖掉别人写的东西（`store::tree` 里有专门的回归测试）。
 *
 * 顺带的好处：没有防抖、没有串行队列、没有序号守卫 ——
 * 那些是给"边打字边保存"的文本编辑器用的，树状图的文字只在**提交那一刻**写一次盘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import TreeCanvas from "./TreeCanvas";
import type { HistoryInfo, TreeActions, TreeCanvasApi } from "./TreeCanvas";
import type { DropZone } from "./layout";
import {
  findNode,
  inverseMove,
  removeHint,
  snapshotPlacement,
  zoneToPosition,
} from "./treeOps";
import ImageViewer from "../../components/ImageViewer";
import * as api from "../api";
import { inTauri } from "../api";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { formatStamp } from "../../shared/daytime";
import type { Note, TreeOpResult } from "../types";

/**
 * 撤销栈里的一格。
 *
 * 为什么是"正反两条命令"而不是"存一份旧树、撤销时整篇写回"：
 * 树笔记会被后端自己改（`info_link_note` 加联动节点），整篇写回会把那些改动抹掉 ——
 * 跟前面说的覆盖竞态是同一个坑。所以撤销也走 `note_tree_*`，只把**该改的那一处**改回去。
 */
interface HistoryEntry {
  /** 给 toast / 按钮 title 看的人话，如"删除节点" */
  label: string;
  undo: () => Promise<TreeOpResult | null>;
  redo: () => Promise<TreeOpResult | null>;
}

/** 撤销栈上限（够用了；再多的历史意义不大，还占内存） */
const HISTORY_LIMIT = 60;

interface TreeNotePaneProps {
  note: Note;
  /** 刚新建的笔记：标题直接选中，方便改名 */
  autoFocusTitle?: boolean;
}

/** 图片文件 → base64（Rust 那边收 base64 再落盘） */
async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // 一次别塞太多，`String.fromCharCode(...)` 参数过多会爆栈
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export default function TreeNotePane({ note, autoFocusTitle }: TreeNotePaneProps) {
  const applyTreeOp = useData((state) => state.applyTreeOp);
  const setTreeTitle = useData((state) => state.setTreeTitle);
  const ensureTreeRoot = useData((state) => state.ensureTreeRoot);
  const setFocusRef = useData((state) => state.setFocusRef);
  const setView = useUi((state) => state.setView);
  const askConfirm = useUi((state) => state.askConfirm);
  const toast = useUi((state) => state.toast);

  const [title, setTitle] = useState(note.title);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 拖图片进来时高亮的节点 */
  const [imageDropId, setImageDropId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  /** 标题改过还没落盘（防抖保存用，见 `commitTitle`） */
  const titleDirtyRef = useRef(false);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<TreeCanvasApi | null>(null);
  /** 拖放事件的回调里要读最新值，别用闭包里的旧值 */
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // ── 撤销 / 重做（用户反馈："我习惯性 Ctrl+Z，可它撤的是标题"）
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  /** 栈是 ref（不想每次入栈都重渲染整棵树），靠这个计数把按钮状态带出来 */
  const [historyTick, setHistoryTick] = useState(0);
  /** 进入编辑那一刻这个节点的原文 —— 一次编辑算**一步**撤销，中间打的字不逐步记 */
  const editStartText = useRef<string | null>(null);

  const root = note.root;
  /** 这棵树一共几个节点（标题栏显示） */
  const nodeTotal = useMemo(() => (root ? countAll(root) : 0), [root]);

  useEffect(() => {
    if (!autoFocusTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [autoFocusTitle]);

  /** 跑一条树操作：统一 busy 标记 + 错误 Toast（错误文案由后端给，都是人话） */
  const run = useCallback(
    async (make: () => Promise<TreeOpResult>): Promise<TreeOpResult | null> => {
      setBusy(true);
      try {
        return await applyTreeOp(make);
      } finally {
        setBusy(false);
      }
    },
    [applyTreeOp],
  );

  /** 操作成功后把焦点给到该给的节点（新建 → 顺便进入编辑） */
  const focusResult = useCallback((result: TreeOpResult | null, enterEdit: boolean) => {
    if (!result?.focusNodeId) return;
    setSelectedId(result.focusNodeId);
    if (enterEdit) setEditingId(result.focusNodeId);
  }, []);

  /** 记一步进撤销栈（`null` 表示这一步不记） */
  const record = useCallback((entry: HistoryEntry | null) => {
    if (!entry) return;
    undoStack.current.push(entry);
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = []; // 有新动作就把"重做"这条线掐掉（标准行为）
    setHistoryTick((tick) => tick + 1);
  }, []);

  /**
   * 撤销一步。
   *
   * 撤销/重做自己**不进栈**（否则 Ctrl+Z 会自己套自己）；
   * 失败时把那一格**塞回去** —— 不能因为一次失败就把用户的操作记录弄丢。
   */
  const stepHistory = useCallback(
    async (direction: "undo" | "redo") => {
      const from = direction === "undo" ? undoStack : redoStack;
      const to = direction === "undo" ? redoStack : undoStack;
      const entry = from.current.pop();
      if (!entry) {
        toast(direction === "undo" ? "没有可撤销的操作了" : "没有可重做的操作了", "info");
        return;
      }
      setHistoryTick((tick) => tick + 1);
      const result = await entry[direction]();
      if (!result) {
        from.current.push(entry);
        setHistoryTick((tick) => tick + 1);
        return;
      }
      to.current.push(entry);
      setHistoryTick((tick) => tick + 1);
      setEditingId(null);
      setSelectedId(result.focusNodeId ?? null);
      toast(
        `${direction === "undo" ? "已撤销" : "已重做"}：${entry.label}`,
        "success",
      );
    },
    [toast],
  );

  const history: HistoryInfo = useMemo(() => {
    // historyTick 只是用来在入栈/出栈后让这里重新算一遍
    void historyTick;
    const undoTop = undoStack.current[undoStack.current.length - 1] ?? null;
    const redoTop = redoStack.current[redoStack.current.length - 1] ?? null;
    return {
      canUndo: !!undoTop,
      canRedo: !!redoTop,
      undoLabel: undoTop?.label ?? null,
      redoLabel: redoTop?.label ?? null,
      undo: () => void stepHistory("undo"),
      redo: () => void stepHistory("redo"),
    };
  }, [stepHistory, historyTick]);

  /**
   * 加节点。`sibling` 落在**根节点**上时退化成"加子节点"
   * —— 中心主题没有同级，而 Enter 在根上最自然的意思是"加一个顶层主题"。
   */
  const addNode = useCallback(
    async (id: string, mode: "child" | "sibling") => {
      const asChild = mode === "child" || id === root?.id;
      const again = () =>
        asChild
          ? api.noteTreeAddChild(note.id, id)
          : api.noteTreeAddSibling(note.id, id);
      const result = await run(again);
      focusResult(result, true);
      const newId = result?.focusNodeId;
      if (!newId) return;
      record({
        label: asChild ? "加子节点" : "加同级节点",
        undo: () => applyTreeOp(() => api.noteTreeRemove(note.id, newId)),
        // 重做时后端会生成新 uuid（同一个 id 不复用），树的样子一样就够了
        redo: () => applyTreeOp(again),
      });
    },
    [applyTreeOp, focusResult, note.id, record, root?.id, run],
  );

  /** 提交节点文字（没改就不写盘）；**不记撤销** —— 一次编辑算一步，由 `finishEdit` 记 */
  const commitText = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      const node = findNode(root, id);
      if (!node || node.text === text) return true;
      return (await run(() => api.noteTreeSetText(note.id, id, text))) !== null;
    },
    [note.id, root, run],
  );

  /**
   * 一次编辑结束（Esc / 失焦 / Enter / Tab）：存住文字 + **把这次编辑记成一步撤销**。
   *
   * 为什么不在每次自动保存时记：编辑态是防抖自动保存的，打一句话会落盘好几次，
   * 那样按一次 Ctrl+Z 只撤掉最后几个字，用户会以为撤销坏了。
   * 所以拿"进入编辑那一刻的原文"当基准，**一次编辑 = 一步撤销**。
   */
  const finishEdit = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      const started = editStartText.current;
      editStartText.current = null;
      const before = started ?? findNode(root, id)?.text ?? "";
      const saved = await commitText(id, text);
      if (saved && before !== text) {
        record({
          label: "改节点文字",
          undo: () => applyTreeOp(() => api.noteTreeSetText(note.id, id, before)),
          redo: () => applyTreeOp(() => api.noteTreeSetText(note.id, id, text)),
        });
      }
      return saved;
    },
    [applyTreeOp, commitText, note.id, record, root],
  );

  /** 给节点插/去图片（拖放和 Ctrl+V 共用一条路，都记一步撤销） */
  const attachImage = useCallback(
    async (nodeId: string, assetPath: string | null): Promise<boolean> => {
      const before = findNode(root, nodeId)?.assetPath ?? null;
      const result = await run(() => api.noteTreeSetImage(note.id, nodeId, assetPath));
      if (!result) return false;
      record({
        label: assetPath ? "插图片" : "去掉图片",
        undo: () => applyTreeOp(() => api.noteTreeSetImage(note.id, nodeId, before)),
        redo: () => applyTreeOp(() => api.noteTreeSetImage(note.id, nodeId, assetPath)),
      });
      return true;
    },
    [applyTreeOp, note.id, record, root, run],
  );

  const actions: TreeActions = useMemo(
    () => ({
      select: (id) => setSelectedId(id),

      startEdit: (id) => {
        // 记下"编辑开始时的原文"，作为这一步撤销的基准
        editStartText.current = findNode(root, id)?.text ?? "";
        setSelectedId(id);
        setEditingId(id);
      },

      commitEdit: (id, text) => {
        setEditingId(null);
        void finishEdit(id, text);
      },

      // 编辑态防抖自动保存：只存字，不退出编辑、不记撤销（见 finishEdit 的注释）
      saveText: (id, text) => {
        void commitText(id, text);
      },

      commitAndSibling: (id, text) => {
        setEditingId(null);
        void (async () => {
          // 文字没写进去就别往下建：不然"上一个字没存住但新节点建了"更让人困惑
          if (!(await finishEdit(id, text))) return;
          await addNode(id, "sibling");
        })();
      },

      commitAndChild: (id, text) => {
        setEditingId(null);
        void (async () => {
          if (!(await finishEdit(id, text))) return;
          await addNode(id, "child");
        })();
      },

      addChild: (id) => {
        void addNode(id, "child");
      },

      addSibling: (id) => {
        void addNode(id, "sibling");
      },

      remove: (id) => {
        if (id === root?.id) {
          toast("中心主题不能删（它是整棵树的根）", "info");
          return;
        }
        // 删之前先记下"原来挂在哪、排第几、整枝长什么样" —— 撤销全靠它插回去
        const place = snapshotPlacement(root, id);
        askConfirm({
          title: "删除这个节点？",
          message: `${removeHint(root, id)}\n\n删错了可以按 Ctrl+Z（或右下角 ↶）撤销。`,
          confirmText: "删除",
          danger: true,
          onConfirm: () => {
            void (async () => {
              const result = await run(() => api.noteTreeRemove(note.id, id));
              if (!result) return;
              setEditingId((current) => (current === id ? null : current));
              focusResult(result, false);
              record(
                place
                  ? {
                      label: result.removed > 1 ? "删除整枝" : "删除节点",
                      undo: () =>
                        applyTreeOp(() =>
                          api.noteTreeInsert(
                            note.id,
                            place.parentId,
                            place.index,
                            place.subtree,
                          ),
                        ),
                      redo: () => applyTreeOp(() => api.noteTreeRemove(note.id, id)),
                    }
                  : null,
              );
              toast(
                result.removed > 1
                  ? `已删除这一枝（共 ${result.removed} 个节点）`
                  : "已删除这个节点",
                "success",
              );
            })();
          },
        });
      },

      toggleCollapse: (id, collapsed) => {
        const before = findNode(root, id)?.collapsed ?? false;
        void (async () => {
          const result = await run(() => api.noteTreeSetCollapsed(note.id, id, collapsed));
          if (!result) return;
          record({
            label: collapsed ? "折叠分支" : "展开分支",
            undo: () => applyTreeOp(() => api.noteTreeSetCollapsed(note.id, id, before)),
            redo: () => applyTreeOp(() => api.noteTreeSetCollapsed(note.id, id, collapsed)),
          });
        })();
      },

      move: (nodeId, targetId, zone: DropZone) => {
        // 挪之前先算出"怎么挪回来"（见 treeOps.inverseMove）
        const back = inverseMove(root, nodeId);
        const position = zoneToPosition(zone);
        void (async () => {
          const result = await run(() => api.noteTreeMove(note.id, nodeId, targetId, position));
          if (!result) return;
          record(
            back
              ? {
                  label: "调整位置",
                  undo: () =>
                    applyTreeOp(() =>
                      api.noteTreeMove(note.id, nodeId, back.targetId, back.position),
                    ),
                  redo: () =>
                    applyTreeOp(() => api.noteTreeMove(note.id, nodeId, targetId, position)),
                }
              : null,
          );
          toast("已调整位置", "success");
        })();
      },

      setImage: (id, assetPath) => {
        void attachImage(id, assetPath);
      },

      openImage: (assetPath) => setLightbox(assetPath),

      openInfo: (infoId) => {
        setFocusRef({ kind: "info", id: infoId });
        setView("info");
      },
    }),
    [
      askConfirm,
      attachImage,
      applyTreeOp,
      finishEdit,
      focusResult,
      note.id,
      record,
      root,
      run,
      setFocusRef,
      setView,
      toast,
      addNode,
      commitText,
    ],
  );

  /**
   * **Ctrl+V 粘贴图片到节点**（用户反馈："图片已经在剪贴板里了，能不能直接粘"）。
   *
   * 剪贴板给的是**字节**、不是磁盘路径，所以走不了 `asset_import` ——
   * 前端转 base64 → `asset_write_image`（后端按魔数认格式）→ 再挂到节点上。
   * 剪贴板里是文字的话直接放过，走系统默认粘贴，不抢。
   */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageItem = Array.from(items).find(
        (one) => one.kind === "file" && one.type.startsWith("image/"),
      );
      if (!imageItem) return; // 不是图片 → 交回默认行为（文本照常粘贴）
      const target = editingId ?? selectedId; // 正在编辑的那个节点优先
      if (!target) {
        toast("先选一个节点（或双击进去编辑），再按 Ctrl+V", "info");
        return;
      }
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      void (async () => {
        try {
          const rel = await api.assetWriteImage(await fileToBase64(file));
          if (await attachImage(target, rel)) {
            setSelectedId(target);
            toast("图片已粘到这个节点上", "success");
          }
        } catch (error) {
          toast(`粘贴的图片没能插进去：${String(error)}`, "error");
        }
      })();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [attachImage, editingId, selectedId, toast]);

  /**
   * 把图片文件拖到节点卡片上 = 给这个节点插图片（M4-4）。
   *
   * 三图标是用户明确指定的三个，所以图片入口**不占图标位**，走原生拖放。
   * ⚠️ 事件里的 `position` 是**物理像素**，本机 150% 缩放，
   * 必须除以 `devicePixelRatio` 才是 CSS 像素，否则命中测试整体偏移。
   */
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setImageDropId(null);
          return;
        }

        const rect = canvasHostRef.current?.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const hit =
          rect && canvasRef.current
            ? canvasRef.current.hitTestScreen(
                payload.position.x / ratio - rect.left,
                payload.position.y / ratio - rect.top,
              )
            : null;

        if (payload.type === "over" || payload.type === "enter") {
          setImageDropId(hit?.node.id ?? null);
          return;
        }

        // type === "drop"
        setImageDropId(null);
        // 落在节点上就给那个节点；落在空白处就给当前选中的那个（手不用那么准）
        const target = hit?.node.id ?? selectedRef.current;
        if (!target) {
          toast("把图片拖到某张卡片上，就能插进那个节点", "info");
          return;
        }
        if (payload.paths.length === 0) return;
        if (payload.paths.length > 1) {
          toast(`一次给节点插一张图，先插了第一张（共拖进来 ${payload.paths.length} 张）`, "info");
        }
        void (async () => {
          try {
            const rel = await api.assetImport(payload.paths[0]);
            if (await attachImage(target, rel)) {
              setSelectedId(target);
              toast("图片已插到这个节点上", "success");
            }
          } catch (error) {
            toast(`图片没能插进去：${String(error)}`, "error");
          }
        })();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 监听拖放失败", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [attachImage, note.id, toast]);

  /**
   * 存标题。
   *
   * ⚠️ 这里修的是**验收时才逮到的一条真 bug**（两个坑叠在一起）：
   *
   * 1. 标题原本只在 `onBlur` 里保存，而 Tauri 的 WebView 里
   *    **程序化 `blur()` 触发 React `onBlur` 并不可靠** ——
   *    表现就是"改了标题、点了别处，标题悄悄变回原名"。
   *    `DocNotePane` 没这毛病是因为它有 900ms **防抖自动保存**兜底，所以这里对齐同一套。
   *
   * 2. **"卸载时补一刀"的 effect 依赖写错了**，比第 1 条更阴：
   *    ```tsx
   *    useEffect(() => () => void commitTitle(), [commitTitle]);  // ❌ 错的
   *    ```
   *    `commitTitle` 是个 useCallback、依赖里有 `title`，所以**每敲一个字它就换一个身份**，
   *    于是这个 effect 的 cleanup 每次都会跑 —— 用**上一轮渲染的旧闭包**（还是旧标题）
   *    把 `titleDirtyRef` 清成 false 并早退；防抖 effect 紧接着看到"不脏"，
   *    就不排计时器了。结果：标题永远存不上，或者整整慢一拍（用上一次的标题存）。
   *
   * 正确写法是下面这样：**unmount-only 的 effect 依赖必须是 `[]`**，
   * 真正要调的函数从 ref 里拿最新那份，这样闭包永远不会旧。
   */
  const commitTitle = async (done = false) => {
    if (!titleDirtyRef.current) return;
    const next = title.trim();
    if (next === note.title.trim()) {
      titleDirtyRef.current = false;
      return;
    }
    // ⚠️ 空标题**不在防抖路径落盘**：用户很可能"全选删掉、正在打新的"，
    // 这时候落盘会被后端兜底成「未命名笔记」、再被塞回输入框，把正在打的字搅乱
    // （用户实测反馈原话："我把'未命名笔记'全删了，它就会自动补全一个，影响我编辑标题"）。
    if (!next && !done) return;
    titleDirtyRef.current = false;
    const saved = await setTreeTitle(note.id, next);
    // 同理：只有用户**明确结束编辑**（Enter / 失焦）时才把兜底名字写回界面，
    // 正在输入时绝不回填
    if (saved && (done || document.activeElement !== titleInputRef.current)) {
      setTitle(saved.title);
    }
  };
  /** 每次渲染都指向最新那份 commitTitle（防抖和卸载补刀都通过它调，避开旧闭包） */
  const commitRef = useRef(commitTitle);
  commitRef.current = commitTitle;

  // 停下打字 900ms 就存一次（和 DocNotePane 一个节奏）
  // 依赖只放 `title`：它变一次就重新计时，别的一律不该重置这个计时器
  useEffect(() => {
    if (!titleDirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void commitRef.current();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [title]);

  // 离开这篇 / 切页面 / 关掉之前，把没存完的标题补上（`true` = 空标题也落盘兜底）。
  // ⚠️ 依赖必须是 `[]` —— 写成 `[commitTitle]` 就会每敲一个字跑一次 cleanup（见上面第 2 条）
  useEffect(() => {
    return () => {
      void commitRef.current(true);
    };
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      {/* 标题栏 */}
      <header className="flex shrink-0 items-start gap-3">
        <input
          ref={titleInputRef}
          value={title}
          onChange={(event) => {
            titleDirtyRef.current = true; // 变脏：防抖 + 失焦 + Enter 三条路都能救
            setTitle(event.target.value);
          }}
          onBlur={() => void commitTitle(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              // 直接提交，**不**依赖 blur()（见 commitTitle 上面那段注释：这里踩过坑）
              void commitTitle(true);
            }
          }}
          placeholder="笔记标题"
          className="min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1 text-lg font-semibold outline-none hover:border-slate-200 focus:border-indigo-300 focus:bg-white dark:hover:border-slate-700 dark:focus:border-indigo-500 dark:focus:bg-slate-900"
        />

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="mr-1 text-xs text-slate-400">
            {busy ? "保存中…" : "已保存"}
          </span>
          {/* 🔴 2026-10-11（v2.19.0 · 用户反馈第 12 条）：树笔记的「删除」也从这条顶栏挪走了
              —— 跟文本笔记一样，改成认知区列表那一行 ⋮ 菜单里的「删除…」
              （`CognitionPage.tsx`，同一套 `askDelete` → 二次确认 → `notes/_trash/`）。
              ⚠️ 于是 `onRequestDelete` 参数一起删掉。 */}
        </div>
      </header>

      <p className="shrink-0 px-2 text-xs text-slate-400">
        树状图 · {nodeTotal} 个节点 · 创建 {formatStamp(note.createdAt)} · 最近修改{" "}
        {formatStamp(note.updatedAt)}
        {note.sourceInfoIds.length > 0 && ` · 联动信息 ${note.sourceInfoIds.length} 条`}
        {imageDropId && <span className="ml-2 text-emerald-500">松手插到这张卡片上</span>}
      </p>

      {/* 画布。⚠️ 空树（没有根节点）是坏文件，这里给一条自救的路 */}
      <div ref={canvasHostRef} className="min-h-0 flex-1">
        {root ? (
          <TreeCanvas
            root={root}
            selectedId={selectedId}
            editingId={editingId}
            imageDropId={imageDropId}
            history={history}
            actions={actions}
            apiRef={canvasRef}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 text-sm text-slate-400 dark:border-slate-700">
            <p>这篇树状图没有根节点（文件可能受损），所以画布上什么都没有。</p>
            <button
              type="button"
              onClick={() => void ensureTreeRoot(note.id)}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              补上中心主题
            </button>
          </div>
        )}
      </div>

      <ImageViewer relPath={lightbox} onClose={() => setLightbox(null)} />
    </section>
  );
}

/** 整棵树的节点数 */
function countAll(node: NonNullable<Note["root"]>): number {
  return node.children.reduce((sum, child) => sum + countAll(child), 1);
}
