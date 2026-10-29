/**
 * 档案库（M15）—— 认知区之外的**第七个区**，但平时**没有入口**。
 *
 * # 用户定的形态（原话）
 * 「收纳**已经被遗忘、每时每刻都在遗忘、今后必将遗忘**的东西」；定位是**收纳性质、更重要的东西**；
 * 「**独立的区**，但**不仔细在设置里寻找就无法启用**（平时没有入口）」。
 *
 * # 三条已拍板（2026-09-26 / 09-27）
 * 1. 启用方式：设置里**先只写一行小字，点开才出现开关**；
 * 2. 收走之后**从原位收走**（不是留占位），底部给 5 秒「撤销」；
 * 3. 档案库里**能直接改**（连笔记正文都能改）。
 *
 * # 🔴 2026-10-11（P3）整体返工 —— 用户原话
 * 「档案区**应该就是一个极简版本的认知区的文本编辑器**才对，现在的版本不伦不类。**要返工**。」
 * 于是照 `.spike\P3-档案区-设计稿-v3.html` 第 ① 节重做成 **左列表 ＋ 右编辑面板**
 * （不再是"一摞卡片、卡片里塞一张表单"）。定稿七条见 `进度.md` §四十四 44.3：
 * 1. 左列表（一行＝标题 ＋ 来源标签 ＋ 日期，选中行左侧一条紫条）＋ 右编辑面板；
 * 2. 编辑能力补上**图片**（Ctrl+V 粘图 / 拖入）与**目录**（`toc文字` 语法 → 右侧「目录」页签）；
 * 3. 「编辑 / 预览」切换；
 * 4. 保存是「**存下**」按钮 —— 用户明确选的，**不要自动保存**；
 * 5. 按钮按来源变：自己写的 ＝ 彻底删掉 ＋ 存下；收纳来的多一颗「取出」；**自由档案没有「取出」**；
 * 6. **省掉**批注栏 / 树状图 / 分组；档案里的 `-[]` 只是普通文字（不生成待办 —— 后端一个字没改）。
 *
 * 正文那一块**不是**抄第二份：标题行 / 编辑·预览 / 那 10 颗辅助栏 / CodeMirror / 预览 / 粘图
 * 全是认知区那件公共件 `features/notes/NoteBodyPane.tsx`；目录列表是 `features/notes/TocList.tsx`。
 *
 * # 数据
 * 一条档案 = **整条快照**（`snapshot`）+ 标题 / 摘要 / 收纳时间 / 你自己的备注。
 * 取出时按快照放回原来的区（原 id 与时间保留）—— 所以"取出一定回得去"。
 *
 * 🔴 这一页**不广播 `data-changed`**（跟格言 / 奖状 / 日报 / 批注同族），自己刷自己。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveDelete,
  archiveList,
  archiveNoteSave,
  archivePatch,
  archiveRestore,
  archiveSet,
  assetWriteImage,
} from "../features/api";
import NoteBodyPane from "../features/notes/NoteBodyPane";
import type { NoteEditorHandle } from "../features/notes/NoteEditor";
import TocList from "../features/notes/TocList";
import { scanToc } from "../features/notes/toc";
import { fileToBase64 } from "../shared/imageFile";
import { useData } from "../store/data";
import { useUi } from "../store/ui";
import type { ArchiveEntry } from "../features/types";

/** 来源的名字：列表上标一句、取出按钮上也用它 */
const KIND_LABEL: Record<ArchiveEntry["kind"], { from: string; back: string }> = {
  info: { from: "来自信息", back: "取出（回信息区）" },
  note: { from: "来自笔记", back: "取出（回认知区）" },
  todo: { from: "来自待办", back: "取出（回执行区）" },
  // 自由档案（2026-10-11 用户反馈第 2 条）：**没有原位**，所以「取出」那颗不出现
  free: { from: "自己写的", back: "（没有原位，取不出来）" },
};

/** 顶部的两档筛选（照设计稿 ①：全部 / 自己写的 / 收进来的） */
type Filter = "all" | "own" | "taken";

/** 档案里的 `-[]` 不生成待办（用户拍板：只是普通文字）→ 勾选集合永远是空的 */
const EMPTY_KEYS: Set<string> = new Set();

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "own", label: "自己写的" },
  { key: "taken", label: "收进来的" },
];

/** 一条档案在列表/脚注上的日期（照稿子写成 `10-11` 这种短式） */
function dateOf(one: ArchiveEntry): string {
  return one.archivedAt.slice(5, 10);
}

export default function ArchivePage() {
  const toast = useUi((s) => s.toast);
  const askConfirm = useUi((s) => s.askConfirm);
  const setView = useUi((s) => s.setView);
  const archiveEnabled = useData((s) => s.config.archive.enabled);
  const refresh = useData((s) => s.refresh);
  /** ②a：新建自由档案（`store/data.ts` 的 action，失败会自己 toast） */
  const archiveCreate = useData((s) => s.archiveCreate);

  const [items, setItems] = useState<ArchiveEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  /** 右边面板正在编的是哪一条（null＝一条都没选，给个"挑一条"的提示） */
  const [selId, setSelId] = useState<string | null>(null);
  /** 草稿（标题 / 正文 / 备注）—— 用户要求"存下"才落盘，所以这里必须留一份 */
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftNote, setDraftNote] = useState("");
  /** 编辑还是预览（稿子①：标题右边那对） */
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  /**
   * 🔴 2026-10-11（v2.22.1 · 用户当天追加）：「这个区域能不能向右收起？」
   * —— 左边那一栏可以**收起来**，把整幅宽度让给右边的编辑面板。
   * ⚠️ **只在这一次会话里记着**（没写进 `config.json`）：收起是"看一眼"的动作，
   *    每次打开档案库都从"展开"开始，免得他下次进来发现列表不见了以为坏了。
   */
  const [listOpen, setListOpen] = useState(true);
  /** 动过但还没「存下」—— 界面上要看得见（免得悄悄丢了改动） */
  const [dirty, setDirty] = useState(false);
  /** 目录页签的高亮条 */
  const [tocLine, setTocLine] = useState<number | null>(null);
  const editorRef = useRef<NoteEditorHandle | null>(null);

  const reload = useCallback(async () => {
    try {
      const all = await archiveList();
      setItems(all);
      setLoaded(true);
    } catch (error) {
      toast(`读档案库失败：${String(error)}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    if (!archiveEnabled) return;
    void reload();
  }, [archiveEnabled, reload]);

  const shown = useMemo(() => {
    const key = query.trim().toLowerCase();
    return items
      .filter((one) => {
        if (filter === "own") return one.kind === "free";
        if (filter === "taken") return one.kind !== "free";
        return true;
      })
      .filter((one) =>
        key
          ? `${one.title} ${one.summary} ${one.note}`.toLowerCase().indexOf(key) >= 0
          : true,
      )
      .sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1)); // 新收的在前
  }, [items, filter, query]);

  const sel = items.find((one) => one.id === selId) ?? null;

  /** 把一条的草稿装进来（标题 / 正文 / 备注） */
  const loadDraft = (one: ArchiveEntry) => {
    setSelId(one.id);
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
    setTocLine(null);
  };

  /** ②a：新建一条自由档案并**立刻选中它**（用户点的是"创建"，就该落在能写字的那个框里） */
  const createOne = async () => {
    const id = await archiveCreate("新档案", "");
    if (!id) return;
    await reload();
    const all = await archiveList();
    const fresh = all.find((one) => one.id === id);
    if (fresh) {
      setFilter("all");
      setQuery("");
      setMode("edit");
      loadDraft(fresh);
      toast("建好了 —— 写标题和内容，写完点「存下」", "success");
    }
  };

  const restore = async (one: ArchiveEntry) => {
    try {
      await archiveRestore(one.id);
      setItems((all) => all.filter((x) => x.id !== one.id));
      if (selId === one.id) setSelId(null);
      await refresh(); // 放回去了 → 原区那边也要跟着变
      toast(`已取出，回到${one.kind === "note" ? "认知区" : one.kind === "info" ? "信息区" : "执行区"}`, "success");
    } catch (error) {
      toast(`取出失败：${String(error)}`, "error");
    }
  };

  const removeOne = (one: ArchiveEntry) => {
    askConfirm({
      title: "彻底删掉这一条？",
      message: `「${one.title}」会被真删（程序会先留一份档在 backups/ 里）。\n如果只是不想看见它，什么都不用做 —— 它本来就在档案库里躺着。`,
      confirmText: "彻底删掉",
      onConfirm: () => {
        void (async () => {
          try {
            await archiveDelete(one.id);
            setItems((all) => all.filter((x) => x.id !== one.id));
            if (selId === one.id) setSelId(null);
          } catch (error) {
            toast(`删不掉：${String(error)}`, "error");
          }
        })();
      },
    });
  };

  /**
   * 「存下」：把这三种草稿一次落盘。
   * - 笔记 → `archiveNoteSave`（写回 `notes/_archive/<id>.json`，走原子写）
   * - 自由档案 → `archivePatch({title, content})`（它的快照形状就是 `{title, content}`）
   * - 信息 / 待办 → 正文进快照，标题与备注走 `archiveSet`
   * ⚠️ 原来那段是 `if (标题变了) … else if (备注变了) …` —— **改备注时正好也改了标题就存不上备注**，
   *    这里改成两件事各判各的（顺手修掉的小毛病）。
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
      // 标题（信息 / 待办那两种：快照里没标题，标题只在档案条目上）
      if (draftTitle !== updated.title && one.kind !== "note" && one.kind !== "free") {
        updated = await archiveSet(one.id, { title: draftTitle });
      }
      // 备注（可空；跟标题各自独立判断）
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

  /** 粘图 / 拖入：跟认知区同一条路（落盘失败就什么都不插） */
  const pasteImage = async (file: File): Promise<string | null> => {
    try {
      const rel = await assetWriteImage(await fileToBase64(file));
      setDirty(true);
      return `![](${rel})`;
    } catch (error) {
      toast(`图片没能插进来：${String(error)}`, "error");
      return null;
    }
  };

  /** 目录点了跳行：编辑态送光标，预览态滚到那个标题元素 */
  const jumpToLine = (line: number) => {
    setTocLine(line);
    if (mode === "edit") {
      editorRef.current?.jumpToLine(line);
      return;
    }
    const node = document.querySelector(`[data-toc-line="${line}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
  };

  const toc = useMemo(() => scanToc(draftBody), [draftBody]);

  // 开关关掉之后还停在档案库页：别给一片空白，告诉他怎么回去
  if (!archiveEnabled) {
    return (
      <div
        data-archive-disabled
        className="mx-auto mt-10 max-w-xl rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-relaxed shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <h1 className="text-base font-semibold">档案库还没启用</h1>
        <p className="mt-2 text-slate-500 dark:text-slate-400">
          它平时<strong>不出现</strong>在左边 —— 要先去<strong>设置 → 档案区</strong>里点开那行小字、把开关打开。
        </p>
        <button
          type="button"
          onClick={() => setView("settings")}
          className="mt-3 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          去设置里启用
        </button>
      </div>
    );
  }

  return (
    <div data-archive-page className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <header className="shrink-0">
        <h1 className="text-lg font-semibold">档案库</h1>
        <p className="mt-0.5 text-xs text-slate-400">
          给「已经被遗忘、今后必将遗忘」的东西留一间屋子 —— 取出就回到原来的区。
          <span data-archive-count={items.length} className="ml-1">
            共 {items.length} 件
          </span>
        </p>
      </header>

      {/* 搜 + 筛选 + 新建（稿子①第三行） */}
      <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-2">
        <input
          data-archive-search
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="🔍 搜标题 / 内容…"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        {FILTERS.map((one) => (
          <button
            key={one.key}
            type="button"
            data-archive-filter={one.key}
            onClick={() => setFilter(one.key)}
            className={`rounded-full border px-3 py-1.5 text-xs ${
              filter === one.key
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:border-indigo-500/60 dark:bg-indigo-500/15 dark:text-indigo-300"
                : "border-slate-200 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
            }`}
          >
            {one.label}
          </button>
        ))}
        {/* ②a（2026-10-11 用户反馈第 2 条）：用户原话「打开档案区后，**没有创建档案的选项**」
            ＋（问他时）「**两个方案都要有**」→ 除了从别处收进来，这里再给一个"直接在档案库里新建"。
            建出来的是一条**自由档案**（没有原位、取不出来，只能写 / 改 / 删）。 */}
        <button
          type="button"
          data-archive-create
          onClick={() => void createOne()}
          className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
        >
          ＋ 新建
        </button>
      </div>

      {/* 左列表 ＋ 右编辑面板 */}
      <div className="mt-3 flex min-h-0 flex-1 gap-3 pb-3">
        {/* 🔴 2026-10-11（v2.22.1）：这一栏**能收起来**（用户原话「这个区域能不能向右收起？」）——
            收起来之后右边编辑面板吃满整幅宽度；边缘那颗小箭头一直在，点它展开回来。
            ⚠️ 收起态**不写进配置**：每次打开档案库都是展开的（免得他下次以为列表丢了）。 */}
        {listOpen ? (
          <div className="relative flex w-[236px] shrink-0">
            <aside className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <div data-archive-list className="min-h-0 flex-1 overflow-y-auto">
                {loaded && items.length === 0 && (
                  <div
                    data-archive-empty
                    className="m-2 rounded-xl border border-dashed border-slate-300 p-3 text-xs leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  >
                    这里还空着。
                    <br />
                    在<strong>认知区笔记</strong>那一行的 ⋮ 菜单里点「收进档案库」，东西就会挪到这儿来；
                    也可以点右上角「＋ 新建」自己写一条。
                  </div>
                )}
                {loaded && items.length > 0 && shown.length === 0 && (
                  <p data-archive-nomatch className="px-3 py-6 text-xs text-slate-400">
                    没有匹配的（换个词，或把筛选切回「全部」）。
                  </p>
                )}

                {shown.map((one) => {
                  const on = one.id === selId;
                  return (
                    <button
                      key={one.id}
                      type="button"
                      data-archive-card={one.id}
                      data-archive-kind={one.kind}
                      data-archive-open={one.id}
                      onClick={() => loadDraft(one)}
                      className={`block w-full border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 dark:border-slate-800 ${
                        on
                          ? "bg-indigo-50 shadow-[inset_3px_0_0_0_#4f46e5] dark:bg-indigo-500/15"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      }`}
                    >
                      <span
                        data-archive-title={one.id}
                        className="block truncate text-[13px] text-slate-700 dark:text-slate-200"
                      >
                        {one.title}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[10.5px] text-slate-400">
                        <span className="rounded-full border border-slate-200 px-2 py-0.5 dark:border-slate-700">
                          {KIND_LABEL[one.kind].from}
                        </span>
                        <span>{dateOf(one)}</span>
                        <span data-archive-at={one.archivedAt} className="sr-only">
                          {one.archivedAt}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* 收起那一栏：贴在列表右边缘、竖着居中（用户圈的就是这个位置） */}
            <button
              type="button"
              data-archive-list-toggle="close"
              onClick={() => setListOpen(false)}
              title="收起左边这一栏（把整幅宽度让给编辑面板）"
              aria-label="收起列表"
              className="absolute -right-3 top-1/2 z-10 flex h-9 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-xs text-slate-500 shadow-sm hover:bg-slate-100 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              ‹
            </button>
          </div>
        ) : (
          /* 收起来之后：左边只留一条窄边，点它再展开 */
          <button
            type="button"
            data-archive-list-toggle="open"
            onClick={() => setListOpen(true)}
            title="展开左边这一栏"
            aria-label="展开列表"
            className="flex w-6 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-100 hover:text-indigo-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ›
          </button>
        )}

        {/* 右边：编辑面板（没选任何一条时给一句提示） */}
        {sel ? (
          <div
            data-archive-detail={sel.id}
            className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
          >
            <NoteBodyPane
              noteId={sel.id}
              titleAttrName="data-archive-edit-title"
              bodyAttrName="data-archive-edit-body"
              title={draftTitle}
              onTitleChange={(next) => {
                setDraftTitle(next);
                setDirty(true);
              }}
              content={draftBody}
              onContentChange={(next) => {
                setDraftBody(next);
                setDirty(true);
              }}
              mode={mode}
              onModeChange={setMode}
              sideToggleLabel="目录"
              onSaveRequest={() => void saveEdit(sel)}
              /* ⚠️ 档案里的 `-[]` 只是普通文字（用户拍板：不生成待办）——
                 所以 checkedKeys 永远给空的、点了也不写回任何地方。 */
              checkedKeys={EMPTY_KEYS}
              onToggleMarker={() => undefined}
              onPasteImage={pasteImage}
              placeholderText="在这里写…（点上面那排按钮可以插粗体、标题、列表、图片；截图直接 Ctrl+V 就粘进正文）"
              titlePlaceholder="档案标题"
              editorRef={editorRef}
              sidePanel={
                <aside
                  data-archive-toc-panel
                  className="flex w-[168px] shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                >
                  <div className="flex shrink-0 items-center border-b border-slate-200 px-2 py-1.5 text-xs font-medium text-indigo-600 dark:border-slate-800 dark:text-indigo-300">
                    目录{toc.length > 0 ? ` ${toc.length}` : ""}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-xs">
                    <TocList
                      entries={toc}
                      activeLine={tocLine}
                      onJump={jumpToLine}
                      empty={
                        <p data-toc-empty className="px-1 leading-relaxed text-slate-400">
                          还没有目录。
                          <br />
                          在行首写{" "}
                          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">toc第二章</code>{" "}
                          就会出现在这里（点一下就跳过去）。
                        </p>
                      }
                    />
                  </div>
                </aside>
              }
              footer={
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-slate-400">
                  <span>
                    {KIND_LABEL[sel.kind].from} · {sel.kind === "free" ? "建于" : "收于"}{" "}
                    {dateOf(sel)}
                  </span>
                  {/* 备注栏（M15 就有的字段 `archive_set` 的 note）：稿子里没画，
                      但功能不能凭空丢掉，所以缩成脚上这一格 */}
                  <input
                    data-archive-edit-note={sel.id}
                    value={draftNote}
                    onChange={(event) => {
                      setDraftNote(event.target.value);
                      setDirty(true);
                    }}
                    placeholder="备注（可空：为什么收它 / 以后什么时候再看）"
                    className="min-w-[120px] flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11.5px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  {dirty && (
                    <span data-archive-dirty className="text-amber-600 dark:text-amber-400">
                      未保存…
                    </span>
                  )}
                  <button
                    type="button"
                    data-archive-del={sel.id}
                    onClick={() => removeOne(sel)}
                    className="rounded-xl px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-900/30"
                  >
                    彻底删掉
                  </button>
                  {/* ②a：自由档案没有原位 → 这颗不出现 */}
                  {sel.kind !== "free" && (
                    <button
                      type="button"
                      data-archive-restore={sel.id}
                      onClick={() => void restore(sel)}
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {KIND_LABEL[sel.kind].back}
                    </button>
                  )}
                  <button
                    type="button"
                    data-archive-save={sel.id}
                    onClick={() => void saveEdit(sel)}
                    className="rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    存下
                  </button>
                </div>
              }
            />
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs leading-relaxed text-slate-400 dark:border-slate-700">
            {shown.length > 0 ? (
              <>
                左边挑一条打开。
                <br />
                改完记得点「存下」—— 这一页<strong>不会自动保存</strong>。
              </>
            ) : (
              <>还没有可以打开的档案。</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
