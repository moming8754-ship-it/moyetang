/**
 * 文本笔记（DocNote）的编辑面板（M3-2 / M3-3 / M3-4 / M3-5）。
 *
 * 结构：标题栏（标题 / 保存状态 / 编辑·预览切换 / 保存）
 *      → 编辑辅助栏（10 个按钮）
 *      → CodeMirror 编辑器 或 Markdown 预览
 *      → 右侧那条边栏（目录 / 批注）
 *
 * 🔴 **2026-10-11（P3 档案区返工那轮）把"画的那一半"抽走了**：
 *    标题行 / 编辑·预览 / 辅助栏 / 编辑器 / 预览 / 右侧栏 / 粘图 / 拖图 → `NoteBodyPane.tsx`，
 *    因为档案区要做成"极简版认知区"，两边必须**一模一样**（抄第二份迟早不一致）。
 *    **这个文件现在只剩"存"那一半**：防抖自动保存 + 串行队列 + 保存状态 + 联动信息 + 目录跳行。
 *
 * 自动保存照抄花笺那套踩过坑的做法（DEV-PLAN 里没写，但值得学）：
 * 1. **防抖 900ms**，不是每敲一个字就写盘；
 * 2. **串行队列**（`queueRef`）：自动保存和"切走时保存"不并发写同一篇；
 * 3. **快照 + 序号**：保存用发起那一刻的 title/content；回来时如果用户已经又敲了
 *    或者已经切走了，就不把状态改成"已保存"（免得界面骗人）。
 *
 * 组件按 `note.id` 做 key（父组件那边），所以换笔记 = 整块重建，
 * 不会出现"上一篇的正文残留在编辑器里"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NoteBodyPane from "./NoteBodyPane";
import type { NoteEditorHandle } from "./NoteEditor";
import NoteSidePanel from "./NoteSidePanel";
import { scanMarkers } from "./markers";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { assetWriteImage } from "../api";
import { fileToBase64 } from "../../shared/imageFile";
import { formatStamp } from "../../shared/daytime";
import type { Info, Note } from "../types";

/** 打字停下来多久后落盘 */
const SAVE_DELAY_MS = 900;

interface DocNotePaneProps {
  note: Note;
  /** 刚新建的笔记：标题直接选中，方便改名 */
  autoFocusTitle?: boolean;
}

export default function DocNotePane({ note, autoFocusTitle }: DocNotePaneProps) {
  const infos = useData((state) => state.infos);
  const todos = useData((state) => state.todos);
  const saveNote = useData((state) => state.saveNote);
  const toggleMarker = useData((state) => state.toggleMarker);
  const setFocusRef = useData((state) => state.setFocusRef);
  const setView = useUi((state) => state.setView);
  const toast = useUi((state) => state.toast);

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [status, setStatus] = useState<"saved" | "dirty" | "saving">("saved");
  /** M14：「启用档案区」开着吗（关着时边栏里没有批注页签） */
  const archiveEnabled = useData((state) => state.config.archive.enabled);
  // ⚠️ M15 的 `archiveOne` 原来在这里（顶部那颗「收进档案库」用的）——
  //    2026-10-11（v2.19.0 · 用户反馈第 12 条）那颗挪进了认知区列表的行菜单，这里就不需要了。

  const editorRef = useRef<NoteEditorHandle | null>(null);

  /**
   * ⑩（2026-10-11 用户反馈第 10 条）：**截图直接 Ctrl+V 就进正文**（拖入的图也走这里）。
   *
   * 用户原话：「很久以前验证过成功的粘贴图片进文本编辑器现在失效了」—— 查下来是认知区这个
   * 编辑器**从来就没有粘贴处理**（全项目只有信息区 / 小窗 / 树面板 / 奖状墙有）。
   * 走的跟小窗**同一条路**：`fileToBase64` → `asset_write_image` 落进 `assets/` →
   * 在光标处插 `![](assets/xxx.png)`（图没落盘成功就什么都不插，别留一个空链接）。
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

  // 保存要用的最新值：放 ref，回调里读到的永远是最新的（不受闭包影响）
  const noteRef = useRef(note);
  noteRef.current = note;
  const latestRef = useRef({ title, content });
  latestRef.current = { title, content };
  const dirtyRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const seqRef = useRef(0);

  /** 存一次（有改动才真的写） */
  const save = useCallback(async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false; // 先清：保存期间又敲字会把它重新置脏
    const snapshot = { ...latestRef.current };
    const seq = ++seqRef.current;
    setStatus("saving");

    const run = async () => {
      const saved = await saveNote({ ...noteRef.current, ...snapshot });
      if (seq !== seqRef.current) return; // 期间又存过一轮：让新的那轮收尾
      setStatus(dirtyRef.current ? "dirty" : saved ? "saved" : "dirty");
    };
    const task = queueRef.current.then(run, run);
    queueRef.current = task.catch(() => undefined); // 队列不许断
    await task;
  }, [saveNote]);

  // 防抖自动保存（title/content 一变就重新计时）
  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save();
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [title, content, save]);

  // 离开这篇（切笔记 / 切页面 / 关掉）前把没存完的存掉
  useEffect(() => {
    return () => {
      void save();
    };
  }, [save]);

  const markDirty = () => {
    dirtyRef.current = true;
    setStatus("dirty");
  };

  const handleTitle = (next: string) => {
    markDirty();
    setTitle(next);
  };

  const handleContent = (next: string) => {
    markDirty();
    setContent(next);
  };

  /** `-[]` 标记（前端算 key，与后端 marker.rs 同一套规则） */
  const markers = useMemo(() => scanMarkers(note.id, content), [note.id, content]);

  /** 勾选状态的真源是待办：勾上 = 那条待办已完成 */
  const checkedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const todo of todos) {
      const key = todo.source?.markerKey;
      if (key && todo.status === "done") set.add(key);
    }
    return set;
  }, [todos]);

  /** 这篇笔记已经同步到执行区几条 */
  const syncedCount = useMemo(
    () => todos.filter((todo) => todo.source?.noteId === note.id).length,
    [todos, note.id],
  );

  /** 联动进来的信息（顺序与正文里的引用块一致，预览靠它对回来） */
  const sourceInfos = useMemo(
    () =>
      note.sourceInfoIds
        .map((id) => infos.find((info) => info.id === id))
        .filter((info): info is Info => Boolean(info)),
    [note.sourceInfoIds, infos],
  );

  /** 点引用块的「去信息区」：跳回信息区并高亮那条 */
  const openInfo = (infoId: string) => {
    void save(); // 走之前存住
    setFocusRef({ kind: "info", id: infoId });
    setView("info");
  };

  const charCount = content.replace(/\s/g, "").length;

  /**
   * M14-A：目录点了之后跳到那一行。
   * 编辑模式 → 让 CodeMirror 把光标送过去并滚到可见；预览模式 → 滚到那个标题元素。
   * ⚠️ 两种都只动视口 / 光标，**不动正文一个字**。
   */
  const jumpToLine = (line: number) => {
    if (mode === "edit") {
      editorRef.current?.jumpToLine(line);
      return;
    }
    const node = document.querySelector(`[data-toc-line="${line}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
  };

  return (
    <NoteBodyPane
      noteId={note.id}
      title={title}
      onTitleChange={handleTitle}
      onTitleBlur={() => void save()}
      content={content}
      onContentChange={handleContent}
      mode={mode}
      onModeChange={setMode}
      status={status}
      headerExtra={
        <button
          type="button"
          onClick={() => void save()}
          disabled={status !== "dirty"}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          保存
        </button>
        /* 🔴 2026-10-11（v2.19.0 · 用户反馈第 12 条）：**「收进档案库」和「删除」从这条
            顶栏挪走了** —— 用户原话「删除放在右上角还是太难受了，建议改成放在上一个反馈的
            小图标那里」（＝认知区列表每一行的 ⋮ 菜单）。两个功能一个字没改，只是换了门口：
            `CognitionPage.tsx` 的行菜单里那两颗 `data-note-archive` / `data-note-del`。 */
      }
      metaLine={
        <>
          创建 {formatStamp(note.createdAt)} · 最近修改 {formatStamp(note.updatedAt)} · {charCount} 字
          {markers.length > 0 && (
            <>
              {" · "}
              <span className="text-indigo-500 dark:text-indigo-400">
                {markers.length} 条 -[] 标记（执行区已同步 {syncedCount} 条）
              </span>
            </>
          )}
          {sourceInfos.length > 0 && ` · 联动信息 ${sourceInfos.length} 条`}
        </>
      }
      sidePanel={
        <NoteSidePanel
          note={note}
          content={content}
          archiveEnabled={archiveEnabled}
          cursorOffset={() => editorRef.current?.cursorOffset() ?? 0}
          onJumpToLine={jumpToLine}
        />
      }
      onSaveRequest={() => void save()}
      checkedKeys={checkedKeys}
      onToggleMarker={(key, text, checked) => {
        void toggleMarker(note.id, key, text, checked);
      }}
      sourceInfos={sourceInfos}
      onOpenInfo={openInfo}
      onPasteImage={pasteImageIntoBody}
      autoFocusTitle={autoFocusTitle}
      editorRef={editorRef}
    />
  );
}
