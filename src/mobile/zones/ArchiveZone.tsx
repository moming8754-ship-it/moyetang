/**
 * 手机版 · 档案库（M19.7 / v2.8.0 → **2026-10-11 P3 整体返工**）
 *
 * # 用户定的形态（原话）
 * 「档案区**应该就是一个极简版本的认知区的文本编辑器**才对，现在的版本不伦不类。**要返工**。」
 * 照 `.spike\P3-档案区-设计稿-v3.html` 第 ③ / ④ 节重做：
 * - **A1 列表页**：顶栏（标题 ＋ 右上「＋ 新建」）｜ 搜索 ｜ 三档筛选 ｜ 一行一条（标题 ＋ 来源标签 ＋ 日期）；
 * - **A2 打开一篇**：顶栏（‹ 返回 / 标题）｜ 正文 ｜ **右侧悬浮球 ＋ 竖排 13 颗**（只在编辑态）｜
 *   底部细条（来源 · 日期 ＋ 阅读/编辑 切换）＋ 一行动作（彻底删掉 / 取出 / **存下**）；
 * - **A3**：竖排条上的 `toc` 颗 → **底部弹出目录**，点一条跳过去、顺手收起。
 *
 * # 定稿七条里跟这一页有关的
 * ② 列表 → 点进去全屏写；③ 图片（竖排条第 3 颗「🖼 导入图片」）＋ 目录；④ 阅读/编辑（默认听 `noteOpenMode`）；
 * ⑤ **「存下」按钮**（用户明确选的，**不要自动保存**）；⑥ 按钮按来源变（自由档案没有「取出」）；
 * ⑦ 省掉批注栏 / 树状图 / 分组 —— 档案里的 `-[]` **只是普通文字**（不生成待办，后端一个字没改）。
 *
 * ⚠️ 档案库在电脑版里是「**默认没有入口**」（设置里开了「档案区」才出现）——
 *    手机版照同一条规矩：没启用就只显示一句"去设置里开"，跟 `ArchivePage.tsx` 的 `data-archive-disabled` 等价。
 * ⚠️ 复用的是同一批后端命令：`archiveList` / `archiveRestore` / `archiveDelete` / `archiveSet` /
 *    `archiveNoteSave` / `archivePatch`。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  archiveDelete,
  archiveList,
  archiveNoteSave,
  archivePatch,
  archiveRestore,
  archiveSet,
  assetWriteImage,
} from "../../features/api";
import type { ArchiveEntry } from "../../features/types";
import type { ToolbarAction } from "../../features/notes/format";
import NoteEditor from "../../features/notes/NoteEditor";
import type { NoteEditorHandle } from "../../features/notes/NoteEditor";
import MarkdownPreview from "../../features/notes/MarkdownPreview";
import TocList from "../../features/notes/TocList";
import { scanToc } from "../../features/notes/toc";
import { fileToBase64 } from "../../shared/imageFile";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { registerBackLayer } from "../back";
import NoteToolbarBall from "./NoteToolbarBall";
import type { BallPos } from "./NoteToolbarBall";

/**
 * 🔴 2026-10-11 用户反馈第 3 条：「档案区…上方，不需要「待办」选项」——
 * 去掉了按"来源类型"分档，照 P3 稿子改成**按来路分三档**：
 * 全部 / **自己写的**（自由档案）/ **收进来的**（信息 · 笔记 · 待办）。
 * ⚠️ 只是**换了筛选口径**：已经收在里面的待办**照旧显示**在「全部」和「收进来的」里 ——
 *    别顺手把"能收纳待办"这件事也删了。
 */
type Filter = "all" | "own" | "taken";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "own", label: "自己写的" },
  { key: "taken", label: "收进来的" },
];

const KIND_LABEL: Record<ArchiveEntry["kind"], { from: string; back: string }> = {
  info: { from: "来自信息", back: "取出（回信息区）" },
  note: { from: "来自笔记", back: "取出（回认知区）" },
  todo: { from: "来自待办", back: "取出（回执行区）" },
  // ②a（2026-10-11 用户反馈第 2 条）：直接在档案库里新建的那种（没有原位）
  free: { from: "自己写的", back: "（没有原位）" },
};

/** 档案里的 `-[]` 不生成待办（用户拍板：只是普通文字）→ 勾选集合永远是空的 */
const EMPTY_KEYS: Set<string> = new Set();

/** 列表/脚注上的短日期（照稿子：`10-11`） */
function dateOf(one: ArchiveEntry): string {
  return one.archivedAt.slice(5, 10);
}

export default function ArchiveZone() {
  const config = useData((s) => s.config);
  const saveConfig = useData((s) => s.saveConfig);
  const toast = useUi((s) => s.toast);
  /** ②a：新建自由档案（store 里的 action，失败会自己 toast） */
  const archiveCreate = useData((s) => s.archiveCreate);

  const [items, setItems] = useState<ArchiveEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<ArchiveEntry | null>(null);
  const [confirmDel, setConfirmDel] = useState<ArchiveEntry | null>(null);

  /** 打开的那一条的草稿 —— 用户要求"存下"才落盘，所以必须留一份 */
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [dirty, setDirty] = useState(false);
  /** B1（2026-10-07）：默认进「阅读」还是「编辑」，听设置里的开关（默认 read） */
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [cursorFormats, setCursorFormats] = useState<ToolbarAction[]>([]);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [tocOpen, setTocOpen] = useState(false);
  const editorRef = useRef<NoteEditorHandle | null>(null);

  const enabled = config.archive.enabled;
  const opened = items.find((one) => one.id === openId) ?? null;

  // P0-2：返回手势先关目录弹层 → 再关确认框 → 再退回列表
  const backSheetOpen = !!(tocOpen || openId || confirmRestore || confirmDel);
  useEffect(() => {
    if (!backSheetOpen) return;
    return registerBackLayer(() => {
      if (tocOpen) {
        setTocOpen(false);
        return true;
      }
      if (confirmRestore || confirmDel) {
        setConfirmRestore(null);
        setConfirmDel(null);
        return true;
      }
      setOpenId(null);
      return true;
    });
  }, [backSheetOpen, tocOpen, confirmRestore, confirmDel]);

  const load = async () => {
    try {
      setItems(await archiveList());
    } catch {
      setItems([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    if (enabled) void load();
  }, [enabled]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((one) => {
      if (filter === "own" && one.kind !== "free") return false;
      if (filter === "taken" && one.kind === "free") return false;
      if (!q) return true;
      return (
        one.title.toLowerCase().includes(q) ||
        one.summary.toLowerCase().includes(q) ||
        one.note.toLowerCase().includes(q)
      );
    });
  }, [items, query, filter]);

  /** 把一条的草稿装进来（标题 / 正文 / 备注）＋按设置决定进阅读还是编辑 */
  const loadDraft = (one: ArchiveEntry) => {
    setDraftTitle(one.title);
    setDraftNote(one.note);
    const snap = one.snapshot as Record<string, unknown>;
    setDraftBody(
      one.kind === "note"
        ? String(snap.content ?? "")
        : one.kind === "info"
          ? String(snap.text ?? "")
          : one.kind === "free"
            ? String(snap.content ?? "")
            : String(snap.title ?? ""),
    );
    setDirty(false);
    setCursorFormats([]);
    setMode(config.noteOpenMode === "edit" ? "edit" : "read");
    setOpenId(one.id);
  };

  /**
   * ②a（2026-10-11 用户反馈第 2 条）：新建一条**自由档案**并立刻打开它，
   * 直接落在能写字的地方（用户点的是"新建"，就该直接能写）。
   */
  const createOne = async () => {
    const id = await archiveCreate("新档案", "");
    if (!id) return;
    await load();
    const fresh = (await archiveList()).find((one) => one.id === id);
    if (fresh) {
      setFilter("all");
      setQuery("");
      loadDraft(fresh);
      setMode("edit"); // 刚建的空档案：直接给编辑态，不然是"读一片空白"
      toast("建好了 —— 写标题和内容，写完点「存下」", "success");
    }
  };

  /**
   * 「存下」：三种草稿一次落盘（跟电脑版 `ArchivePage.saveEdit` 同一套口径）。
   * ⚠️ **不自动保存** —— 用户明确选的「存下」按钮。
   */
  const saveEdit = async (one: ArchiveEntry) => {
    try {
      let updated = one;
      if (one.kind === "note") {
        updated = await archiveNoteSave(one.id, draftTitle, draftBody);
      } else if (one.kind === "free") {
        updated = await archivePatch(one.id, { title: draftTitle, content: draftBody });
      } else if (one.kind === "info") {
        updated = await archivePatch(one.id, { text: draftBody });
      } else {
        updated = await archivePatch(one.id, { title: draftBody });
      }
      if (draftTitle !== updated.title && one.kind !== "note" && one.kind !== "free") {
        updated = await archiveSet(one.id, { title: draftTitle });
      }
      if (draftNote !== updated.note) {
        updated = await archiveSet(one.id, { note: draftNote });
      }
      setItems((all) => all.map((x) => (x.id === one.id ? updated : x)));
      setDirty(false);
      toast("存下了", "success");
    } catch (error) {
      toast(`没存上：${String(error)}`, "error");
    }
  };

  /** 竖排条第 3 颗「🖼 导入图片」：调系统相册 → 落进 `assets/` → 光标处插一行 */
  const importImage = async (file: File) => {
    try {
      const base64 = await fileToBase64(file);
      const rel = await assetWriteImage(base64);
      editorRef.current?.insertText(`![](${rel})`);
      setDirty(true);
      toast("图片已插到光标处（存在 assets/ 里）");
    } catch (error) {
      toast("插入图片失败：" + String(error), "error");
    }
  };

  /** 粘贴进来的图（手机外接键盘 / 系统剪切板）：跟选图同一条路 */
  const pasteImage = async (file: File): Promise<string | null> => {
    try {
      const rel = await assetWriteImage(await fileToBase64(file));
      setDirty(true);
      return `![](${rel})`;
    } catch (error) {
      toast("图片没能插进来：" + String(error), "error");
      return null;
    }
  };

  /** P2-D：球拖完 → 位置记进 `config.json`（跟认知区共用一个位置） */
  const moveBall = async (next: BallPos) => {
    await saveConfig({ mobileToolbarBall: next });
  };

  /** 目录点了跳过去：编辑态送光标，阅读态滚到那个标题元素；顺手收起弹层 */
  const jumpToLine = (line: number) => {
    setTocOpen(false);
    if (mode === "edit") {
      editorRef.current?.jumpToLine(line);
      return;
    }
    const node = document.querySelector(`[data-toc-line="${line}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
  };

  const toc = useMemo(() => scanToc(draftBody), [draftBody]);

  // ── 没启用：跟电脑版 `data-archive-disabled` 一个意思 ───────────────
  if (!enabled) {
    return (
      <div data-mobile-zone="archive" className="flex h-full flex-col p-3">
        <div
          data-marchive-disabled
          className="rounded-xl border border-dashed border-slate-300 p-5 text-[12.5px] leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400"
        >
          <p className="mb-1 text-[13px] font-semibold text-slate-700 dark:text-slate-200">档案库还没启用</p>
          <p>
            它默认是"藏起来"的 —— 去 <b>设置 → 数据 → 档案库（收纳功能）</b> 打开，导航里就会出现入口。
            <br />
            收进去的东西<strong>不会删</strong>，随时能取出来。
          </p>
        </div>
      </div>
    );
  }

  // ── A2 / A3：打开一篇（全屏写） ─────────────────────────────────────
  if (opened) {
    return (
      <div data-mobile-zone="archive" data-marchive-detail={opened.id} className="relative flex h-full flex-col">
        {/* 顶栏：‹ 返回 / 标题 */}
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-2 py-2 dark:border-slate-800">
          <button
            type="button"
            data-marchive-back
            onClick={() => setOpenId(null)}
            className="rounded-lg px-2 py-1 text-[19px] leading-none text-slate-500 dark:text-slate-300"
          >
            ‹
          </button>
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{draftTitle || opened.title}</span>
          {dirty && <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">未保存…</span>}
        </header>

        {/* 正文 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {mode === "edit" ? (
            <>
              <input
                data-marchive-title
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value);
                  setDirty(true);
                }}
                placeholder="标题"
                className="mb-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[14px] font-semibold outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
              />
              <NoteEditor
                key={opened.id}
                ref={editorRef}
                noteId={opened.id}
                value={draftBody}
                checkedKeys={EMPTY_KEYS}
                onChange={(next) => {
                  setDraftBody(next);
                  setDirty(true);
                }}
                onToggleMarker={() => undefined}
                onSaveRequest={() => void saveEdit(opened)}
                onCursorFormats={setCursorFormats}
                onHistory={setHistoryState}
                onPasteImage={pasteImage}
                placeholderText="在这里写…（右下那颗球点开是工具条）"
              />
            </>
          ) : (
            <MarkdownPreview
              noteId={opened.id}
              content={draftBody}
              checkedKeys={EMPTY_KEYS}
              onToggleMarker={() => undefined}
              sourceInfos={[]}
              onOpenInfo={() => undefined}
            />
          )}
        </div>

        {/* 悬浮球 ＋ 竖排条（只在编辑态；位置存 config.json，跟认知区共用） */}
        {mode === "edit" && (
          <NoteToolbarBall
            active={cursorFormats}
            /* 🔴 照稿子 ⑤：竖排条上的 `toc` 颗在档案区是**打开目录**（认知区那边它是插语法）。
               底排 13 颗的顺序/来源一个字没改，还是 EditorToolbar 那份单一来源。 */
            onAction={(action) =>
              action === "toc" ? setTocOpen(true) : editorRef.current?.applyAction(action)
            }
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
            onUndo={() => editorRef.current?.undo()}
            onRedo={() => editorRef.current?.redo()}
            onPickImage={(file) => void importImage(file)}
            pos={config.mobileToolbarBall}
            onMove={(next) => void moveBall(next)}
          />
        )}

        {/* 底部细条：来源 · 日期 ＋ 阅读/编辑；再一行动作（照稿子 ④） */}
        <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <span>
              {KIND_LABEL[opened.kind].from} · {opened.kind === "free" ? "建于" : "收于"} {dateOf(opened)}
            </span>
            <button
              type="button"
              data-marchive-mode
              onClick={() => setMode(mode === "read" ? "edit" : "read")}
              className="ml-auto rounded-full border border-slate-200 px-3 py-1 text-[11.5px] text-slate-600 dark:border-slate-700 dark:text-slate-300"
            >
              {mode === "read" ? "编辑" : "阅读"}
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-marchive-del={opened.id}
              onClick={() => setConfirmDel(opened)}
              className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-[12px] text-rose-600 dark:border-slate-700 dark:text-rose-400"
            >
              彻底删掉
            </button>
            {/* ⑥ 按来源变：自由档案没有原位 → 这颗不出现 */}
            {opened.kind !== "free" && (
              <button
                type="button"
                data-marchive-restore={opened.id}
                onClick={() => setConfirmRestore(opened)}
                className="rounded-xl border border-slate-200 px-2.5 py-1.5 text-[12px] text-indigo-600 dark:border-slate-700 dark:text-indigo-300"
              >
                取出
              </button>
            )}
            <button
              type="button"
              data-marchive-save={opened.id}
              onClick={() => void saveEdit(opened)}
              className="ml-auto rounded-xl bg-indigo-600 px-4 py-1.5 text-[12.5px] font-medium text-white"
            >
              存下
            </button>
          </div>
          {/* 备注栏（M15 就有的字段）：稿里没画，功能不能凭空丢掉，缩成脚上这一格 */}
          <input
            data-marchive-note
            value={draftNote}
            onChange={(event) => {
              setDraftNote(event.target.value);
              setDirty(true);
            }}
            placeholder="备注（可空）"
            className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11.5px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
          />
        </div>

        {/* A3：目录（底部弹出） */}
        {tocOpen && (
          <div
            data-marchive-toc
            className="absolute inset-0 z-40 flex flex-col justify-end bg-slate-900/40"
            onClick={() => setTocOpen(false)}
          >
            <div
              className="max-h-[60%] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="pb-2 text-[13px] font-bold">目录</p>
              <TocList
                entries={toc}
                onJump={jumpToLine}
                empty={
                  <p data-toc-empty className="text-[12px] leading-relaxed text-slate-400">
                    这篇还没有目录。
                    <br />
                    在行首写 <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">toc这一行的标题</code>
                    就会出现在这里（点一下就跳过去）。
                  </p>
                }
              />
              <button
                type="button"
                data-marchive-toc-close
                onClick={() => setTocOpen(false)}
                className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-[12.5px] dark:bg-slate-800"
              >
                收起
              </button>
            </div>
          </div>
        )}

        {/* 取出（问一句）*/}
        {confirmRestore && (
          <div data-marchive-confirm className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6" onClick={() => setConfirmRestore(null)}>
            <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
              <p className="text-[13px] leading-relaxed">把「{confirmRestore.title}」取出来？它会回到原来的区。</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  data-marchive-confirm-restore
                  onClick={() => {
                    const one = confirmRestore;
                    setConfirmRestore(null);
                    void archiveRestore(one.id).then(() => {
                      setOpenId(null);
                      void load();
                      toast("取出来了，回原来的区看看", "success");
                    });
                  }}
                  className="flex-1 rounded-xl bg-indigo-600 py-2 text-[13px] font-medium text-white"
                >
                  取出来
                </button>
                <button type="button" data-marchive-confirm-cancel onClick={() => setConfirmRestore(null)} className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800">
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除（问一句）*/}
        {confirmDel && (
          <div data-marchive-del-confirm className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6" onClick={() => setConfirmDel(null)}>
            <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
              <p className="text-[13px] leading-relaxed">彻底删掉「{confirmDel.title}」？删之前会自动留一份档。</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  data-marchive-del-confirm-yes
                  onClick={() => {
                    const one = confirmDel;
                    setConfirmDel(null);
                    void archiveDelete(one.id).then(() => {
                      setOpenId(null);
                      void load();
                    });
                  }}
                  className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white"
                >
                  删掉
                </button>
                <button type="button" data-marchive-del-confirm-no onClick={() => setConfirmDel(null)} className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800">
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── A1：列表页 ──────────────────────────────────────────────────────
  return (
    <div data-mobile-zone="archive" className="flex h-full flex-col">
      {/* ⚠️ 顶栏那个「档案库」**由外壳（`MobileShell`）画**，这里不重复写一遍标题；
          「＋ 新建」照稿子①放在右上一行（跟筛选同一行，右对齐）。 */}
      <div className="shrink-0 px-3 pt-3">
        <input
          data-marchive-search
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="🔍 搜标题 / 内容…"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
        />
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {FILTERS.map((one) => (
            <button
              key={one.key}
              type="button"
              data-marchive-filter={one.key}
              data-marchive-filter-active={filter === one.key ? "1" : "0"}
              onClick={() => setFilter(one.key)}
              className={
                "shrink-0 rounded-full border px-3 py-1 text-[11px] " +
                (filter === one.key
                  ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
              }
            >
              {one.label}
            </button>
          ))}
          <button
            type="button"
            data-marchive-create
            onClick={() => void createOne()}
            className="ml-auto shrink-0 rounded-full bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white"
          >
            ＋ 新建
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">
        <p className="px-1 py-1 text-[11px] text-slate-400">
          共 <span data-marchive-count={items.length}>{items.length}</span> 件 · 取出就回到原来的区
        </p>

        {loaded && items.length === 0 && (
          <p data-marchive-empty className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-[12.5px] text-slate-400 dark:border-slate-700">
            还没有收纳的东西。
          </p>
        )}
        {loaded && items.length > 0 && filtered.length === 0 && (
          <p data-marchive-nomatch className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-[12.5px] text-slate-400 dark:border-slate-700">
            当前筛选下没有。
          </p>
        )}

        {filtered.length > 0 && (
          <ul data-marchive-list className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {filtered.map((one) => (
              <li key={one.id}>
                <button
                  type="button"
                  data-marchive-item={one.id}
                  data-marchive-open={one.id}
                  onClick={() => loadDraft(one)}
                  className="block w-full px-3 py-2.5 text-left active:bg-slate-100 dark:active:bg-slate-800"
                >
                  <span className="block truncate text-[13px]">{one.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                      {KIND_LABEL[one.kind].from}
                    </span>
                    <span>{dateOf(one)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
