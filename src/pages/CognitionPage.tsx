/**
 * 认知区（M3 文本笔记 + M4 树状图）：想法生长的地方。
 *
 * 左栏 = 笔记列表（类型图标 / 标题 / 时间）+「新建笔记 ▾」选类型 + 搜索；
 * 右栏 = 文本笔记走 {@link DocNotePane}（CodeMirror 编辑器 / Markdown 预览），
 *        树状图走 {@link TreeNotePane}（真画布：自动分层布局 + 连线 + 三图标）。
 *
 * **单向可见**在这页的体现：这里看得到信息区联动进来的内容
 * （`sourceInfoIds` → 正文里的引用块 / 树节点上的〔联动信息〕标记），
 * 反过来信息区读不到笔记正文，它只有一条"已联动 → 认知区《XX》"的去向标记。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import PageShell from "../components/PageShell";
import FloatingMenu from "../components/FloatingMenu";
import DocNotePane from "../features/notes/DocNotePane";
import TreeNotePane from "../features/tree/TreeNotePane";
import { scanMarkers } from "../features/notes/markers";
import { countNodes } from "../features/tree/treeOps";
import { noteExportFile, notesExportDir, notesImportFiles } from "../features/api";
import { useData } from "../store/data";
import { useUi } from "../store/ui";
import { formatStamp } from "../shared/daytime";
import type { ExportFormat, Note, NoteKind } from "../features/types";

const CARD =
  "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

/**
 * 反馈·1022 #5：认知区**左侧列表滚到哪了**记一下，回到这一页（或从笔记退回列表）时回到原位。
 *
 * 为什么放模块级而不是 state：列表在"点开笔记 / 切去别的区 / 收起这一栏"时会被卸载，
 * state 跟着没了；模块级变量在这一整个应用会话里都活着，也不会触发重渲染。
 * ⚠️ 只记位置，不记任何笔记数据。
 */
let lastListScroll = 0;

/**
 * 「另存为」对话框的默认文件名：把文件名里不能出现的字符换掉（和 Rust 侧
 * `export::safe_stem` 同一套规矩 —— 两边不一致的话，用户看到的名字会跟落盘的名字不一样）。
 */
function defaultFileName(title: string, ext: ExportFormat): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[ .]+$/, "");
  return `${cleaned || "未命名笔记"}.${ext}`;
}

export default function CognitionPage() {
  const notes = useData((state) => state.notes);
  const createNote = useData((state) => state.createNote);
  const deleteNote = useData((state) => state.deleteNote);
  const focusRef = useData((state) => state.focusRef);
  const setFocusRef = useData((state) => state.setFocusRef);
  const askConfirm = useUi((state) => state.askConfirm);
  const toast = useUi((state) => state.toast);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  /** 刚新建的笔记：标题自动选中，方便直接改名 */
  const [freshId, setFreshId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // ── M8 方案 A：分组 + 折叠 ──────────────────────────────────────────────
  const setNoteGroup = useData((state) => state.setNoteGroup);
  /**
   * 哪一篇的**行菜单**开着 ＋ 开在哪儿（触发按钮的 `getBoundingClientRect()`）。
   *
   * 2026-10-11（v2.19.0 · 用户反馈第 11 条）改的：原来只存 `noteId`，菜单用 `absolute`
   * 挂在那一行里 → 被列表容器的 `overflow-y-auto` **裁掉**，底下几项（导出纯文本 / 删除）
   * 根本露不出来（他截图里断在「导入 Markdown…」半行上）。现在整条交给 `FloatingMenu`
   * （portal 到 body ＋ `fixed` 定位 ＋ **下面放不下就往上翻**），并且把只存 id 换成存 rect。
   */
  const [rowMenu, setRowMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  /** 行菜单里"新建分组"输入框的内容 */
  const [newGroupName, setNewGroupName] = useState("");
  /** M15：收进档案库（只在启用了「档案区」时才在行菜单里出现） */
  const archiveOne = useData((state) => state.archiveOne);
  const archiveEnabled = useData((state) => state.config.archive.enabled);
  /**
   * ⑬ 批量选择（2026-10-11 用户反馈第 13 条：「删除等行为缺少批量处理的能力」）。
   *
   * ⚠️ **批量删除走的是一篇一篇同一个命令**（`deleteNote` → `note_delete` → 先留档、
   *    再挪进 `notes/_trash/`），**不新开一条"批量硬删"的后端命令** —— 笔记删除的
   *    三条红线（留档 / 挪回收站 / 同步埋墓碑）必须一条都不少。
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  /**
   * 折叠起来的分组名（空串代表"未分组"那一组）。
   *
   * 放在**内存**里（不写 config）：折叠是"我现在想少看点"，不是设置。
   *
   * ④ 2026-10-11（v2.20.0 · 用户反馈第 4 条）改的：原来初始值写死 `[]`（全部展开）；
   * 现在 `null` 表示**用户还没动过** → 按设置里的 `cognitionGroupDefault` 现算
   * （`collapse-grouped` = 分好类的收起来、没分类的展开 —— 他要的那条愿景）；
   * 用户一点折叠/展开就 materialize 成数组，**从那一刻起以他点的为准**。
   */
  const [collapsed, setCollapsed] = useState<string[] | null>(null);
  const groupDefault = useData((state) => state.config.cognitionGroupDefault);
  /**
   * #1（2026-10-21 · 用户反馈第二批）：「认知区这一侧也改成可以向左折叠」——
   * 照档案区 v2.22.1 那套：收起后只留一条 24px 的窄边，宽度全让给右边编辑区。
   * ⚠️ **只在这一次会话里记着**（不写 `config.json`）：收起是"看一眼"的动作，
   *    每次进认知区都从展开开始，免得他下次进来以为笔记列表丢了。
   */
  const [listOpen, setListOpen] = useState(true);
  // 反馈·1022 #5：列表滚动容器（位置存在上面的 `lastListScroll` 里）
  const listRef = useRef<HTMLDivElement | null>(null);

  // 从信息区点「→ 认知区《XX》」跳过来时，直接选中那篇
  useEffect(() => {
    if (focusRef?.kind === "note") {
      setPickedId(focusRef.id);
      setFocusRef(null);
    }
  }, [focusRef, setFocusRef]);

  // 反馈·1022 #5：列表重新挂上（切回认知区 / 展开左栏）时，滚回上次的位置
  useEffect(() => {
    const element = listRef.current;
    if (!element || lastListScroll <= 0) return;
    element.scrollTop = lastListScroll;
  }, [listOpen]);

  // 点别处关掉「新建笔记 ▾」
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const current = useMemo(() => {
    if (notes.length === 0) return null;
    return notes.find((note) => note.id === pickedId) ?? notes[0];
  }, [notes, pickedId]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return notes;
    return notes.filter(
      (note) =>
        note.title.toLowerCase().includes(keyword) ||
        note.content.toLowerCase().includes(keyword),
    );
  }, [notes, query]);

  /** 正在搜索吗（搜的时候平铺显示，不按分组缩进） */
  const searching = query.trim().length > 0;

  /**
   * 把笔记按分组切成几段（M8 方案 A）。
   *
   * 顺序规则：**有名字的分组按名字排（Unicode 码点序，稳定不变），"未分组"永远放最后** ——
   * 未分组是"还没想好放哪儿"的收容所，放最后不会挡着正经分组。
   * （想让顺序听自己的，就给分组名加序号，比如 `01 密码学`。）
   */
  const sections = useMemo(() => {
    const named = new Map<string, Note[]>();
    const ungrouped: Note[] = [];
    for (const note of notes) {
      const name = (note.group ?? "").trim();
      if (!name) {
        ungrouped.push(note);
        continue;
      }
      const bucket = named.get(name);
      if (bucket) bucket.push(note);
      else named.set(name, [note]);
    }
    const list = [...named.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, groupNotes]) => ({ name, notes: groupNotes }));
    if (ungrouped.length > 0) list.push({ name: "", notes: ungrouped });
    return list;
  }, [notes]);

  /** 目前用过的分组名（给「移到分组」菜单用） */
  const knownGroups = useMemo(
    () =>
      sections
        .map((section) => section.name)
        .filter((name) => name.length > 0),
    [sections],
  );

  /** 实际生效的折叠集合：用户动过就用他动的，没动过就按设置算（④ 2026-10-11） */
  const collapsedNow = useMemo(() => {
    if (collapsed) return collapsed;
    if (groupDefault !== "collapse-grouped") return [];
    return sections.filter((one) => one.name).map((one) => one.name);
  }, [collapsed, groupDefault, sections]);

  const isCollapsed = (name: string) => collapsedNow.includes(name);
  const toggleGroup = (name: string) =>
    setCollapsed((old) => {
      const base = old ?? collapsedNow;
      return base.includes(name) ? base.filter((one) => one !== name) : [...base, name];
    });

  /** 移到分组（空串 = 移出分组） */
  const moveToGroup = async (note: Note, group: string) => {
    setRowMenu(null);
    setNewGroupName("");
    const saved = await setNoteGroup(note.id, group);
    if (saved) {
      // 移进去之后把那组展开 —— 不然用户看到的是"笔记不见了"
      setCollapsed((old) => (old ?? collapsedNow).filter((one) => one !== group.trim()));
      toast(group.trim() ? `已移到「${group.trim()}」` : "已移出分组", "success");
    }
  };

  // ── M27：导出 / 导入（人可读的 md / txt） ────────────────────────────────
  const refresh = useData((state) => state.refresh);

  /**
   * 导出**这一篇**：走系统的「另存为」对话框（电脑端这套是好的），
   * 正文里用到的图会复制到主文件旁边的 `<文件名>.assets/`，链接跟着改成相对路径。
   */
  const exportOne = async (note: Note, format: ExportFormat) => {
    setRowMenu(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        title: format === "md" ? "导出成 Markdown" : "导出成纯文本",
        defaultPath: defaultFileName(note.title, format),
        filters:
          format === "md"
            ? [{ name: "Markdown", extensions: ["md"] }]
            : [{ name: "纯文本", extensions: ["txt"] }],
      });
      if (typeof dest !== "string" || !dest) return;
      const report = await noteExportFile(note.id, dest, format, format === "md");
      toast(
        report.images > 0
          ? `导出好了：${report.file}（连 ${report.images} 张图）`
          : `导出好了：${report.file}`,
        "success",
      );
    } catch (error) {
      toast("导出失败：" + String(error), "error");
    }
  };

  /** 导入若干 md/txt（可多选）→ 每个文件一篇新笔记 */
  const importNotes = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "选要导入的 Markdown / 纯文本（可多选）",
        multiple: true,
        filters: [{ name: "Markdown / 纯文本", extensions: ["md", "markdown", "txt"] }],
      });
      const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (paths.length === 0) return;
      const report = await notesImportFiles(paths);
      await refresh();
      const extra = [
        report.images > 0 ? `收进 ${report.images} 张图` : "",
        report.failed.length > 0 ? `${report.failed.length} 个没成` : "",
      ]
        .filter(Boolean)
        .join("，");
      toast(
        `导入 ${report.notes.length} 篇${extra ? `（${extra}）` : ""}`,
        report.failed.length > 0 ? "info" : "success",
      );
      if (report.failed.length > 0) {
        // 失败原因逐条留在控制台，别让用户只看到一个数字
        console.warn("[东方摩耶堂] 导入失败明细：", report.failed);
      }
    } catch (error) {
      toast("导入失败：" + String(error), "error");
    }
  };

  /** 把整个认知区导出到一个文件夹（每篇一个 .md + 各自的 .assets/） */
  const exportAll = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        title: "选一个文件夹，把认知区所有笔记导进去",
        directory: true,
        multiple: false,
      });
      if (typeof dir !== "string" || !dir) return;
      const report = await notesExportDir(null, dir, "md", true);
      toast(
        `导出 ${report.notes} 篇到 ${report.dir}${report.images ? `（连 ${report.images} 张图）` : ""}`,
        report.failed.length > 0 ? "info" : "success",
      );
      if (report.failed.length > 0) {
        console.warn("[东方摩耶堂] 批量导出没成的：", report.failed);
      }
    } catch (error) {
      toast("批量导出失败：" + String(error), "error");
    }
  };

  /**
   * ⚠️ 「点别处关掉小菜单」原来在这里（`document mousedown` ＋ `groupMenuRef`）——
   * 2026-10-11 起**删掉了**：菜单改走 `FloatingMenu`，它自己管外面点一下 / Esc /
   * 滚动 / 改窗口大小（两处都写会关两次，还会把菜单里的输入框点掉）。
   */

  /** 笔记列表里的一行（分组视图与搜索结果共用） */
  const renderRow = (note: Note) => {
    const markerCount = note.kind === "doc" ? scanMarkers(note.id, note.content).length : 0;
    const treeCount = note.kind === "tree" && note.root ? countNodes(note.root) : 0;
    const menuOpenForThis = rowMenu?.id === note.id;
    const isSelected = selected.includes(note.id);
    return (
      <li key={note.id} data-note-row={note.id} className="relative">
        <div
          /* D 批（2026-10-04）：**线分层** —— 行不再各包一张圆角卡片（一屏十几个框会眼瞎），
             改成"贴身行 + 行间细线（父级 `divide-y`）+ 左侧色条表达状态"。
             ⚠️ 行内的钩子（`data-note-open` / `data-note-group-btn`）一个没动。 */
          className={`flex w-full items-start gap-1 border-l-2 px-2 py-2 transition-colors ${
            isSelected
              ? "border-l-indigo-400 bg-indigo-50/70 dark:bg-indigo-500/10"
              : current?.id === note.id
                ? "border-l-indigo-400 bg-indigo-50/70 dark:bg-indigo-500/10"
                : "border-l-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50"
          }`}
        >
          {/* ⑬ 批量模式：每行左边一颗勾（点整行也是勾选） */}
          {selectMode && (
            <span
              data-note-check={note.id}
              data-note-check-on={isSelected ? "1" : "0"}
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
                isSelected
                  ? "border-indigo-500 bg-indigo-500 text-white"
                  : "border-slate-300 text-transparent dark:border-slate-600"
              }`}
            >
              ✓
            </span>
          )}
          <button
            type="button"
            data-note-open={note.id}
            onClick={() => (selectMode ? toggleSelected(note.id) : setPickedId(note.id))}
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
          >
            <span className="text-sm leading-5">{note.kind === "tree" ? "🌳" : "📝"}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{note.title}</span>
              <span className="mt-0.5 block truncate text-xs text-slate-400">
                {formatStamp(note.updatedAt)}
                {treeCount > 0 && ` · ${treeCount} 节点`}
                {note.sourceInfoIds.length > 0 && ` · 联动 ${note.sourceInfoIds.length}`}
                {markerCount > 0 && ` · 待办 ${markerCount}`}
              </span>
            </span>
          </button>
          {/* 行菜单入口（🔴 2026-10-11 用户反馈第 12 条：删除从编辑区右上角**挪到这里**）——
              一行一个，不抢主按钮的地方；批量模式下不出现（那时候整行都是勾选框） */}
          {!selectMode && (
            <button
              type="button"
              data-note-group-btn={note.id}
              data-note-menu-btn={note.id}
              title="这一篇的更多操作（分组 / 导出 / 收进档案库 / 删除）"
              onClick={(event) => {
                // ⚠️ rect 要**现在**量：菜单是 portal + fixed 定位的，靠它算位置
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                setRowMenu(menuOpenForThis ? null : { id: note.id, rect });
                setNewGroupName("");
              }}
              /*
               * 🔴 2026-10-20（用户反馈 #7）：「这个笔记侧下角的『三点水』在深色模式下
               * 黑色字体和深色背景不太匹配 —— 但**不要**给我换成白色，要一个跟深色背景协调
               * 又能看得相对清楚的颜色」。
               * 病根：这颗 ⋮ 只有 `text-slate-400`，**没有深色模式的单独取值** → 深底上灰得发闷。
               * 现在：深色下用 `slate-300`（同一色系、提一档亮度，不是纯白），
               * hover 再亮一档到 `slate-100`；浅色模式一个字没动。
               */
              className="shrink-0 rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              ⋮
            </button>
          )}
        </div>

        {menuOpenForThis && rowMenu && (
          <FloatingMenu
            anchor={rowMenu.rect}
            align="right"
            width={224}
            testId={note.id}
            onClose={() => {
              setRowMenu(null);
              setNewGroupName("");
            }}
          >
            {/* ⚠️ `data-note-group-menu` 这个抓手**必须留着** —— m8 套件靠它找菜单里的
                「新建分组」输入框与分组项。位置类 class（`absolute right-0 z-20 mt-1 w-48`）
                全部交给 `FloatingMenu` 管，这里只留"竖排内容"。 */}
            <div data-note-group-menu={note.id} className="flex flex-col">
            <p className="px-1 pb-1 text-[11px] text-slate-400">移到分组</p>
            {knownGroups.length === 0 && (
              <p className="px-1 pb-1 text-[11px] text-slate-400">（还没有别的分组）</p>
            )}
            {knownGroups.map((name) => (
              <button
                key={name}
                type="button"
                data-group-pick={name}
                onClick={() => void moveToGroup(note, name)}
                className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800 ${
                  (note.group ?? "") === name ? "text-indigo-600 dark:text-indigo-300" : ""
                }`}
              >
                {name}
              </button>
            ))}
            <div className="mt-1 flex items-center gap-1 border-t border-slate-100 pt-1 dark:border-slate-800">
              <input
                data-group-new-input
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && newGroupName.trim()) {
                    void moveToGroup(note, newGroupName.trim());
                  }
                }}
                placeholder="新建分组…"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                data-group-new-confirm
                disabled={!newGroupName.trim()}
                onClick={() => void moveToGroup(note, newGroupName.trim())}
                className="shrink-0 rounded-lg bg-indigo-600 px-2 py-1 text-xs text-white disabled:opacity-50"
              >
                建
              </button>
            </div>
            {(note.group ?? "").trim().length > 0 && (
              <button
                type="button"
                data-group-remove
                onClick={() => void moveToGroup(note, "")}
                className="mt-1 block w-full rounded-lg px-2 py-1 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
              >
                移出分组
              </button>
            )}
            {/* M27：导出这一篇（人可读的 md/txt；图片会复制到主文件旁边的 .assets/） */}
            <div className="mt-1 flex flex-col border-t border-slate-100 pt-1 dark:border-slate-800">
              <button
                type="button"
                data-note-export-md={note.id}
                onClick={() => void exportOne(note, "md")}
                className="block w-full rounded-lg px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                导出 Markdown…
              </button>
              <button
                type="button"
                data-note-export-txt={note.id}
                onClick={() => void exportOne(note, "txt")}
                className="block w-full rounded-lg px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                导出纯文本…
              </button>
            </div>
            {/* M15：收进档案库（只在启用了「档案区」时出现；收走 = 挪到档案库，随时能取出）。
                原来这颗在编辑区顶部（`DocNotePane`），2026-10-11 起**挪进行菜单**，
                跟「删除」做邻居 —— 用户反馈第 12 条的要求。 */}
            {archiveEnabled && (
              <button
                type="button"
                data-note-archive={note.id}
                onClick={() => {
                  setRowMenu(null);
                  void archiveOne("note", note.id, note.title);
                }}
                className="mt-1 block w-full rounded-lg border-t border-slate-100 px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                收进档案库
              </button>
            )}
            {/* 🔴 2026-10-11 用户反馈第 12 条：删除原来在**编辑区右上角**，他说"太难受了"，
                要求挪到"上一个反馈的小图标"（＝这个 ⋮）里。功能一个字没改（同一套
                `askDelete` → 二次确认 → `notes/_trash/`）。 */}
            <button
              type="button"
              data-note-del={note.id}
              onClick={() => {
                setRowMenu(null);
                askDelete(note);
              }}
              className="mt-1 block w-full rounded-lg border-t border-slate-100 px-2 py-1 text-left text-xs text-rose-600 hover:bg-rose-50 dark:border-slate-800 dark:text-rose-300 dark:hover:bg-rose-500/10"
            >
              删除…
            </button>
            {/* ⑬ 批量（2026-10-11 用户反馈第 13 条）：从行菜单直接进批量模式，顺手把这一篇勾上 */}
            <button
              type="button"
              data-note-batch-enter={note.id}
              onClick={() => {
                setRowMenu(null);
                setSelectMode(true);
                setSelected([note.id]);
              }}
              className="block w-full rounded-lg px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              批量选择…
            </button>
            </div>
          </FloatingMenu>
        )}
      </li>
    );
  };

  const handleCreate = async (kind: NoteKind) => {
    setMenuOpen(false);
    const created = await createNote("", kind);
    if (!created) return;
    setPickedId(created.id);
    setFreshId(created.id);
    toast(
      kind === "tree" ? "建好一篇树状图：选中节点会冒出三个图标，双击就能写字" : "建好一篇文本笔记",
      "success",
    );
  };

  const askDelete = (note: Note) => {
    askConfirm({
      title: "删除这篇笔记？",
      message: "笔记会被挪到数据目录的 notes/_trash/ 里，不是硬删，随时能手工找回来。",
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        void deleteNote(note.id).then((removed) => {
          if (!removed) {
            toast("这篇笔记已经不在了（可能刚被删过）", "info");
            return;
          }
          setPickedId(null);
          toast("已移入回收站（notes/_trash/）", "success");
        });
      },
    });
  };

  // ── ⑬ 批量选择（2026-10-11 · 用户反馈第 13 条）────────────────────────────

  /** 进出批量模式：进来时清空已选，出去时把已选也清掉（免得下次进来还勾着） */
  const toggleSelectMode = () => {
    setSelectMode((was) => !was);
    setSelected([]);
    setRowMenu(null);
  };

  const toggleSelected = (id: string) => {
    setSelected((list) => (list.includes(id) ? list.filter((one) => one !== id) : [...list, id]));
  };

  /** 全选 / 全不选（只针对**当前看得见的**那些行 —— 搜索 / 折叠之后别偷偷选上别处） */
  const toggleAllSelected = () => {
    setSelected((list) => (list.length === filtered.length ? [] : filtered.map((one) => one.id)));
  };

  /** 批量删除：**一篇一篇走同一个 `deleteNote`**（先留档 → 挪 `notes/_trash/`），不硬删 */
  const askDeleteMany = () => {
    const ids = selected;
    if (ids.length === 0) return;
    askConfirm({
      title: `删除选中的 ${ids.length} 篇笔记？`,
      message: `${ids.length} 篇都会被挪到数据目录的 notes/_trash/ 里，不是硬删。`,
      confirmText: `删除 ${ids.length} 篇`,
      danger: true,
      onConfirm: () => {
        void (async () => {
          let done = 0;
          for (const id of ids) {
            const removed = await deleteNote(id);
            if (removed) done += 1;
          }
          setPickedId((now) => (now && ids.includes(now) ? null : now));
          setSelected([]);
          setSelectMode(false);
          toast(`已把 ${done} 篇移入回收站（notes/_trash/）`, done > 0 ? "success" : "info");
        })();
      },
    });
  };

  /** 批量移到分组（空串 = 移出分组）；一篇一篇走同一个 `setNoteGroup` */
  const moveManyToGroup = (group: string) => {
    const ids = selected;
    if (ids.length === 0) return;
    void (async () => {
      let done = 0;
      for (const id of ids) {
        const saved = await setNoteGroup(id, group);
        if (saved) done += 1;
      }
      // 移进去之后把那组展开 —— 不然用户看到的是"笔记不见了"（单篇那条也这么做）
      setCollapsed((old) => (old ?? collapsedNow).filter((one) => one !== group.trim()));
      setSelected([]);
      toast(group.trim() ? `已把 ${done} 篇移到「${group.trim()}」` : `已把 ${done} 篇移出分组`, "success");
    })();
  };

  /** 批量导出（复用整区导出那条路：`notesExportDir(ids, …)`，ids = null 才是全部） */
  const exportMany = async () => {
    const ids = selected;
    if (ids.length === 0) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        title: `选一个文件夹，把选中的 ${ids.length} 篇导进去`,
        directory: true,
        multiple: false,
      });
      if (typeof dir !== "string" || !dir) return;
      const report = await notesExportDir(ids, dir, "md", true);
      toast(
        `导出 ${report.notes} 篇到 ${report.dir}${report.images ? `（连 ${report.images} 张图）` : ""}`,
        report.failed.length > 0 ? "info" : "success",
      );
      if (report.failed.length > 0) console.warn("[东方摩耶堂] 批量导出没成的：", report.failed);
    } catch (error) {
      toast("批量导出失败：" + String(error), "error");
    }
  };

  return (
    <PageShell
      title="认知区"
      subtitle="发散与收敛的交替循环"
      badge={`M4 · ${notes.length} 篇`}
    >
      <div className="flex h-full min-h-0 gap-5">
        {/* ───────── 左栏：列表 + 新建 + 搜索 ───────── */}
        {/* 宽度：`w-72`（288px）→ `w-48`（192px），**向左缩 1/3**。
            用户反馈原话："认知区，用来编辑文本的地方太小了，应该把左侧的圆角矩形再向左缩3分之1"
            —— 编辑区宽一点比列表宽一点有用得多；标题在 192px 里照样认得出（长标题本来就是截断显示）。 */}
        {/* #1（2026-10-21）：这一栏**能收起来**（用户原话「认知区，也改成这一侧可以向左折叠」）——
            照档案区 v2.22.1 同款：收起后右边编辑区吃满整幅；边缘那颗小箭头一直在，点它展开回来。
            ⚠️ 收起态**不写进 config**：每次进来都是展开的（免得他以为列表丢了）。 */}
        {listOpen ? (
          <div className="relative flex w-48 shrink-0">
          <aside className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex w-full items-center justify-between rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <span>新建笔记</span>
              <span className="text-xs opacity-80">▾</span>
            </button>

            {menuOpen && (
              <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                <button
                  type="button"
                  onClick={() => void handleCreate("doc")}
                  className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <span className="text-sm">📝 文本笔记</span>
                  <span className="text-[11px] text-slate-400">
                    Markdown + 编辑辅助栏，写 -[] 就是待办
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreate("tree")}
                  className="flex w-full flex-col items-start border-t border-slate-100 px-3 py-2 text-left hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-800"
                >
                  <span className="text-sm">🌳 树状图</span>
                  <span className="text-[11px] text-slate-400">
                    节点左右生长，三图标加子级/同级，节点还能插图片
                  </span>
                </button>
              </div>
            )}
          </div>

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题或正文…"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:focus:border-indigo-500"
          />

          {/* M27：整区导入 / 导出（人可读的 md；图片连带走）。单篇的导出在各行的 ⋮ 菜单里 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-notes-import
              onClick={() => void importNotes()}
              title="导入 Markdown / 纯文本（可多选，每个文件一篇新笔记）"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              ⬇ 导入…
            </button>
            <button
              type="button"
              data-notes-export-all
              onClick={() => void exportAll()}
              title="把认知区所有笔记导出成一个文件夹（每篇一个 .md，图片放各自的 .assets/）"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              ⬆ 全部导出…
            </button>
          </div>

          {/* ⑬ 批量选择（2026-10-11 · 用户反馈第 13 条：「删除等行为缺少批量处理的能力」）。
              推下来的做法：**只给"重列表 + 高频删除"的认知区加**（信息区下一批同款），
              进去之后整行可勾、操作条一次给全（移到分组 / 导出 / 删除）。 */}
          <button
            type="button"
            data-notes-batch
            data-notes-batch-on={selectMode ? "1" : "0"}
            onClick={toggleSelectMode}
            className={`rounded-lg border px-2 py-1.5 text-xs ${
              selectMode
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:border-indigo-500/60 dark:bg-indigo-500/15 dark:text-indigo-300"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {selectMode ? "✕ 退出批量" : "☑ 批量选择"}
          </button>

          {selectMode && (
            <div
              data-notes-batch-bar
              className="flex flex-col gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 p-2 dark:border-indigo-500/40 dark:bg-indigo-500/10"
            >
              <p className="text-xs text-indigo-700 dark:text-indigo-300">
                已选 <span data-notes-batch-count>{selected.length}</span> 篇
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  data-notes-batch-all
                  onClick={toggleAllSelected}
                  className="rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/40 dark:bg-transparent dark:text-indigo-300"
                >
                  {selected.length === filtered.length && filtered.length > 0 ? "全不选" : "全选"}
                </button>
                <button
                  type="button"
                  data-notes-batch-export
                  disabled={selected.length === 0}
                  onClick={() => void exportMany()}
                  className="rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 dark:border-indigo-500/40 dark:bg-transparent dark:text-indigo-300"
                >
                  导出…
                </button>
                <button
                  type="button"
                  data-notes-batch-del
                  disabled={selected.length === 0}
                  onClick={askDeleteMany}
                  className="rounded-lg bg-rose-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-rose-700 disabled:opacity-40"
                >
                  删除
                </button>
              </div>
              <select
                data-notes-batch-move
                value=""
                disabled={selected.length === 0}
                onChange={(event) => {
                  const picked = event.target.value;
                  if (!picked) return;
                  moveManyToGroup(picked === "__out__" ? "" : picked);
                  event.target.value = "";
                }}
                className="rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[11px] text-indigo-700 disabled:opacity-40 dark:border-indigo-500/40 dark:bg-slate-900 dark:text-indigo-300"
              >
                <option value="">移到分组…</option>
                {knownGroups.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {knownGroups.length > 0 && <option value="__out__">（移出分组）</option>}
              </select>
            </div>
          )}

          <div
            ref={listRef}
            data-note-list-scroll
            className="min-h-0 flex-1 overflow-y-auto pr-1"
            onScroll={(event) => {
              // 反馈·1022 #5：滚到哪记到哪（只在内存里，不落盘、不进 config）
              lastListScroll = event.currentTarget.scrollTop;
            }}
          >
            {notes.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-300 p-5 text-center text-xs text-slate-400 dark:border-slate-700">
                还没有笔记。也可以从信息区点「联动到认知区」自动建一篇。
              </p>
            ) : filtered.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-300 p-5 text-center text-xs text-slate-400 dark:border-slate-700">
                没有匹配「{query.trim()}」的笔记。
              </p>
            ) : searching ? (
              /*
               * ⚠️ **搜索时平铺，不按分组缩进**（M8 方案 A 定的规则）：
               * 用户搜东西时脑子里是"哪一篇"，分组结构只会把结果切碎、还要点开才看得到。
               */
              <ul data-note-list className="flex flex-col gap-2">
                {filtered.map((note) => renderRow(note))}
              </ul>
            ) : (
              <div data-note-list className="flex flex-col">
                {sections.map((section, sectionIndex) => (
                  <section
                    key={section.name || "__ungrouped"}
                    data-note-group={section.name}
                    /* D 批（2026-10-04）：**线分层** —— 组与组之间一条实线；
                       组内行与行之间的细线在下面那个 `divide-y` 上。
                       改的只是"壳"，`data-note-group` / `data-note-row` 这些钩子一个没动。 */
                    className={
                      sectionIndex > 0
                        ? "mt-3 border-t border-slate-200 pt-2 dark:border-slate-800"
                        : ""
                    }
                  >
                    <button
                      type="button"
                      data-group-toggle={section.name}
                      onClick={() => toggleGroup(section.name)}
                      className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                    >
                      <span className="text-[10px]">{isCollapsed(section.name) ? "▸" : "▾"}</span>
                      <span className="truncate">{section.name || "未分组"}</span>
                      <span className="ml-auto shrink-0 text-slate-400">{section.notes.length}</span>
                    </button>
                    {!isCollapsed(section.name) && (
                      <ul className="mt-1 flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
                        {section.notes.map((note) => renderRow(note))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            )}
          </div>
          </aside>

          {/* 收起那一栏：贴在列表右边缘、竖着居中（跟档案区同一颗） */}
          <button
            type="button"
            data-cog-list-toggle="close"
            onClick={() => setListOpen(false)}
            title="收起左边这一栏（把整幅宽度让给编辑区）"
            aria-label="收起笔记列表"
            className="absolute -right-3 top-1/2 z-10 flex h-9 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-xs text-slate-500 shadow-sm hover:bg-slate-100 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ‹
          </button>
          </div>
        ) : (
          /* 收起来之后：左边只留一条窄边，点它再展开 */
          <button
            type="button"
            data-cog-list-toggle="open"
            onClick={() => setListOpen(true)}
            title="展开左边这一栏（笔记列表）"
            aria-label="展开笔记列表"
            className="flex w-6 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-xs text-slate-500 hover:bg-slate-100 hover:text-indigo-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ›
          </button>
        )}

        {/* ───────── 右栏：编辑 / 画布 ───────── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!current ? (
            <div
              className={`${CARD} flex h-full items-center justify-center p-8 text-sm text-slate-400`}
            >
              新建一篇笔记开始写吧 —— 左上角「新建笔记 ▾」可以选文本笔记或树状图。
            </div>
          ) : current.kind === "doc" ? (
            <DocNotePane
              key={current.id}
              note={current}
              autoFocusTitle={freshId === current.id}
            />
          ) : (
            // 树状图：真画布在 features/tree/TreeNotePane（M4 换掉了原来的只读预览）
            <TreeNotePane
              key={current.id}
              note={current}
              autoFocusTitle={freshId === current.id}
            />
          )}
        </div>
      </div>
    </PageShell>
  );
}
