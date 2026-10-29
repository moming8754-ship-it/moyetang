import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import PageShell from "../components/PageShell";
import CategoryPicker from "../components/CategoryPicker";
import ImageViewer from "../components/ImageViewer";
import LinkNoteDialog from "../components/LinkNoteDialog";
import { useData } from "../store/data";
import { useUi } from "../store/ui";
import { inTauri } from "../features/api";
import { AssetImage } from "../components/AssetImage";
import { formatStamp } from "../shared/daytime";
import { imageFromClipboard } from "../shared/imageFile";
import { CATEGORY_GROUPS, categoryGroupOf, categoryLeafOf, titleFromText } from "../features/types";
import type { Info, InfoStatus, Link } from "../features/types";

const CARD =
  "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const CHIP =
  "rounded-full border px-3 py-1 text-xs transition-colors";

/** 图片缩略图（点击看大图）；地址要等后端换算成 asset URL */
function Thumbnail({ relPath, onOpen }: { relPath: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="点击看大图"
      className="shrink-0 overflow-hidden rounded-xl ring-1 ring-slate-200 transition-transform hover:scale-[1.02] dark:ring-slate-700"
    >
      <AssetImage
        relPath={relPath}
        compact
        loading={
          <span className="flex h-24 w-24 items-center justify-center bg-slate-100 text-xs text-slate-400 dark:bg-slate-800">
            载入中
          </span>
        }
        imgProps={{ draggable: false, className: "h-24 w-24 object-cover" }}
      />
    </button>
  );
}

export default function InfoPage() {
  const infos = useData((s) => s.infos);
  const notes = useData((s) => s.notes);
  const ready = useData((s) => s.ready);
  const loading = useData((s) => s.loading);
  const createInfo = useData((s) => s.createInfo);
  const createImageInfos = useData((s) => s.createImageInfos);
  const pasteImageInfo = useData((s) => s.pasteImageInfo);
  const updateInfo = useData((s) => s.updateInfo);
  const deleteInfo = useData((s) => s.deleteInfo);
  /** M15：收进档案库（+ 是否启用了档案区，没启用就不显示这个入口） */
  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：`archiveOne` / `archiveEnabled` 原来在这儿
  //    （信息卡那颗「收进档案库」用的）—— 那颗按用户要求去掉了，所以这两个也不用了。
  const linkToNote = useData((s) => s.linkToNote);
  const linkToTodo = useData((s) => s.linkToTodo);
  const setFocusRef = useData((s) => s.setFocusRef);
  const focusRef = useData((s) => s.focusRef);
  const askConfirm = useUi((s) => s.askConfirm);
  const setView = useUi((s) => s.setView);
  const toast = useUi((s) => s.toast);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [categoryTarget, setCategoryTarget] = useState<Info | null>(null);
  const [linkTarget, setLinkTarget] = useState<Info | null>(null);

  // 搜索 + 筛选（PRD 5.1）：文字 / 状态 / 信息分类（一级）
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | InfoStatus>("all");
  const [groupFilter, setGroupFilter] = useState<string>("");
  /** 从认知区点「去信息区 →」跳过来时，短暂高亮那一条 */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // 认知区 → 信息区 的反向跳转（M3-5）：
  // 先把筛选清干净（否则那条可能被筛掉、看不见），再滚到它并高亮两秒多。
  useEffect(() => {
    if (focusRef?.kind !== "info") return;
    const target = focusRef.id;
    setQuery("");
    setStatusFilter("all");
    setGroupFilter("");
    setHighlightId(target);
    setFocusRef(null);

    // 等筛选清完、列表重画之后再滚
    const scrollTimer = window.setTimeout(() => {
      document
        .getElementById(`info-${target}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    const clearTimer = window.setTimeout(() => {
      setHighlightId((current) => (current === target ? null : current));
    }, 2800);

    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [focusRef, setFocusRef]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return infos.filter((info) => {
      if (statusFilter !== "all" && info.status !== statusFilter) return false;
      if (groupFilter && !info.categories.some((one) => categoryGroupOf(one) === groupFilter)) {
        return false;
      }
      if (keyword && !info.text.toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [infos, query, statusFilter, groupFilter]);

  // 拖入图片（PRD 5.1 必要操作 1）：走 Tauri 的原生拖放事件拿真实文件路径
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          setDragging(true);
        } else if (payload.type === "drop") {
          setDragging(false);
          if (payload.paths.length > 0) void createImageInfos(payload.paths);
        } else {
          setDragging(false);
        }
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
  }, [createImageInfos]);

  /** 打开大图（Esc / 适应宽度切换都在 {@link ImageViewer} 里） */
  const openLightbox = (path: string) => setLightbox(path);

  /**
   * 粘贴图片（2026-10-02 用户反馈："信息区图片无法粘贴"）。
   *
   * 用户点头定的两条：
   * 1. **信息区页面内，哪儿按 Ctrl+V 都行**（不用先把鼠标挪到那个虚线框上）；
   * 2. 剪贴板里同时有文字时，文字当这条图片信息的**备注**存下来（不塞进录入框）。
   *
   * ⚠️ 三处"别抢"的边界（都在下面代码里）：
   * - 不是 Tauri 环境（浏览器里跑）→ 不接管；
   * - 剪贴板里没有图（普通贴文字）→ 一个字都不动，照旧走浏览器默认粘贴；
   * - 焦点在**搜索框**里 → 完全不接管（在那儿贴图是手滑）；焦点在录入框里 → 只在剪贴板有图时
   *   接管（拦掉默认行为，免得往正文里塞一段没用的 `[图片]`），文字仍然留在录入框里自己打。
   */
  useEffect(() => {
    if (!inTauri()) return;

    /** 焦点是不是在那个「随手记」录入框里 */
    const focusInCompose = (): boolean => {
      const active = document.activeElement;
      return active?.tagName === "TEXTAREA";
    };

    const onPaste = (event: ClipboardEvent) => {
      const file = imageFromClipboard(event);
      if (!file) return; // 没有图 → 交给浏览器自己处理

      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT") return; // 搜索框：不抢

      const typed = focusInCompose();
      event.preventDefault(); // 有图：别让浏览器再插一段没用的文字
      const text = typed ? "" : event.clipboardData?.getData("text/plain") ?? "";
      void pasteImageInfo(file, text);
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [pasteImageInfo]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const ok = await createInfo(draft);
      if (ok) setDraft("");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⚠️ isComposing：中文输入法里"回车选字"也是 Enter，不能当成保存
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void save();
  };

  const confirmDelete = (info: Info) => {
    askConfirm({
      title: "删除这条信息？",
      message: `「${titleFromText(info.text || info.assetPath || "图片", 16)}」删除后界面上不再显示；数据目录里的 info.jsonl.bak 仍保留删除前的整份内容。`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        void deleteInfo(info.id);
      },
    });
  };

  const jumpTo = (link: Link) => {
    setFocusRef({ kind: link.targetKind === "note" ? "note" : "todo", id: link.targetId });
    setView(link.targetKind === "note" ? "cognition" : "todo");
    toast(`去${link.targetKind === "note" ? "认知区" : "执行区"}：${link.titleSnapshot}`, "info");
  };

  const hasFilter = query.trim().length > 0 || statusFilter !== "all" || groupFilter !== "";

  return (
    <PageShell
      title="信息区"
      subtitle="扑面而来，真假难辨"
      badge={`M2 · ${infos.length} 条`}
    >
      <div className="flex max-w-4xl flex-col gap-4">
        {/* 搜索 + 筛选 */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索信息文字…"
            className="min-w-56 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />

          <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
            {(
              [
                { key: "all", label: "全部" },
                { key: "pending", label: "待联动" },
                { key: "linked", label: "已联动" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setStatusFilter(option.key)}
                className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                  statusFilter === option.key
                    ? "bg-white font-medium text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <select
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            <option value="">所有分类</option>
            {CATEGORY_GROUPS.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>

          {hasFilter && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
                setGroupFilter("");
              }}
              className="rounded-xl px-3 py-2 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              清空筛选
            </button>
          )}
        </div>

        {/* 录入框（回车即存；可把图片拖进来） */}
        <section
          className={`${CARD} transition-colors ${
            dragging ? "border-indigo-400 bg-indigo-50/60 dark:bg-indigo-500/10" : ""
          }`}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="随手记一条…（回车保存，Shift+回车换行；也可以直接把图片拖进来）"
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-400 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">
              {dragging
                ? "松手即可把图片存进 assets/"
                : saving
                  ? "保存中…"
                  : "回车即存 · 写入 info.jsonl，每次保存都留一份上一版 .bak"}
            </span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || draft.trim().length === 0}
              className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </section>

        {/* 列表 */}
        {ready && infos.length === 0 && (
          <p className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
            还没有信息。想到什么就先丢进来，之后决定怎么用；图片直接拖进来就行。
          </p>
        )}

        {infos.length > 0 && filtered.length === 0 && (
          <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
            当前筛选下没有信息。
          </p>
        )}

        {filtered.length > 0 && (
          /* D 批（2026-10-04）：**线分层** —— 原来每条信息各包一张 `CARD` 圆角框，
             十条就是十个框，眼睛没有落点。改成"行 + 行间细线"（`divide-y`），
             状态（待联动/已联动）仍旧用小标签表达。
             ⚠️ `id={"info-..."}`（跳转定位用）和行内钩子原样保留。 */
          <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((info) => (
              <li
                key={info.id}
                id={`info-${info.id}`}
                className={`group border-l-2 px-2 py-3 transition-colors ${
                  highlightId === info.id
                    ? "border-l-indigo-400 bg-indigo-50/70 dark:bg-indigo-500/10"
                    : "border-l-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50"
                }`}
              >
                <div className="flex items-start gap-3">
                  {info.assetPath && (
                    <Thumbnail relPath={info.assetPath} onOpen={() => openLightbox(info.assetPath!)} />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {info.text || (info.assetPath ? "" : "（无文字）")}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span title={info.createdAt}>{formatStamp(info.createdAt)}</span>
                      <span
                        className={
                          info.status === "linked"
                            ? "rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : "rounded-full bg-amber-50 px-2 py-0.5 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                        }
                      >
                        {info.status === "linked" ? "已联动" : "待联动"}
                      </span>
                      {info.categories.map((category) => (
                        <span
                          key={category}
                          title={category}
                          className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800"
                        >
                          {categoryGroupOf(category)}·{categoryLeafOf(category)}
                        </span>
                      ))}
                      {info.links.map((link) => (
                        <button
                          key={`${link.targetKind}-${link.targetId}`}
                          type="button"
                          onClick={() => jumpTo(link)}
                          className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                        >
                          → {link.targetKind === "note" ? "认知区" : "待办"}《
                          {link.titleSnapshot}》
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 opacity-70 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => setCategoryTarget(info)}
                        className={`${CHIP} border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200`}
                      >
                        分类（{info.categories.length}）
                      </button>
                      <button
                        type="button"
                        onClick={() => setLinkTarget(info)}
                        className={`${CHIP} border-indigo-200 text-indigo-600 hover:bg-indigo-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-500/10`}
                      >
                        联动到认知区
                      </button>
                      <button
                        type="button"
                        onClick={() => void linkToTodo(info.id)}
                        className={`${CHIP} border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10`}
                      >
                        建为待办
                      </button>
                      {/* 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：信息卡上的「收进档案库」
                          **按用户要求去掉了**。他原话：「最难绷反而是信息区，没什么关系但是却有
                          导入档案区的选项」（认知区该有的没有、信息区不该有的倒有）。
                          现在档案区的入口只剩两处：**认知区笔记**（列表行菜单）＋ 档案库自己的
                          「＋ 新建」。要收东西进档案，去认知区那一行点 ⋮。 */}
                      <button
                        type="button"
                        onClick={() => confirmDelete(info)}
                        className={`${CHIP} border-transparent text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/30 dark:hover:text-rose-400`}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {loading && <p className="pb-2 text-center text-xs text-slate-400">读取中…</p>}
      </div>

      {/* 看大图（公共组件，与树状图节点共用；M3 反馈后改成"按宽度铺满 + 可滚动"，
          原来的 max-h-full 会把 1080×2400 的手机长截图压成一条窄缝，字全糊） */}
      <ImageViewer relPath={lightbox} onClose={() => setLightbox(null)} />

      {/* 分类选择 */}
      {categoryTarget && (
        <CategoryPicker
          value={categoryTarget.categories}
          onCancel={() => setCategoryTarget(null)}
          onSave={(values) => {
            const target = categoryTarget;
            setCategoryTarget(null);
            void updateInfo({ ...target, categories: values }, "分类已保存");
          }}
        />
      )}

      {/* 联动选笔记 */}
      {linkTarget && (
        <LinkNoteDialog
          defaultTitle={titleFromText(linkTarget.text || "图片信息", 20)}
          notes={notes}
          onCancel={() => setLinkTarget(null)}
          onConfirm={(options) => {
            const target = linkTarget;
            setLinkTarget(null);
            void linkToNote(target.id, options);
          }}
        />
      )}
    </PageShell>
  );
}
