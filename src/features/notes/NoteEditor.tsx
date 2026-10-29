/**
 * 认知笔记的 Markdown 编辑器（M3-2 编辑器 / M3-3 辅助栏落点 / M3-4 勾选框）。
 *
 * 为什么用 CodeMirror 6 而不是 `<textarea>`：原版花笺用 textarea + execCommand
 * 手工保撤销栈，CM6 自带撤销历史、选区 API 和装饰器（decoration），
 * 要在编辑器里画勾选框、给联动信息那几行加左边线，CM6 是现成的。
 *
 * 三件事都在这一个文件里：
 * 1. 一个 EditorView，只建一次（`noteId` 变了才整篇换文），回调全走 ref，
 *    免得父组件每次 render 都把编辑器重建一边；
 * 2. 读 / 写正文交给父组件的受控值（父组件负责防抖落盘）；
 * 3. 装饰器：`-[]文字` 行前面画一个**能点的勾选框**、行底色变淡；
 *    联动信息那几行（`> *〔联动信息〕…*`）加左边线 + 斜体，看着就是"只读引用"。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExtension,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
  redoDepth,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as highlightTags } from "@lezer/highlight";
import { markerKeyOf, markerTextOf } from "./markers";
import { imageFromClipboard } from "../../shared/imageFile";
import { buildFormatEdit, type ToolbarAction } from "./format";
import { toolbarFormatsAt } from "./toolbarFormat";

/** 联动信息在正文里的固定写法（与 Rust `store::note::link_info` 一致，改一边要改两边） */
const INFO_QUOTE = /^>\s*\*〔联动信息〕/;

export interface NoteEditorHandle {
  /** 辅助栏按钮：在光标处插入或包裹 */
  applyAction: (action: ToolbarAction) => void;
  focus: () => void;
  /** 光标现在在第几行（0 起）—— 批注要锚到"光标所在那句" */
  cursorLine: () => number;
  /** 光标在正文里的字符偏移 —— 比行号更准，用来找"光标那一句" */
  cursorOffset: () => number;
  /** 滚到第 N 行并高亮一下（M14-A 目录点击用） */
  jumpToLine: (line: number) => void;
  /** P2-D：撤销一步（**手机没有 Ctrl+Z**，竖排条最上面那颗靠它） */
  undo: () => void;
  /** P2-D：重做一步 */
  redo: () => void;
  /**
   * P2-D：在光标处插一段文字（**异步流程用**）。
   *
   * 为什么不让调用方自己拼好正文再 `setContent`：插图片要先等字节写完
   * （`asset_write_image` 是异步的），等回来时光标可能已经动了 ——
   * 由编辑器自己取当前光标插，才不会把图插到别处。
   */
  insertText: (text: string) => void;
}

interface NoteEditorProps {
  noteId: string;
  value: string;
  /** 已勾选的 markerKey（勾选状态的真源是待办，这里只是显示用） */
  checkedKeys: Set<string>;
  onChange: (value: string) => void;
  onToggleMarker: (key: string, text: string, checked: boolean) => void;
  /** Ctrl+S：立刻存一次 */
  onSaveRequest?: () => void;
  placeholderText?: string;
  /**
   * P2-C（2026-10-06）：光标所在处的格式变了 —— 手机工具条靠它高亮"这行已经是 H2"这类状态。
   * ⚠️ **电脑版不传这个 prop**，所以那边一个字节都不多算。
   */
  onCursorFormats?: (formats: ToolbarAction[]) => void;
  /**
   * P2-D（2026-10-06）：撤销/重做的**可用性**变了 —— 竖排条上那两颗要灰得对。
   * ⚠️ 同样只有手机传；电脑版不传 = 零开销。
   */
  onHistory?: (state: { canUndo: boolean; canRedo: boolean }) => void;
  /**
   * ⑩（2026-10-11 用户反馈第 10 条）：**剪贴板里是图片**时怎么办。
   *
   * 用户原话：「很久以前验证过成功的粘贴图片进文本编辑器现在失效了」——
   * 查下来是：全项目做粘贴图片的只有 4 处（信息区 / 小窗 / 树面板 / 奖状墙），
   * **认知区这个文本编辑器一处都没有** → 粘进来的只是剪贴板里的**文字**（比如别处的
   * `![](images/xxx.png)` 路径），图根本没进 `assets/`。
   *
   * 约定：调用方拿到 File 之后自己落盘（`assetWriteImage(fileToBase64(file))`），
   * **返回要插入的 markdown**（如 `![](assets/xxx.png)`）；返回空 = 不插。
   * ⚠️ 剪贴板里**没有图**时这个方法不会被调用，默认粘贴照旧（绝不吃掉用户粘的文字）。
   */
  onPasteImage?: (file: File) => Promise<string | null>;
}

// ───────────────────────── 勾选状态（StateField，改动时重画装饰器） ─────────────────────────

const setCheckedKeys = StateEffect.define<Set<string>>();

const checkedKeysField = StateField.define<Set<string>>({
  create: () => new Set<string>(),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCheckedKeys)) return effect.value;
    }
    return value;
  },
});

// ───────────────────────── 勾选框 widget ─────────────────────────

type ToggleMarker = (key: string, text: string, checked: boolean) => void;

class MarkerCheckbox extends WidgetType {
  constructor(
    private readonly markerKey: string,
    private readonly markerText: string,
    private readonly checked: boolean,
    private readonly onToggle: ToggleMarker,
  ) {
    super();
  }

  eq(other: MarkerCheckbox): boolean {
    return (
      other.markerKey === this.markerKey &&
      other.markerText === this.markerText &&
      other.checked === this.checked
    );
  }

  toDOM(): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-marker-box";
    box.title = this.checked ? "点一下取消（同步到执行区）" : "点一下勾上（同步到执行区）";
    box.addEventListener("change", () => {
      this.onToggle(this.markerKey, this.markerText, box.checked);
    });
    return box;
  }

  /** 事件不交给 CodeMirror：否则点勾选框会被当成点正文（光标乱跳、勾不上） */
  ignoreEvent(): boolean {
    return true;
  }
}

// ───────────────────────── 装饰器：勾选框 + 联动信息左边线 ─────────────────────────

function markerDecorations(
  getNoteId: () => string,
  getToggle: () => ToggleMarker,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getNoteId(), getToggle());
      }

      update(update: ViewUpdate) {
        const checkedChanged =
          update.state.field(checkedKeysField) !== update.startState.field(checkedKeysField);
        if (update.docChanged || update.viewportChanged || checkedChanged) {
          this.decorations = buildDecorations(update.view, getNoteId(), getToggle());
        }
      }
    },
    { decorations: (instance) => instance.decorations },
  );
}

function buildDecorations(
  view: EditorView,
  noteId: string,
  onToggle: ToggleMarker,
): DecorationSet {
  const checked = view.state.field(checkedKeysField);
  const marks: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);

      // `-[]文字` → 行前画勾选框 + 行底色变淡
      const text = markerTextOf(line.text);
      if (text) {
        const key = markerKeyOf(noteId, text);
        const indent = line.text.length - line.text.trimStart().length;
        marks.push(
          Decoration.widget({
            widget: new MarkerCheckbox(key, text, checked.has(key), onToggle),
            side: -1,
          }).range(line.from + indent),
        );
        marks.push(Decoration.line({ class: "cm-marker-line" }).range(line.from));
      } else if (INFO_QUOTE.test(line.text)) {
        // 联动信息：左边线 + 斜体，看着就是"从信息区引过来的只读内容"
        marks.push(Decoration.line({ class: "cm-info-line" }).range(line.from));
      }

      if (line.to >= view.state.doc.length) break;
      pos = line.to + 1;
    }
  }

  return Decoration.set(marks, true);
}

// ───────────────────────── 主题（跟随应用深浅色） ─────────────────────────

const themeCompartment = new Compartment();

const highlightStyle = HighlightStyle.define([
  { tag: highlightTags.heading1, fontSize: "1.4em", fontWeight: "600" },
  { tag: highlightTags.heading2, fontSize: "1.2em", fontWeight: "600" },
  { tag: highlightTags.heading3, fontWeight: "600" },
  { tag: highlightTags.strong, fontWeight: "700" },
  { tag: highlightTags.emphasis, fontStyle: "italic" },
  { tag: highlightTags.link, color: "#4f46e5", textDecoration: "underline" },
  { tag: highlightTags.url, color: "#0ea5e9" },
  { tag: highlightTags.monospace, fontFamily: "var(--font-mono, monospace)", color: "#0f766e" },
  { tag: highlightTags.list, color: "#4f46e5", fontWeight: "600" },
  { tag: highlightTags.quote, color: "#64748b", fontStyle: "italic" },
]);

function buildTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        // M10.2-1：**别写死 px**。原来这里固定 "14px"，于是设置里换字号，编辑器正文纹丝不动。
        // 现在跟 `--font-size-base` 走（`shared/fonts.ts` 挂在 <html> 上；兜底 16px 防变量还没建好）。
        fontSize: "var(--font-size-base, 16px)",
        backgroundColor: dark ? "rgb(15 23 42)" : "#ffffff",
        color: dark ? "rgb(226 232 240)" : "rgb(30 41 59)",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-sans, system-ui)",
        lineHeight: "1.95",
        padding: "10px 0 48px",
        overflow: "auto",
      },
      ".cm-content": { padding: "0", caretColor: dark ? "#a5b4fc" : "#4f46e5" },
      ".cm-line": { padding: "1px 16px" },
      ".cm-cursor": { borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "rgba(99,102,241,0.32)" : "rgba(99,102,241,0.20)",
      },
      // 有 `-[]` 的那一行
      ".cm-marker-line": {
        backgroundColor: dark ? "rgba(99,102,241,0.10)" : "rgba(99,102,241,0.05)",
        borderRadius: "6px",
      },
      // 编辑器里的勾选框
      ".cm-marker-box": {
        width: "15px",
        height: "15px",
        marginRight: "7px",
        verticalAlign: "-2px",
        accentColor: "#4f46e5",
        cursor: "pointer",
      },
      // 联动信息那几行：左边线 + 斜体（只读引用）
      ".cm-info-line": {
        borderLeft: `3px solid ${dark ? "#818cf8" : "#a5b4fc"}`,
        marginLeft: "4px",
        paddingLeft: "12px",
        fontStyle: "italic",
        color: dark ? "rgb(148 163 184)" : "rgb(100 116 139)",
        backgroundColor: dark ? "rgba(129,140,248,0.07)" : "rgba(129,140,248,0.06)",
      },
      ".cm-placeholder": { color: dark ? "rgb(100 116 139)" : "rgb(148 163 184)" },
    },
    { dark },
  );
}

/** 应用当前是不是深色（`<html>` 上的 .dark 由 store/ui.ts 的 applyTheme 控制） */
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => observer.disconnect();
  }, []);
  return dark;
}

// ───────────────────────── 组件 ─────────────────────────

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor(
  {
    noteId,
    value,
    checkedKeys,
    onChange,
    onToggleMarker,
    onSaveRequest,
    placeholderText,
    onCursorFormats,
    onHistory,
    onPasteImage,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dark = useIsDark();

  // 回调都放 ref：编辑器只建一次，不能因为父组件换了个函数就重建（重建 = 丢光标、丢撤销栈）
  const noteIdRef = useRef(noteId);
  const toggleRef = useRef(onToggleMarker);
  const changeRef = useRef(onChange);
  const saveRef = useRef(onSaveRequest);
  const valueRef = useRef(value);
  const darkRef = useRef(dark);
  const formatsRef = useRef(onCursorFormats);
  formatsRef.current = onCursorFormats;
  const historyRef = useRef(onHistory);
  historyRef.current = onHistory;
  /** ⑩ 粘贴图片（跟别的回调一样放 ref：编辑器只建一次，换函数不能重建） */
  const pasteImageRef = useRef(onPasteImage);
  pasteImageRef.current = onPasteImage;
  noteIdRef.current = noteId;
  toggleRef.current = onToggleMarker;
  changeRef.current = onChange;
  saveRef.current = onSaveRequest;
  valueRef.current = value;
  darkRef.current = dark;

  /** 编辑器里当前装的是哪一篇（换篇才整篇替换） */
  const loadedIdRef = useRef(noteId);

  useImperativeHandle(
    ref,
    () => ({
      applyAction(action: ToolbarAction) {
        const view = viewRef.current;
        if (!view) return;
        const selection = view.state.selection.main;
        const edit = buildFormatEdit(
          view.state.doc.toString(),
          selection.from,
          selection.to,
          action,
        );
        if (!edit) return;
        view.dispatch({
          changes: edit.change,
          selection: { anchor: edit.anchor, head: edit.head },
          scrollIntoView: true,
        });
        view.focus();
      },
      focus() {
        viewRef.current?.focus();
      },
      cursorLine() {
        const view = viewRef.current;
        if (!view) return 0;
        return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      },
      cursorOffset() {
        return viewRef.current?.state.selection.main.head ?? 0;
      },
      /**
       * M14-A：滚到第 N 行并**把光标放过去**（顺带让 CodeMirror 自己高亮那一行）。
       * ⚠️ 只移动光标与视口，**不动正文一个字**。
       */
      jumpToLine(line: number) {
        const view = viewRef.current;
        if (!view) return;
        const total = view.state.doc.lines;
        const target = Math.max(1, Math.min(total, line + 1));
        const pos = view.state.doc.line(target).from;
        view.dispatch({
          selection: { anchor: pos },
          scrollIntoView: true,
        });
        view.focus();
      },
      /**
       * P2-D：撤销 / 重做。
       *
       * 走的是 CodeMirror 自己的 `history()` 那套（`undo` / `redo` 命令）——
       * **不另外造一套撤销栈**：造了就会跟 `Mod-Z`、跟输入法的撤销打架。
       * 撤销栈是**一篇笔记一条**（换篇走整篇替换、不重建编辑器），和用户的直觉一致。
       */
      undo() {
        const view = viewRef.current;
        if (!view) return;
        undo(view);
        view.focus();
      },
      redo() {
        const view = viewRef.current;
        if (!view) return;
        redo(view);
        view.focus();
      },
      insertText(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const at = view.state.selection.main.head;
        // 跟电脑版"粘图"同一条规矩：前后各补一个换行，别让图挤在文字中间
        const prefix = at > 0 && view.state.doc.sliceString(at - 1, at) !== "\n" ? "\n" : "";
        const body = `${prefix}${text}\n`;
        view.dispatch({
          changes: { from: at, insert: body },
          selection: { anchor: at + body.length },
          scrollIntoView: true,
        });
        view.focus();
      },
    }),
    [],
  );

  // 建编辑器：只建一次
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(highlightStyle, { fallback: true }),
          checkedKeysField,
          themeCompartment.of(buildTheme(darkRef.current)),
          markerDecorations(
            () => noteIdRef.current,
            () => toggleRef.current,
          ),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveRef.current?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          placeholderExtension(placeholderText ?? ""),
          /*
           * ⑩ 粘贴图片（2026-10-11 用户反馈第 10 条）。
           * ⚠️ 只在**剪贴板里真的有图**时接管（`imageFromClipboard` 认不出来就 return false），
           *    粘文字一律走默认行为 —— 别把用户粘的普通文本吃掉。
           * ⚠️ 落盘是异步的，所以拿 `view` 插：等回来时光标可能已经动了（跟 `insertText` 一个道理）。
           */
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const handler = pasteImageRef.current;
              if (!handler) return false;
              const file = imageFromClipboard(event);
              if (!file) return false;
              event.preventDefault();
              void handler(file)
                .then((markdown) => {
                  if (!markdown) return;
                  view.dispatch(view.state.replaceSelection(markdown));
                })
                .catch(() => undefined);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changeRef.current(update.state.doc.toString());
            // P2-C：手机工具条要知道"光标现在在哪一级格式"才高亮得对。
            // ⚠️ 只有传了 onCursorFormats 才算（电脑版不传 → 零开销）。
            if (formatsRef.current && (update.docChanged || update.selectionSet)) {
              formatsRef.current(
                toolbarFormatsAt(update.state.doc.toString(), update.state.selection.main.head),
              );
            }
            // P2-D：撤销/重做那两颗的可用性（历史深度变了才算）
            if (historyRef.current && update.docChanged) {
              historyRef.current({
                canUndo: undoDepth(update.state) > 0,
                canRedo: redoDepth(update.state) > 0,
              });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    // 刚建好先报一次，免得手机工具条一开始什么也不高亮
    formatsRef.current?.(toolbarFormatsAt(view.state.doc.toString(), view.state.selection.main.head));
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 故意只建一次：换笔记走下面的「整篇替换」，换主题走 compartment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换笔记 → 整篇替换；同一篇里外部改了值（且没在打字）→ 也跟上
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    if (loadedIdRef.current === noteId && view.hasFocus) return; // 正在打字：以编辑器为准，别被外部值覆盖
    loadedIdRef.current = noteId;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: 0 },
    });
  }, [noteId, value]);

  // 勾选状态变了 → 让装饰器重画
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.field(checkedKeysField);
    if (current.size === checkedKeys.size && [...checkedKeys].every((key) => current.has(key))) {
      return;
    }
    view.dispatch({ effects: setCheckedKeys.of(checkedKeys) });
  }, [checkedKeys]);

  // 主题切换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeCompartment.reconfigure(buildTheme(dark)) });
  }, [dark]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
});

export default NoteEditor;
