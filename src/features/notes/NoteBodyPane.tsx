/**
 * 「一篇文档笔记的正文面板」—— 认知区与档案区**共用**的那一块（2026-10-11 · P3 档案区返工那轮抽的）。
 *
 * # 为什么要抽
 * 用户要把档案区做成「**极简版认知区的文本编辑器**」—— 标题行 / 编辑·预览切换 / 那 10 颗辅助栏 /
 * CodeMirror / Markdown 预览 / 右侧目录页签 / Ctrl+V 粘图 —— 跟认知区**一模一样**。
 * 抄第二份迟早两边不一致（用户点名过这条），所以抽成一件、两边都用它。
 *
 * # 它只管"画和交互"，不管"存"
 * - 认知区（`DocNotePane`）：外面自己挂 900ms 防抖自动保存，并把状态传进来当 `status`；
 * - 档案区（`ArchivePage`）：用户明确要「**存下**按钮、**不要**自动保存」→ 外面不传 `status`，
 *   把「存下」放在 `footer` 里（照稿子第 ① 节脚上那三颗）。
 *
 * # 抓手（老套件 m8 / m14 / v2a 正盯着，别改名）
 * `data-side-toggle`（右上那颗开关）· 编辑/预览那两颗按钮的**文案一字不改** ·
 * `EditorToolbar` 里那 10 颗（它自己就是单一来源）· 目录条目走 `TocList`（`data-toc-item`/`data-toc-line`）。
 * 档案区要多两件抓手（标题输入框、正文区外壳）时用 `titleAttrName` / `bodyAttrName` 传属性名，
 * **不另抄一套 JSX**。
 *
 * # 三条手感（从 `DocNotePane` 原样搬过来，都踩过）
 * ① 点正文以外的空白要把光标送进编辑器（不然点了没反应，像坏了）；
 * ② 切到「预览」之前先存一次；
 * ③ 粘图 / 拖入的图落盘失败就**什么都不插**（别留一个空链接）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import EditorToolbar from "./EditorToolbar";
import NoteEditor from "./NoteEditor";
import type { NoteEditorHandle } from "./NoteEditor";
import MarkdownPreview from "./MarkdownPreview";
import { imageFromDataTransfer } from "../../shared/imageFile";
import type { Info } from "../types";

interface NoteBodyPaneProps {
  /** 这篇的 id（CodeMirror 按它建 key、预览按它对 marker） */
  noteId: string;
  title: string;
  onTitleChange: (next: string) => void;
  /** 标题框失焦（认知区拿它触发一次存；档案区不传） */
  onTitleBlur?: () => void;
  content: string;
  onContentChange: (next: string) => void;
  /** 「编辑 / 预览」—— 受控 */
  mode: "edit" | "preview";
  onModeChange: (next: "edit" | "preview") => void;
  /** 标题右边那行小字；不传就不显示（档案区＝不传） */
  status?: "saved" | "dirty" | "saving";
  /** 标题行最右边多出来的按钮（认知区那颗「保存」） */
  headerExtra?: ReactNode;
  /** 标题下面那行元信息（认知区：创建 / 最近修改 / 字数 / 标记数） */
  metaLine?: ReactNode;
  /** 正文下面那一条（档案区把「彻底删掉 / 取出 / 存下」放这儿） */
  footer?: ReactNode;
  /** 右侧那一栏（目录 / 目录+批注）。不传＝没有那一栏，右上开关也不出现 */
  sidePanel?: ReactNode;
  /** 右侧栏默认开着吗（认知区默认开，不然用户找不到目录） */
  sideOpenDefault?: boolean;
  /** 右上那颗开关的文案（认知区＝「目录/批注」，档案区＝「目录」） */
  sideToggleLabel?: string;
  /** Ctrl+S：立刻存一次（档案区＝点一下「存下」那个动作） */
  onSaveRequest?: () => void;
  checkedKeys: Set<string>;
  onToggleMarker: (key: string, text: string, checked: boolean) => void;
  /** 预览里的联动信息（档案区没有 → 不传，预览就不画引用块） */
  sourceInfos?: Info[];
  onOpenInfo?: (infoId: string) => void;
  /** Ctrl+V / 拖入的图：落盘后返回要插进正文的那段 markdown（返回 null＝不插） */
  onPasteImage?: (file: File) => Promise<string | null>;
  placeholderText?: string;
  titlePlaceholder?: string;
  autoFocusTitle?: boolean;
  /** 调用方要拿编辑器句柄（跳行 / 取光标）时传它；不传就用内部的 */
  editorRef?: RefObject<NoteEditorHandle | null>;
  /** 标题输入框上挂的 data 属性名（档案区抓手 `data-archive-edit-title`） */
  titleAttrName?: string;
  /** 正文区外壳上挂的 data 属性名（档案区抓手 `data-archive-edit-body`） */
  bodyAttrName?: string;
}

/** 标题上那颗圆角按钮的通用样子（开关 / 保存都用它，跟认知区原来的写法一致） */
const HEAD_BTN =
  "rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";

/** 正文那张卡的外壳（编辑态还要 `flex flex-col`，让工具栏在上、编辑区吃掉剩下的高度） */
const CARD =
  "min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

/** 预览那张卡要自己滚（它没有工具栏，整块都归预览） */
const PREVIEW_CARD =
  "min-h-0 flex-1 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export default function NoteBodyPane({
  noteId,
  title,
  onTitleChange,
  onTitleBlur,
  content,
  onContentChange,
  mode,
  onModeChange,
  status,
  headerExtra,
  metaLine,
  footer,
  sidePanel,
  sideOpenDefault = true,
  sideToggleLabel = "目录/批注",
  onSaveRequest,
  checkedKeys,
  onToggleMarker,
  sourceInfos,
  onOpenInfo,
  onPasteImage,
  placeholderText = "在这里写…（点上面那排按钮可以插粗体、标题、列表、待办；截图直接 Ctrl+V 就粘进正文）",
  titlePlaceholder = "笔记标题",
  autoFocusTitle,
  editorRef,
  titleAttrName,
  bodyAttrName,
}: NoteBodyPaneProps) {
  const innerRef = useRef<NoteEditorHandle | null>(null);
  const ed = editorRef ?? innerRef;
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [sideOpen, setSideOpen] = useState(sideOpenDefault);
  /** 拖着图悬在正文上（画一圈提示，松手就插） */
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    if (!autoFocusTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [autoFocusTitle]);

  /** 传进来的属性名 → 一个能直接摊到 JSX 上的对象（不传就是空对象，零开销） */
  const attr = (name?: string): Record<string, string> => (name ? { [name]: noteId } : {});

  /** 拖进来的图：跟 Ctrl+V 走**同一条路**（`onPasteImage` 落盘 → 光标处插一行） */
  const onDrop = async (event: React.DragEvent) => {
    setDropping(false);
    const file = imageFromDataTransfer(event);
    if (!file || !onPasteImage) return;
    event.preventDefault();
    const markdown = await onPasteImage(file);
    if (markdown) ed.current?.insertText(markdown);
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      {/* 标题栏 */}
      <header className="flex shrink-0 items-start gap-3">
        <input
          ref={titleInputRef}
          {...attr(titleAttrName)}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          onBlur={() => onTitleBlur?.()}
          placeholder={titlePlaceholder}
          className="min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1 text-lg font-semibold outline-none hover:border-slate-200 focus:border-indigo-300 focus:bg-white dark:hover:border-slate-700 dark:focus:border-indigo-500 dark:focus:bg-slate-900"
        />

        <div className="flex shrink-0 items-center gap-1.5">
          {status && (
            <span
              className={`mr-1 text-xs ${
                status === "dirty" ? "text-amber-600 dark:text-amber-400" : "text-slate-400"
              }`}
            >
              {status === "saving" ? "保存中…" : status === "dirty" ? "未保存…" : "已保存"}
            </span>
          )}

          <div className="flex rounded-xl border border-slate-200 p-0.5 dark:border-slate-700">
            {(["edit", "preview"] as const).map((one) => (
              <button
                key={one}
                type="button"
                data-note-mode={one}
                onClick={() => {
                  onModeChange(one);
                  if (one === "preview") onSaveRequest?.();
                }}
                className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                  mode === one
                    ? "bg-indigo-600 text-white"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {one === "edit" ? "编辑" : "预览"}
              </button>
            ))}
          </div>

          {sidePanel && (
            <button
              type="button"
              data-side-toggle
              onClick={() => setSideOpen((open) => !open)}
              title={sideOpen ? `收起右边的${sideToggleLabel}` : `展开右边的${sideToggleLabel}`}
              className={
                sideOpen
                  ? "rounded-xl border border-indigo-300 px-2.5 py-1.5 text-xs text-indigo-600 dark:border-indigo-500/60 dark:text-indigo-300"
                  : `${HEAD_BTN} px-2.5`
              }
            >
              {sideToggleLabel}
            </button>
          )}

          {headerExtra}
        </div>
      </header>

      {metaLine !== undefined && (
        <p className="shrink-0 px-2 text-xs text-slate-400">{metaLine}</p>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {mode === "edit" ? (
          <div className={`${CARD} flex flex-col`}>
            <EditorToolbar
              onAction={(action) => ed.current?.applyAction(action)}
              disabled={false}
            />
            <div
              {...attr(bodyAttrName)}
              data-note-drop={dropping ? "1" : "0"}
              className={`min-h-0 flex-1 cursor-text ${
                dropping ? "ring-2 ring-inset ring-indigo-400" : ""
              }`}
              onMouseDown={(event) => {
                // 点正文以外的空白也把光标送进编辑器（不然点了没反应，像坏了）
                if (event.target === event.currentTarget) ed.current?.focus();
              }}
              onDragOver={(event) => {
                if (imageFromDataTransfer(event)) {
                  event.preventDefault();
                  setDropping(true);
                }
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={(event) => void onDrop(event)}
            >
              <NoteEditor
                key={noteId}
                ref={ed}
                noteId={noteId}
                value={content}
                checkedKeys={checkedKeys}
                onChange={onContentChange}
                onToggleMarker={onToggleMarker}
                onSaveRequest={onSaveRequest}
                onPasteImage={onPasteImage}
                placeholderText={placeholderText}
              />
            </div>
          </div>
        ) : (
          <div className={PREVIEW_CARD}>
            <MarkdownPreview
              noteId={noteId}
              content={content}
              checkedKeys={checkedKeys}
              onToggleMarker={onToggleMarker}
              sourceInfos={sourceInfos ?? []}
              onOpenInfo={onOpenInfo ?? (() => undefined)}
            />
          </div>
        )}

        {sidePanel && sideOpen && sidePanel}
      </div>

      {footer}
    </section>
  );
}
