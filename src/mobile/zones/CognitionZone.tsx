/**
 * 手机版 · 认知区（M19.3 / v2.4.0）
 *
 * 照设计稿 `.spike\M18C-info-cognition.html` 的**关键一条**：
 *   电脑版「目录 + 批注栏」是**右侧一整栏**；手机上放不下 →
 *   🔴 **目录进顶栏按钮（从右滑出）、批注进底部常驻细条（从底弹出）、正文占满中间**。
 *
 * 结构：
 *   ① 列表：搜索 + 分组（可折叠）+ 每行（标题 / 最近改动 / 批注条数）+ ⋮（移到分组 / 删除）+ 「＋」新建（文本 / 树状）
 *   ② 打开笔记：顶栏（返回 / 标题 / 目录 ☰）｜ 正文（阅读=MarkdownPreview，编辑=NoteEditor）｜ 底部细条（批注 N ▾ / 编辑·预览切换）
 *
 * ⚠️ 逻辑全部复用电脑版：`scanToc`（目录）、`scanMarkers` + `toggleMarker`（`-[]` 勾选）、
 *    `saveNote` / `setNoteGroup` / `deleteNote` / `createNote`、`MarkdownPreview` / `NoteEditor`、
 *    `annoList` / `annoCreate` / `annoSet` / `annoDelete` + `splitSentences` / `makeAnchor`（批注锚点）。
 * ⚠️ 不做电脑版那套"右侧一整栏"（手机上会把正文挤成一条缝）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { annoCreate, annoDelete, annoList, annoSet, noteExportDownloads } from "../../features/api";
import { makeAnchor, splitSentences } from "../../features/notes/annotations";

import MarkdownPreview from "../../features/notes/MarkdownPreview";
import NoteEditor from "../../features/notes/NoteEditor";
import type { NoteEditorHandle } from "../../features/notes/NoteEditor";
import type { ToolbarAction } from "../../features/notes/format";
import NoteToolbarBall from "./NoteToolbarBall";
import type { BallPos } from "./NoteToolbarBall";
import NoteTreeView from "./NoteTreeView";
import TreePageMobile from "./TreePageMobile";
import { scanToc } from "../../features/notes/toc";
import type { Annotation, Note, NoteKind } from "../../features/types";
import { formatStamp } from "../../shared/daytime";
import { fileToBase64 } from "../../shared/imageFile";
import { assetWriteImage } from "../../features/api";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { registerBackLayer } from "../back";

const SAVE_DELAY_MS = 900;

export default function CognitionZone() {
  const notes = useData((s) => s.notes);
  const todos = useData((s) => s.todos);
  const infos = useData((s) => s.infos);
  /** ⚠️ 2026-10-06（P0-1）：**不要**再用 `saveNote`（整篇覆盖）——手机手上那份 root 是旧的，
   *  写回会把电脑侧的树节点抹掉。这里只改标题/正文。 */
  const setNoteText = useData((s) => s.setNoteText);
  /** 🔴 P0-1：树笔记在手机上是用**文本页**编辑的 → 保存时把正文里还没成为节点的话补进树 */
  const appendTreeText = useData((s) => s.appendTreeText);
  const deleteNote = useData((s) => s.deleteNote);
  const setNoteGroup = useData((s) => s.setNoteGroup);
  const createNote = useData((s) => s.createNote);
  const toggleMarker = useData((s) => s.toggleMarker);
  const toast = useUi((s) => s.toast);
  const config = useData((s) => s.config);
  /** ④（2026-10-11 用户反馈第 4 条）：认知区列表的默认折叠方式（设置页里可改，两端共用这一个值） */
  const groupDefault = config.cognitionGroupDefault;
  /** ②b（2026-10-11 用户反馈第 2 条）：手机端也要能「收进档案库」（跟电脑版同一个 action） */
  const archiveOne = useData((s) => s.archiveOne);
  const archiveEnabled = config.archive.enabled;
  const saveConfig = useData((s) => s.saveConfig);
  /** B6：导入 md 之后把列表重新拉一遍 */
  const refresh = useData((s) => s.refresh);

  // ── 列表态 ────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  /**
   * 分组折叠状态。④ 2026-10-11（v2.20.0 · 用户反馈第 4 条）：`null` = **用户还没动过**
   * → 按设置里的 `cognitionGroupDefault` 现算（`collapse-grouped` = 分好类的收起来、
   * 没分类的展开）；他一点折叠就 materialize，从那刻起以他点的为准。
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean> | null>(null);
  const [menuFor, setMenuFor] = useState<Note | null>(null);
  const [confirmDel, setConfirmDel] = useState<Note | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [groupPickFor, setGroupPickFor] = useState<Note | null>(null);
  const [newGroup, setNewGroup] = useState("");
  /**
   * ⑬ 批量选择（2026-10-11 · 用户反馈第 13 条「删除等行为缺少批量处理的能力」）。
   *
   * 手机版的取舍：**只做"勾选 + 批量删除"**（外加全选）。
   * 批量导出在手机上没有意义 —— `notesExportDir` 要一个目录路径，而安卓端只有
   * `noteExportDownloads`（固定写进「下载/东方摩耶堂/」）这一条路，没有"选文件夹"。
   * 批量移到分组放下一批（要再开一层选组，先把"删一批"这条主诉解决）。
   *
   * ⚠️ 删除仍然是**一篇一篇走同一个 `deleteNote`**（先留档 → 挪 `notes/_trash/`），
   *    不新开"批量硬删"的后端命令。
   */
  const [batchMode, setBatchMode] = useState(false);
  const [batchSel, setBatchSel] = useState<string[]>([]);
  const [confirmBatchDel, setConfirmBatchDel] = useState(false);

  // ── 笔记态 ────────────────────────────────────────────────
  const [openNote, setOpenNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"read" | "edit">("read");
  /** P2-C：光标现在处在什么格式里（给悬浮工具条高亮用） */
  const [cursorFormats, setCursorFormats] = useState<ToolbarAction[]>([]);
  /** P2-D：撤销/重做能不能点（CodeMirror 的历史栈深度） */
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  /** B6（2026-10-07）：文本页右上角那个 ⋮（导出/导入 markdown） */
  const [moreOpen, setMoreOpen] = useState(false);
  const mdInputRef = useRef<HTMLInputElement | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [annoOpen, setAnnoOpen] = useState(false);
  const [annos, setAnnos] = useState<Annotation[]>([]);
  const [annoDraft, setAnnoDraft] = useState("");
  const [annoPickOpen, setAnnoPickOpen] = useState(false);
  const [annoEditId, setAnnoEditId] = useState("");
  const [annoEditText, setAnnoEditText] = useState("");

  // P0-2：返回手势/返回键先关掉浮层，别让它直接退出应用
  const backSheetOpen = !!(menuFor || confirmDel || newOpen || groupPickFor || batchMode || confirmBatchDel);
  useEffect(() => {
    if (!backSheetOpen) return;
    return registerBackLayer(() => {
      setMenuFor(null);
      setConfirmDel(null);
      setNewOpen(false);
      setGroupPickFor(null);
      setConfirmBatchDel(false);
      setBatchMode(false);
      setBatchSel([]);
      return true;
    });
  }, [backSheetOpen]);

  // P0-2（用户报的那条）：返回 = 从笔记回到列表，而不是退出应用
  useEffect(() => {
    if (!openNote) return;
    return registerBackLayer(() => {
      setOpenNote(null);
      return true;
    });
  }, [openNote]);

  /**
   * 反馈·1022 #5：**从笔记返回列表时回到原来的位置**。
   *
   * 手机上列表页和笔记页是 `if (openNote) {...} else {...}` 两个分支 ——
   * 打开笔记时整个列表 DOM 被卸载，`scrollTop` 跟着没了，返回列表就回顶。
   * 所以打开前把位置记在 ref 里，回来那一帧（rAF，等列表排完版）再写回去。
   */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const savedListScroll = useRef(0);
  useEffect(() => {
    if (openNote) return;
    const element = listScrollRef.current;
    const top = savedListScroll.current;
    if (!element || top <= 0) return;
    const raf = requestAnimationFrame(() => {
      element.scrollTop = top;
    });
    return () => cancelAnimationFrame(raf);
  }, [openNote]);

  const editorRef = useRef<NoteEditorHandle | null>(null);

  /**
   * ⑩（2026-10-11 用户反馈第 10 条）：剪贴板里有图 → 落盘 + 在光标处插 markdown。
   * （手机上的剪贴板常常没有图片类型，但外接键盘 / 分享进来时会有；电脑版同一个编辑器。）
   */
  const pasteImageIntoBody = async (file: File): Promise<string | null> => {
    try {
      const rel = await assetWriteImage(await fileToBase64(file));
      toast("图片已插进正文", "success");
      return `![](${rel})`;
    } catch (error) {
      toast(`图片没能插进来：${String(error)}`, "error");
      return null;
    }
  };
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  /** 分组：有名字的在前（按字典序），"未分组"永远最后 */
  const groups = useMemo(() => {
    const named = Array.from(new Set(notes.map((one) => one.group ?? "").filter((one) => one.trim() !== ""))).sort();
    return [...named, ""];
  }, [notes]);

  /** 实际生效的折叠状态（④ 2026-10-11）：用户动过就听他的，没动过按设置算 */
  const collapsedNow = useMemo(() => {
    if (collapsed) return collapsed;
    if (groupDefault !== "collapse-grouped") return {};
    const map: Record<string, boolean> = {};
    for (const one of groups) if (one) map[one] = true;
    return map;
  }, [collapsed, groupDefault, groups]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((one) => {
      if (!q) return true;
      return one.title.toLowerCase().includes(q) || one.content.toLowerCase().includes(q);
    });
  }, [notes, query]);

  const toc = useMemo(() => scanToc(content), [content]);

  const checkedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const todo of todos) {
      const key = todo.source?.markerKey;
      if (key && todo.status === "done") set.add(key);
    }
    return set;
  }, [todos]);
  const sourceInfos = useMemo(
    () =>
      (openNote?.sourceInfoIds ?? [])
        .map((id) => infos.find((info) => info.id === id))
        .filter((one): one is (typeof infos)[number] => Boolean(one)),
    [openNote, infos],
  );

  /** 树笔记的只读轮廓：交给 `NoteTreeView`（P2-B · A 方案）自己渲染，这里不再拍平 */
  const noteAnnos = useMemo(() => annos.filter((one) => one.noteId === openNote?.id), [annos, openNote]);

  /** 保存（防抖 900ms，跟电脑版一个节奏） */
  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!openNote || !dirtyRef.current) return;
    dirtyRef.current = false;
    await setNoteText(openNote.id, title, content);
    // 🔴 P0-1（2026-10-06）：树笔记在手机上是**文本页**，字进的是 content，而电脑侧树视图只认 root
    // → 保存时把"还没成为节点"的整行文字补进树（幂等：已在树里的不会重复加）。
    if (openNote.kind === "tree") {
      await appendTreeText(openNote.id, content);
    }
  }, [openNote, title, content, setNoteText]);

  // 🔴 2026-10-06 修掉的一条**真 bug**（P2-C 验收时逮到）：防抖定时器原来闭包捕获的是
  //    **建定时器那一次渲染的** `flush`，而 `setContent` 引起的重渲染要等定时器之后才发生
  //    → **写盘写的永远是上一版正文**。实测：点 H1 后等 3 秒，盘上还是旧文字；非得再编辑一次才补上
  //    （退出时那次 `flush()` 用当前渲染所以是对的 —— 这就是它一直没被发现的原因）。
  //    桌面版没这毛病（`DocNotePane.tsx` 有 `latestRef`）→ 手机区照同样思路用 ref 指向**最新**的 flush。
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const markDirty = () => {
    dirtyRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
  };

  const openOne = async (note: Note) => {
    // 反馈·1022 #5：进笔记前先记住列表滚到哪了，返回时（见上面的 effect）写回去
    savedListScroll.current = listScrollRef.current?.scrollTop ?? 0;
    setTitle(note.title);
    setContent(note.content);
    // B1（2026-10-07 用户反馈）：默认进「阅读」还是「编辑」，听设置里的开关（默认 read）
    setMode(config.noteOpenMode === "edit" ? "edit" : "read");
    setOpenNote(note);
    dirtyRef.current = false;
    try {
      setAnnos(await annoList());
    } catch {
      setAnnos([]);
    }
  };

  const closeOne = async () => {
    await flushRef.current();
    setOpenNote(null);
    setTocOpen(false);
    setAnnoOpen(false);
  };

  /**
   * P2-D：从系统选图 → 写进 `assets/` → 插到光标处（`![](assets/xxx.jpg)`）。
   *
   * 为什么走 `asset_write_image`（base64）而不是 `asset_import`（路径）：
   * 手机上系统选图给的是 **File 对象（字节）**，不是磁盘路径 —— 跟电脑版"粘图"是同一个处境，
   * 所以复用同一条路（后端按文件头魔数认格式）。
   * ⚠️ 插字这一步交给 `editorRef.insertText`：**等字节写完的这段时间光标可能已经动了**，
   *    由编辑器自己取当前光标插，才不会把图插到别处。
   */
  const importImage = async (file: File) => {
    try {
      const base64 = await fileToBase64(file);
      const rel = await assetWriteImage(base64);
      editorRef.current?.insertText(`![](${rel})`);
      markDirty();
      toast("图片已插到光标处（存在 assets/ 里）");
    } catch (error) {
      toast("插入图片失败：" + String(error), "error");
    }
  };

  /**
   * B6（2026-10-07 用户反馈）：把当前这篇笔记**导出成 Markdown / 纯文本**。
   *
   * 手机上为什么是"复制"而不是"另存为文件"：安卓 WebView 里 `plugin-dialog` 的保存框用不了
   * （C1 那条同一个根因），而"存到哪儿"在安卓 11+ 还要过 SAF 那一套。**复制到剪贴板**
   * 是当前唯一"两端都稳"的做法 —— 粘到微信/邮件/任何编辑器里都能存成文件。
   * ⚠️ 想要"直接存成 .md 文件 / 分享给别的 App"，得加一个安卓分享插件（下一轮可选）。
   */
  const exportNote = async (kind: "md" | "txt") => {
    setMoreOpen(false);
    const head = title.trim() || "未命名笔记";
    const text =
      kind === "md"
        ? `# ${head}\n\n${content}`.trimEnd()
        : `${head}\n\n${content}`.trimEnd();
    try {
      await navigator.clipboard.writeText(text);
      toast(kind === "md" ? "已复制成 Markdown，粘到哪都行" : "已复制成纯文本");
    } catch (error) {
      toast("复制失败：" + String(error), "error");
    }
  };

  /**
   * M27（v2.18.0）：把这一刻的笔记**存成文件**到手机「下载/东方摩耶堂/」。
   *
   * 为什么能存文件了：安卓上系统"另存为"对话框在 `plugin-dialog` 里**根本没实现**，
   * 现在改走后端原生出口（MediaStore 插进下载目录）→ 文件管理里看得见，微信/QQ 也能发。
   * ⚠️ 先把还没落盘的改动刷一次（后端读的是数据目录里的那份，不是编辑器里这份）。
   */
  const exportNoteToPhone = async (note: Note, kind: "md" | "txt") => {
    setMoreOpen(false);
    setMenuFor(null);
    try {
      // ⚠️ 正在编辑那一篇才需要先落盘（后端读的是数据目录里的那份）；
      //    从**列表的 ⋮** 导出时编辑器没开，盘上就是最新的。
      if (openNote?.id === note.id) await flushRef.current();
      const report = await noteExportDownloads(note.id, kind, kind === "md");
      toast(
        `已存到「${report.file}」${report.images > 0 ? `（连 ${report.images} 张图）` : ""}`,
        "success",
      );
    } catch (error) {
      toast("存文件失败：" + String(error), "error");
    }
  };

  /**
   * B6：从一个 `.md` / `.txt` 文件导入成**一篇新笔记**（原样存正文，一个字不改）。
   *
   * 标题取"第一行 `# 标题`"（没有就用文件名去掉扩展名）。
   * ⚠️ **原样导入**是这一版的取舍：正文里如果有行首 `-[]文字`，后端本来就有的
   *    「建笔记顺手同步待办」会把它变成执行区的待办 ✓（不用我们额外做映射）。
   *    更深的事（比如按标题层级生成树）留到以后 —— 先保证"正经 md 笔记进得来、内容不丢"。
   */
  const importMarkdownFile = async (file: File) => {
    setMoreOpen(false);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/);
      let head = "";
      let body = text;
      const first = lines[0]?.trim() ?? "";
      if (first.startsWith("# ")) {
        head = first.slice(2).trim();
        body = lines.slice(1).join("\n").replace(/^\n+/, "");
      } else {
        head = file.name.replace(/\.(md|markdown|txt)$/i, "");
      }
      if (!head.trim()) head = "导入的笔记";
      const created = await createNote(head, "doc", body);
      if (created) {
        await refresh();
        toast(`导入成功：《${head}》`);
      }
    } catch (error) {
      toast("导入失败：" + String(error), "error");
    }
  };

  /** P2-D：球拖完 → 位置记进 ``config.json``（下次打开还在原地） */
  const moveBall = async (next: BallPos) => {
    await saveConfig({ mobileToolbarBall: next });
  };

  /** 目录点击：编辑态让编辑器跳行；阅读态滚到那个标题元素 */
  const jumpToLine = (line: number) => {
    setTocOpen(false);
    if (mode === "edit") {
      editorRef.current?.jumpToLine(line);
      return;
    }
    const node = document.querySelector('[data-toc-line="' + line + '"]');
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
  };

  /** 新建批注：先选句子，再写备注 */
  const sentences = useMemo(() => (annoPickOpen ? splitSentences(content).slice(0, 40) : []), [annoPickOpen, content]);

  const addAnno = async (sentenceText: string) => {
    if (!openNote) return;
    const target = splitSentences(content).find((one) => one.text === sentenceText);
    if (!target) return;
    const anchor = makeAnchor(content, target);
    const text = annoDraft.trim() || "（还没写内容）";
    try {
      await annoCreate(openNote.id, sentenceText, anchor.prefix, anchor.suffix, anchor.hash, text);
      setAnnos(await annoList());
      setAnnoDraft("");
      setAnnoPickOpen(false);
    } catch (error) {
      toast("批注没加上：" + String(error), "error");
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // ── ⑬ 批量选择（2026-10-11 · 用户反馈第 13 条）────────────────────────────

  const toggleBatchMode = () => {
    setBatchMode((was) => !was);
    setBatchSel([]);
    setMenuFor(null);
  };

  const toggleBatchSel = (id: string) => {
    setBatchSel((list) => (list.includes(id) ? list.filter((one) => one !== id) : [...list, id]));
  };

  /** 全选 / 全不选（只针对**当前看得见的**那些行） */
  const toggleAllBatchSel = () => {
    setBatchSel((list) => (list.length === filtered.length ? [] : filtered.map((one) => one.id)));
  };

  /** 批量删除：**一篇一篇走同一个 `deleteNote`**（先留档 → 挪 `notes/_trash/`），不硬删 */
  const deleteBatch = async () => {
    const ids = batchSel;
    setConfirmBatchDel(false);
    if (ids.length === 0) return;
    let done = 0;
    for (const id of ids) {
      const removed = await deleteNote(id);
      if (removed) done += 1;
    }
    setBatchSel([]);
    setBatchMode(false);
    toast(`已把 ${done} 篇移入回收站（notes/_trash/）`, done > 0 ? "success" : "info");
  };

  // ══════════════════════════════════════════════════════════
  // ② 打开了一篇：正文占满中间
  // ══════════════════════════════════════════════════════════
  if (openNote) {
    // ── 树笔记在手机上走**整屏树页**（P2-D / 树 B，2026-10-06 用户要的"照搬小米思维笔记"）──
    //    ⚠️ 只读模式下才这样：点 ⋮ →「编辑正文」会切回下面的文本页（`-[]` 待办那条路，P0-1 红线）。
    if (openNote.kind === "tree" && mode === "read") {
      return (
        <TreePageMobile
          note={openNote}
          onBack={() => void closeOne()}
          onNoteChanged={(next) => {
            // 树操作在**后端**已经落盘了 → 直接换成本后端返回的那篇，**不要**标 dirty
            // （标了会让防抖保存拿旧正文去覆盖 —— 那正好是 P0-1 要防的事）
            dirtyRef.current = false;
            setOpenNote(next);
            setTitle(next.title);
            setContent(next.content);
          }}
          onEditText={() => setMode("edit")}
        />
      );
    }
    return (
      <div data-mobile-zone="cognition" data-mcog-note={openNote.id} className="relative flex h-full flex-col">
        {/* 顶栏：返回 / 标题 / 目录 */}
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <button type="button" data-mcog-back onClick={() => void closeOne()} className="shrink-0 px-1 text-[13px] text-indigo-600 dark:text-indigo-300">
            ‹ 返回
          </button>
          <p data-mcog-title className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {title || "未命名笔记"}
          </p>
          {/* 目录功能跟档案区开关绑定（用户 2026-10-07 反馈：「手机端的目录功能太鸡肋……没打开档案区时所有地方都没有目录」） */}
          {config.archive.enabled && (
            <button
              type="button"
              data-mcog-toc-btn
              onClick={() => setTocOpen(true)}
              className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[11px] dark:border-slate-700"
            >
              目录 ☰
            </button>
          )}
          {/* B6（2026-10-07 用户反馈）：单篇笔记导出/导入 markdown。
              M27（v2.18.0）升级：**真的存成文件** —— 安卓上系统「另存为」对话框在 dialog 插件里
              根本没实现，所以走后端原生出口写进「下载/东方摩耶堂/」（文件管理里看得见、
              微信/QQ 也能从那儿发）；剪贴板那条留着当备选（发给别人时更顺手）。 */}
          <button
            type="button"
            data-mcog-more
            onClick={() => setMoreOpen((was) => !was)}
            className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-[12px] dark:border-slate-700"
          >
            ⋮
          </button>
          {moreOpen && (
            <div className="absolute right-2 top-full z-40 mt-1 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <button
                type="button"
                data-mcog-export="md"
                onClick={() => void exportNoteToPhone(openNote, "md")}
                className="block w-full px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:active:bg-slate-800"
              >
                存到手机（Markdown）
              </button>
              <button
                type="button"
                data-mcog-export="txt"
                onClick={() => void exportNoteToPhone(openNote, "txt")}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-800"
              >
                存到手机（纯文本）
              </button>
              <button
                type="button"
                data-mcog-copy="md"
                onClick={() => void exportNote("md")}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-800"
              >
                复制 Markdown
              </button>
              <button
                type="button"
                data-mcog-copy="txt"
                onClick={() => void exportNote("txt")}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-800"
              >
                复制纯文本
              </button>
              <button
                type="button"
                data-mcog-import
                onClick={() => mdInputRef.current?.click()}
                className="block w-full border-t border-slate-100 px-3 py-2 text-left text-[12.5px] active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-800"
              >
                导入 Markdown 文件…
              </button>
            </div>
          )}
          <input
            ref={mdInputRef}
            data-mcog-import-input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importMarkdownFile(file);
            }}
          />
        </header>

        {/* 正文 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {/* 树笔记：手机端**只读**渲染树（P0-1 起看得见；P2-B · A 方案换成「小米思维笔记」布局） */}
          {openNote.kind === "tree" && <NoteTreeView root={openNote.root} />}

          {mode === "read" ? (
            <MarkdownPreview
              noteId={openNote.id}
              content={content}
              checkedKeys={checkedKeys}
              onToggleMarker={(key, text, checked) => void toggleMarker(openNote.id, key, text, checked)}
              sourceInfos={sourceInfos}
              onOpenInfo={() => undefined}
            />
          ) : (
            <div className="min-h-0">
              <input
                data-mcog-title-input
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  markDirty();
                }}
                placeholder="标题"
                className="mb-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[14px] font-semibold outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
              />
              <NoteEditor
                key={openNote.id}
                ref={editorRef}
                noteId={openNote.id}
                value={content}
                checkedKeys={checkedKeys}
                onChange={(next) => {
                  setContent(next);
                  markDirty();
                }}
                onToggleMarker={(key, text, checked) => void toggleMarker(openNote.id, key, text, checked)}
                onSaveRequest={() => void flushRef.current()}
                onCursorFormats={setCursorFormats}
                onHistory={setHistoryState}
                onPasteImage={pasteImageIntoBody}
                placeholderText="在这里写…"
              />
            </div>
          )}
        </div>

        {/* 底部细条：批注 + 编辑/预览 */}
        <div
          data-mcog-anno-bar
          className="flex shrink-0 items-center justify-between border-t border-slate-200 px-3 py-2 text-[12px] dark:border-slate-800"
        >
          <button type="button" data-mcog-anno-open onClick={() => setAnnoOpen(true)} className="text-indigo-600 dark:text-indigo-300">
            批注 {noteAnnos.length} ▴
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-slate-400">{dirtyRef.current ? "未保存…" : "已保存"}</span>
            <button
              type="button"
              data-mcog-mode={mode}
              onClick={() => setMode(mode === "read" ? "edit" : "read")}
              className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] dark:border-slate-700"
            >
              {mode === "read" ? "编辑" : "预览"}
            </button>
          </div>
        </div>

        {/* P2-D（2026-10-06 用户返工）：编辑态改成「悬浮球 + 竖排条」——
            平时屏幕上只有一颗小球（不挡东西），点一下才长出 13 颗竖排按钮
            （↶ 撤销 / ↷ 重做 / 🖼 导入图片 + 电脑版那 10 个）。
            ⚠️ 它是 absolute 铺满整个笔记页的一层（`inset-0` + `pointer-events-none`），
            所以留在这里、不参与这一列的 flex 布局 —— 键盘弹起时球自己按容器高度夹位置。
            位置存 `config.json` 的 `mobileToolbarBall`（球拖到哪、下次打开还在哪）。 */}
        {mode === "edit" && (
          <NoteToolbarBall
            active={cursorFormats}
            onAction={(action) => editorRef.current?.applyAction(action)}
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
            onUndo={() => editorRef.current?.undo()}
            onRedo={() => editorRef.current?.redo()}
            onPickImage={(file) => void importImage(file)}
            pos={config.mobileToolbarBall}
            onMove={(next) => void moveBall(next)}
          />
        )}

        {/* 目录（从右滑出） */}
        {tocOpen && (
          <div data-mcog-toc className="absolute inset-0 z-30 flex justify-end bg-slate-900/40" onClick={() => setTocOpen(false)}>
            <div
              className="h-full w-[72%] overflow-y-auto border-l border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="pb-2 text-[13px] font-bold">目录</p>
              {/* 🩹 2026-10-06 实测发现：这句原来写的是「用 `## 标题` 写就有」—— **语法写错了**
                  （`##` 是 markdown 标题，跟目录无关；用户就是被这句带偏的）。
                  现在照电脑端 `NoteSidePanel` 那句改，说的是真语法 `toc这一行的标题`（规则见 `features/notes/toc.ts`）。 */}
              {toc.length === 0 && (
                <p className="text-[12px] leading-relaxed text-slate-400">
                  这篇还没有目录。
                  <br />
                  在行首写 <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">toc这一行的标题</code>
                  就会出现在这里（点一下就跳过去）。
                </p>
              )}
              <ul className="flex flex-col">
                {toc.map((entry) => (
                  <li key={entry.line}>
                    <button
                      type="button"
                      data-mcog-toc-item={entry.line}
                      onClick={() => jumpToLine(entry.line)}
                      className="w-full border-b border-slate-100 py-2 text-left text-[12.5px] dark:border-slate-800"
                      
                    >
                      {entry.text}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                data-mcog-toc-close
                onClick={() => setTocOpen(false)}
                className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                收起
              </button>
            </div>
          </div>
        )}

        {/* 批注（从底弹出） */}
        {annoOpen && (
          <div data-mcog-anno-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setAnnoOpen(false)}>
            <div
              className="max-h-[70%] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="pb-2 text-[13px] font-bold">批注（{noteAnnos.length}）</p>

              {noteAnnos.map((one) => (
                <div key={one.id} data-mcog-anno-item={one.id} className="border-b border-slate-100 py-2 dark:border-slate-800">
                  <p className="text-[11px] text-slate-400">「{one.quote}」</p>
                  {annoEditId === one.id ? (
                    <div className="mt-1 flex gap-2">
                      <input
                        data-mcog-anno-edit-input
                        value={annoEditText}
                        onChange={(event) => setAnnoEditText(event.target.value)}
                        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
                      />
                      <button
                        type="button"
                        data-mcog-anno-edit-save
                        onClick={() => {
                          const id = one.id;
                          const text = annoEditText;
                          setAnnoEditId("");
                          void annoSet(id, text).then(() => annoList()).then(setAnnos);
                        }}
                        className="rounded-lg bg-indigo-600 px-3 text-[12px] text-white"
                      >
                        存
                      </button>
                    </div>
                  ) : (
                    <p className="mt-0.5 text-[12.5px]">{one.text}</p>
                  )}
                  {annoEditId !== one.id && (
                    <div className="mt-1 flex gap-3 text-[11px]">
                      <button
                        type="button"
                        data-mcog-anno-edit={one.id}
                        onClick={() => {
                          setAnnoEditId(one.id);
                          setAnnoEditText(one.text);
                        }}
                        className="text-indigo-600 dark:text-indigo-300"
                      >
                        改
                      </button>
                      <button
                        type="button"
                        data-mcog-anno-del={one.id}
                        onClick={() => {
                          const id = one.id;
                          void annoDelete(id).then(() => annoList()).then(setAnnos);
                        }}
                        className="text-rose-600 dark:text-rose-400"
                      >
                        删
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {noteAnnos.length === 0 && <p className="py-2 text-[12px] text-slate-400">还没有批注。</p>}

              {/* 新建批注 */}
              <input
                data-mcog-anno-new-input
                value={annoDraft}
                onChange={(event) => setAnnoDraft(event.target.value)}
                placeholder="写一句批注…"
                className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mcog-anno-pick
                onClick={() => setAnnoPickOpen((v) => !v)}
                className="mt-2 w-full rounded-xl bg-indigo-600 py-2 text-[12.5px] font-medium text-white"
              >
                选一句加批注
              </button>
              {annoPickOpen && (
                <ul data-mcog-anno-pick-list className="mt-2 flex flex-col">
                  {sentences.map((sentence, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        data-mcog-anno-sentence={index}
                        onClick={() => void addAnno(sentence.text)}
                        className="w-full border-b border-slate-100 py-1.5 text-left text-[12px] text-slate-600 dark:border-slate-800 dark:text-slate-300"
                      >
                        {sentence.text.slice(0, 60)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                data-mcog-anno-close
                onClick={() => setAnnoOpen(false)}
                className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                收起
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════
  // ① 列表：搜索 + 分组 + 新建
  // ══════════════════════════════════════════════════════════
  return (
    <div data-mobile-zone="cognition" className="relative flex h-full flex-col">
      <div className="shrink-0 px-3 pt-3">
        <input
          data-mcog-search
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题或正文…"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
        />
        {/* ⑬ 批量选择（2026-10-11 · 用户反馈第 13 条）—— 列表态也有个常驻入口，
            省得非要从某一行的 ⋮ 里进；进了批量就变成"退出 + 已选 N" */}
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            data-mcog-list-import
            onClick={() => mdInputRef.current?.click()}
            className="rounded-lg border border-indigo-200 px-2 py-1 text-[11.5px] text-indigo-600 dark:border-indigo-500/50 dark:text-indigo-300"
          >
            ⬆ 导入 Markdown
          </button>
          <button
            type="button"
            data-mcog-batch
            data-mcog-batch-on={batchMode ? "1" : "0"}
            onClick={toggleBatchMode}
            className={`rounded-lg border px-2 py-1 text-[11.5px] ${
              batchMode
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:border-indigo-500/60 dark:bg-indigo-500/15 dark:text-indigo-300"
                : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400"
            }`}
          >
            {batchMode ? "✕ 退出批量" : "☑ 批量选择"}
          </button>
          {batchMode && (
            <>
              <span className="text-[11.5px] text-slate-500 dark:text-slate-400">
                已选 <span data-mcog-batch-count>{batchSel.length}</span> 篇
              </span>
              <button
                type="button"
                data-mcog-batch-all
                onClick={toggleAllBatchSel}
                className="rounded-lg border border-slate-200 px-2 py-1 text-[11.5px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
              >
                {batchSel.length === filtered.length && filtered.length > 0 ? "全不选" : "全选"}
              </button>
              <button
                type="button"
                data-mcog-batch-del
                disabled={batchSel.length === 0}
                onClick={() => setConfirmBatchDel(true)}
                className="ml-auto rounded-lg bg-rose-600 px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-40"
              >
                删除
              </button>
            </>
          )}
        </div>
        <input
          ref={mdInputRef}
          data-mcog-list-import-input
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importMarkdownFile(file);
          }}
        />
      </div>

      <div ref={listScrollRef} data-mcog-list className="min-h-0 flex-1 overflow-y-auto px-3 pb-20 pt-2">
        {notes.length === 0 && (
          <p data-mcog-empty className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-[13px] text-slate-400 dark:border-slate-700">
            还没有笔记。点右下角的 ＋ 建一篇。
          </p>
        )}
        {notes.length > 0 && filtered.length === 0 && (
          <p data-mcog-nomatch className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-[13px] text-slate-400 dark:border-slate-700">
            没有匹配的笔记。
          </p>
        )}

        {groups.map((group) => {
          const rows = filtered.filter((one) => (one.group ?? "") === group);
          if (rows.length === 0) return null;
          const isCollapsed = collapsedNow[group] === true;
          return (
            <div key={group || "__none"} data-mcog-group={group}>
              <button
                type="button"
                data-mcog-group-toggle={group}
                onClick={() => setCollapsed({ ...collapsedNow, [group]: !isCollapsed })}
                className="flex w-full items-center justify-between px-1 py-2 text-[11px] text-slate-400"
              >
                <span>{group || "未分组"} {isCollapsed ? "▸" : "▾"}</span>
                <span>{rows.length} 篇</span>
              </button>
              {!isCollapsed && (
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                  {rows.map((note) => {
                    const picked = batchSel.includes(note.id);
                    return (
                    <li key={note.id} data-mcog-row={note.id} className="flex items-center gap-2 p-3">
                      {/* ⑬ 批量模式：每行一颗勾（点整行也是勾选） */}
                      {batchMode && (
                        <span
                          data-mcog-check={note.id}
                          data-mcog-check-on={picked ? "1" : "0"}
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] leading-none ${
                            picked
                              ? "border-indigo-500 bg-indigo-500 text-white"
                              : "border-slate-300 text-transparent dark:border-slate-600"
                          }`}
                        >
                          ✓
                        </span>
                      )}
                      <button
                        type="button"
                        data-mcog-open={note.id}
                        onClick={() => (batchMode ? toggleBatchSel(note.id) : void openOne(note))}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-[13px] font-medium">{note.title || "未命名笔记"}</span>
                        <span className="mt-0.5 block text-[10.5px] text-slate-400">
                          {formatStamp(note.updatedAt)} 改过
                          {annos.filter((one) => one.noteId === note.id).length > 0
                            ? ` · ${annos.filter((one) => one.noteId === note.id).length} 条批注`
                            : ""}
                        </span>
                      </button>
                      {!batchMode && (
                        <button
                          type="button"
                          data-mcog-menu={note.id}
                          aria-label="这篇的操作"
                          onClick={() => setMenuFor(note)}
                          className="shrink-0 px-1.5 text-slate-400"
                        >
                          ⋮
                        </button>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* 「＋」新建笔记 */}
      <button
        type="button"
        data-mcog-fab
        aria-label="新建笔记"
        onClick={() => setNewOpen(true)}
        className="absolute bottom-4 right-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg active:bg-indigo-700"
      >
        <svg viewBox="0 0 24 24" style={{ width: 22, height: 22 }} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {/* 新建笔记面板 */}
      {newOpen && (
        <div data-mcog-new-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setNewOpen(false)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-sm font-bold">新建笔记</p>
            {(
              [
                { key: "doc", label: "文本笔记", desc: "写长一点的东西" },
                { key: "tree", label: "树状图", desc: "发散整理用" },
              ] as { key: NoteKind; label: string; desc: string }[]
            ).map((one) => (
              <button
                key={one.key}
                type="button"
                data-mcog-new={one.key}
                onClick={() => {
                  setNewOpen(false);
                  void createNote("未命名笔记", one.key).then((note) => {
                    if (note) void openOne(note);
                  });
                }}
                className="mb-2 flex w-full flex-col rounded-xl border border-slate-200 px-3 py-2 text-left dark:border-slate-700"
              >
                <span className="text-[13px] font-semibold">{one.label}</span>
                <span className="text-[10.5px] text-slate-400">{one.desc}</span>
              </button>
            ))}
            <button type="button" data-mcog-new-close onClick={() => setNewOpen(false)} className="mt-1 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* 单篇菜单 */}
      {menuFor && (
        <div data-mcog-menu-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setMenuFor(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">{menuFor.title || "未命名笔记"}</p>
            <button
              type="button"
              data-mcog-menu-action="group"
              onClick={() => {
                setGroupPickFor(menuFor);
                setMenuFor(null);
              }}
              className="w-full py-2.5 text-left text-[13px]"
            >
              移到分组…
            </button>
            {/* ⑧（2026-10-11 用户反馈第 8 条）：他"不知道怎么导出/导入" —— 因为原来**只有
                先打开一篇笔记**、再点右上角 ⋮ 才看得到那几项。现在**列表这一行的 ⋮ 里也有**，
                不用先点进去。（文本页那个 ⋮ 里的一套照旧留着。） */}
            {/* ②b（2026-10-11 用户反馈第 2 条）：手机端**原来一处「收进档案库」都没有**
                （电脑版在编辑区顶栏有、v2.19.0 起挪进了列表行菜单）。这里补上，
                只在设置里开了「档案区」时出现 —— 跟电脑版同一条规矩。 */}
            {archiveEnabled && (
              <button
                type="button"
                data-mcog-menu-action="archive"
                onClick={() => {
                  const one = menuFor;
                  setMenuFor(null);
                  void archiveOne("note", one.id, one.title);
                }}
                className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] dark:border-slate-800"
              >
                收进档案库
              </button>
            )}
            <button
              type="button"
              data-mcog-menu-action="export-md"
              onClick={() => void exportNoteToPhone(menuFor, "md")}
              className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] dark:border-slate-800"
            >
              存到手机（Markdown）
            </button>
            <button
              type="button"
              data-mcog-menu-action="export-txt"
              onClick={() => void exportNoteToPhone(menuFor, "txt")}
              className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] dark:border-slate-800"
            >
              存到手机（纯文本）
            </button>
            {/* ⑬ 批量：从这一行直接进批量模式，顺手把这一篇勾上 */}
            <button
              type="button"
              data-mcog-menu-action="batch"
              onClick={() => {
                const one = menuFor;
                setBatchMode(true);
                setBatchSel([one.id]);
                setMenuFor(null);
              }}
              className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] dark:border-slate-800"
            >
              批量选择…
            </button>
            <button
              type="button"
              data-mcog-menu-action="delete"
              onClick={() => {
                setConfirmDel(menuFor);
                setMenuFor(null);
              }}
              className="w-full border-t border-slate-100 py-2.5 text-left text-[13px] text-rose-600 dark:border-slate-800 dark:text-rose-400"
            >
              删除…
            </button>
            <button type="button" data-mcog-menu-close onClick={() => setMenuFor(null)} className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* 移到分组 */}
      {groupPickFor && (
        <div data-mcog-group-sheet className="absolute inset-0 z-40 flex flex-col justify-end bg-slate-900/40" onClick={() => setGroupPickFor(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">移到分组</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                data-mcog-group-pick="__none"
                onClick={() => {
                  const one = groupPickFor;
                  setGroupPickFor(null);
                  void setNoteGroup(one.id, "");
                }}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] dark:bg-slate-800"
              >
                未分组
              </button>
              {groups.filter((one) => one).map((one) => (
                <button
                  key={one}
                  type="button"
                  data-mcog-group-pick={one}
                  onClick={() => {
                    const target = groupPickFor;
                    setGroupPickFor(null);
                    // 移进去之后把那组展开 —— 不然用户看到的是"笔记不见了"（跟电脑版同一条规矩）
                    setCollapsed({ ...collapsedNow, [one]: false });
                    void setNoteGroup(target.id, one);
                  }}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] dark:bg-slate-800"
                >
                  {one}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                data-mcog-group-new-input
                value={newGroup}
                onChange={(event) => setNewGroup(event.target.value)}
                placeholder="新分组名…"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
              />
              <button
                type="button"
                data-mcog-group-new-save
                onClick={() => {
                  const target = groupPickFor;
                  const name = newGroup.trim();
                  setGroupPickFor(null);
                  setNewGroup("");
                  if (target && name) {
                    setCollapsed({ ...collapsedNow, [name]: false });
                    void setNoteGroup(target.id, name);
                  }
                }}
                className="rounded-lg bg-indigo-600 px-3 text-[12px] text-white"
              >
                建
              </button>
            </div>
            <button type="button" data-mcog-group-close onClick={() => setGroupPickFor(null)} className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* ⑬ 批量删除的二次确认（2026-10-11 用户反馈第 13 条） */}
      {confirmBatchDel && (
        <div
          data-mcog-batch-confirm
          className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6"
          onClick={() => setConfirmBatchDel(false)}
        >
          <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] leading-relaxed">
              删掉选中的 {batchSel.length} 篇？都会先进回收站，不是硬删。
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-mcog-batch-confirm-del
                onClick={() => void deleteBatch()}
                className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white"
              >
                删除 {batchSel.length} 篇
              </button>
              <button
                type="button"
                data-mcog-batch-confirm-cancel
                onClick={() => setConfirmBatchDel(false)}
                className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认 */}
      {confirmDel && (
        <div data-mcog-confirm className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6" onClick={() => setConfirmDel(null)}>
          <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] leading-relaxed">删掉《{confirmDel.title || "未命名笔记"}》？笔记会先进回收站，不是硬删。</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-mcog-confirm-del
                onClick={() => {
                  const one = confirmDel;
                  setConfirmDel(null);
                  void deleteNote(one.id);
                }}
                className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white"
              >
                删除
              </button>
              <button type="button" data-mcog-confirm-cancel onClick={() => setConfirmDel(null)} className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
