/**
 * 快捷小窗（M6）—— Ctrl+Space 随时唤起的**速记窗**（花笺的招牌能力）。
 *
 * # 它和主窗的关系
 * 同一个前端产物、靠**窗口 label** 分流（见 `main.tsx`）。所以这里**没有** Sidebar，
 * 自己画一条无边框窗口的标题条（`data-tauri-drag-region` 负责拖窗口）。
 *
 * # 两个 Tab
 * - **新建**：标题（可选）+ 正文 + 底部（字数 / 清空 / 保存）→ 存为 `DocNote`
 * - **打开**：搜索 + 笔记列表 → 点一条**继续编辑**（编辑区载入它，保存写回同一篇）
 *
 * # 关掉之前会把没存的存掉
 * "有未保存内容自动保存"（DEV-PLAN M6 任务 3）分两条路：
 * - **前端自己发起的关闭**（Esc / ×）：先 `await` 保存，**存完再收**（确定性强）；
 * - **Rust 发起的收起**（Ctrl+Space 按一下）：Rust 那边 `hide()` 不等前端，
 *   只广播 `small-window-hide` 让前端**尽力**保存。这个差别是有意的 ——
 *   全局热键该"一按就消失"，不该被一次磁盘写拖住。所以小窗里写的东西 **Esc 关最保险**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Toast from "../components/Toast";
import { assetImport, assetWriteImage, inTauri, smallWindowHide, smallWindowNew } from "../features/api";
import { useFileDrop } from "../features/useFileDrop";
import { formatStamp } from "../shared/daytime";
import {
  fileToBase64,
  imageFromClipboard,
  imageFromDataTransfer,
  insertMarkdownAtCaret,
} from "../shared/imageFile";
import type { Note } from "../features/types";
import { useData } from "../store/data";
import { useUi } from "../store/ui";

/** 编辑区里正在写的东西：`id === null` 表示"新建" */
interface Draft {
  id: string | null;
  title: string;
  body: string;
}

const EMPTY: Draft = { id: null, title: "", body: "" };

/**
 * 没写标题时的默认名：`未命名速记 09-21 12:30`。
 *
 * ⚠️ 别拿正文第一行当标题 —— 用户明确说过不要（见 `persist` 里的注释）。
 */
function defaultQuickTitle(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `未命名速记 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export default function SmallWindow() {
  const notes = useData((s) => s.notes);
  const refresh = useData((s) => s.refresh);
  const loadConfig = useData((s) => s.loadConfig);
  const createNote = useData((s) => s.createNote);
  const saveNote = useData((s) => s.saveNote);
  const toast = useUi((s) => s.toast);

  const [mode, setMode] = useState<"compose" | "open">("compose");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  /**
   * 草稿是不是比磁盘上的新。
   *
   * ⚠️ 必须**同时**有 state 和 ref：界面上的"未保存 · 已保存"要 state 才会重画，
   * 而 `persist` / 事件回调里要读**最新值**（它们可能是上一轮渲染的闭包），所以还得留个 ref 镜像。
   */
  const [isDirty, setIsDirty] = useState(false);
  const dirtyRef = useRef(false);
  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setIsDirty(value);
  }, []);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** `persist` 里要查"这篇笔记还在不在"；用 ref 拿最新，免得每次 notes 变都重建回调 */
  const notesRef = useRef<Note[]>(notes);
  notesRef.current = notes;
  /** 🔴 D 批补的闸门：**同一瞬间只允许一次 `persist` 在跑**（见 `persist` 里的长注释） */
  const savingRef = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // 启动：拉数据（notes 给"打开"用）+ 拉设置（主题在这一步被应用到 <html>）
  useEffect(() => {
    // ⚠️ 小窗和主窗 URL 完全一样（同一份前端产物），验收脚本要靠 CDP 的 target
    // title 才能挑中小窗 —— 但**这个 title 由 `main.tsx` 一处负责**（它按窗口 label
    // 给多开出来的窗带上号：`东方摩耶堂 · 速记` / `… · 速记 2` / `… 3`）。
    // 🔴 2026-10-20（用户反馈 #4 同一片区域）：这里原来**无条件**又写了一遍
    //    `document.title = "东方摩耶堂 · 速记"`，把 `main.tsx` 那份**带号的**覆盖掉了 →
    //    多开之后**三个窗标题一模一样**（CDP 的 target 列表里分不出来，验收脚本也没法按标题挑窗口）。
    //    ⇒ **别再在这里写 title**，单一来源留在 `main.tsx`。
    void loadConfig();
    void refresh();
  }, [loadConfig, refresh]);

  // 主窗那边改了数据也要跟上（小窗是独立 webview，事件要自己听）
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    listen("data-changed", () => void useData.getState().refresh())
      .then((fn) => {
        off = fn;
      })
      .catch(() => undefined);
    return () => off?.();
  }, []);

  /** 保存：新建就建一篇，编辑中就写回原来那篇 */
  const persist = useCallback(
    async (silent: boolean): Promise<boolean> => {
      /**
       * 🔴 **同一份草稿不许被存两遍**（2026-10-04 修的 bug）。
       *
       * 小窗收起有**两条路**都会来保存：① 页面自己的 `close()`（Esc / 点 ✕）
       * ② Rust 收起窗口时发的 `small-window-hide` 事件。两条都按"`dirtyRef` 还是脏就存"
       * 判断，而 `markDirty(false)` 要等 `createNote` 返回之后才执行 ——
       * 于是**同一瞬间两次 `persist` 同时进来时，两边都看到"还没存过、`id` 还是空"，
       * 就各建了一篇**（用户 2026-10-03 打游戏时留下的两组 `未命名速记` 就是这么来的：
       * 同一份草稿每隔 11~17 毫秒存了一篇，一模一样两篇）。
       *
       * 闸门用 **ref**（不是 state）：ref 是同步的，第二条路进来时立刻就能看到"正在存"。
       * 这里**只挡并发**，不挡"存完再存"（编辑中再点保存是正常的，那条路 `current.id` 已经有值）。
       */
      if (savingRef.current) return false;
      const current = draftRef.current;
      const body = current.body;
      /**
       * 没写标题时给一个**日期戳默认名**。
       *
       * ⚠️ **不要拿正文第一行当标题**（2026-09-21 用户反馈原话：
       * "我只是想写一段话，保存时，标题不应该也变成这段话的最上面那一行"）。
       * 速记本来就是"想到什么写什么"，第一行往往只是半句话；把它变成笔记标题
       * 既难看、又让人以为自己写了个标题。用 `未命名速记 09-21 12:30` 这种一眼能认领的名字，
       * 想改名随时在认知区改。
       */
      const title = current.title.trim() || defaultQuickTitle();

      if (!current.id && !body.trim() && !current.title.trim()) {
        if (!silent) toast("还没写东西呢");
        return false;
      }

      setSaving(true);
      savingRef.current = true;
      try {
        if (current.id) {
          const existing = notesRef.current.find((one) => one.id === current.id);
          if (!existing) throw new Error("这篇笔记已经不在了（可能刚被删掉）");
          const saved = await saveNote({ ...existing, title, content: body });
          if (!saved) throw new Error("保存没有成功");
        } else {
          // ⚠️ **一次调用带正文建出来**。原来拆成"create（空正文）→ save（写正文）"，
          //    而 create 会广播 data-changed → 认知区先看到一篇空正文的笔记，
          //    用户以为"保存后正文没了"（见 `commands::note_create` 的注释）。
          const created = await createNote(title, "doc", body);
          if (!created) throw new Error("新建笔记失败");
          // 存住之后**变成"编辑中"**：再点保存是写回同一篇，不会越存越多
          setDraft({ id: created.id, title, body });
        }
        markDirty(false);
        if (!silent) toast(current.id ? "已保存" : `已存为《${title}》`, "success");
        return true;
      } catch (error) {
        toast(`保存失败：${String(error)}`, "error");
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [createNote, markDirty, saveNote, toast],
  );

  /** 前端发起的关闭：**先把没存的存掉，存完再收** */
  const close = useCallback(async () => {
    if (dirtyRef.current) await persist(true);
    try {
      await smallWindowHide();
    } catch (error) {
      toast(`收起小窗失败：${String(error)}`, "error");
    }
  }, [persist, toast]);

  // Esc 关闭（DEV-PLAN M6 任务 3）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Rust 发起的收起：尽力保存（不等它）
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    listen("small-window-hide", () => {
      if (dirtyRef.current) void persist(true);
    })
      .then((fn) => {
        off = fn;
      })
      .catch(() => undefined);
    return () => off?.();
  }, [persist]);

  // 被唤出来时：**该空白就空白**，然后把光标放进正文（"一按就能写"）
  //
  // ⚠️ 2026-09-21 用户反馈："启动小窗后还是我上次打开小窗编辑的笔记，没有一个新的空白页面给我写"。
  //    所以规则定成：
  //    - **有未保存的草稿 → 原样留着**（一个字都不许丢，这是底线）；
  //    - **没有未保存的东西 → 给一张白纸**（上次存过的笔记在认知区待着，想接着改去【打开】里点）。
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    listen("small-window-shown", () => {
      if (!dirtyRef.current) {
        setDraft(EMPTY);
        setMode("compose");
      }
      bodyRef.current?.focus();
    })
      .then((fn) => {
        off = fn;
      })
      .catch(() => undefined);
    return () => off?.();
  }, []);

  /** 新建：先保住手上这份，再清空 */
  const startFresh = () => {
    if (dirtyRef.current) void persist(true);
    setDraft(EMPTY);
    markDirty(false);
    setMode("compose");
    bodyRef.current?.focus();
  };

  /** 把 `![](assets/…)` 插到光标处（粘图/拖图共用） */
  const insertMarkdown = useCallback(
    (markdown: string) => {
      const el = bodyRef.current;
      const caret = el && el.selectionStart !== null ? el.selectionStart : null;
      const next = insertMarkdownAtCaret(draftRef.current.body, markdown, caret);
      markDirty(true);
      setDraft((old) => ({ ...old, body: next.body }));
      // 光标挪到插入内容之后（不然接着打字会打在图片前面）
      window.requestAnimationFrame(() => {
        if (el) {
          el.selectionStart = next.caret;
          el.selectionEnd = next.caret;
          el.focus();
        }
      });
    },
    [markDirty],
  );

  /**
   * **粘贴 / 拖入图片**（2026-09-21 用户反馈："图片拖入和粘贴都不可行"）。
   *
   * 两条路都接：
   * - **粘贴**（Ctrl+V）：剪贴板给的是**字节**，走 `asset_write_image`（后端按魔数认格式）；
   * - **拖入**（从资源管理器拖文件进来）：走 `useFileDrop`（Tauri 的原生拖放事件），
   *   它给的是**真实文件路径**，走 `asset_import` 直接复制进 `assets/`。
   *
   * ⚠️ 拖入**不能**用 HTML5 的 `onDrop`：Tauri 窗口默认 `dragDropEnabled: true`，
   *    系统拖放被 Tauri 接管，页面里的 `onDrop` **永远收不到** —— 而合成事件测试照样会过
   *    （合成事件直接派发到元素上，绕过了系统那一层），于是"验过了但真手拖不行"。
   *    用户实测"拖动图片进入小窗依然无法显示"就是这个原因。
   *
   * 剪贴板里是文字时**不抢**，走系统默认粘贴。
   */
  const attachImage = useCallback(
    async (file: File) => {
      try {
        const rel = await assetWriteImage(await fileToBase64(file));
        insertMarkdown(`![](${rel})`);
        toast("图片已插进正文", "success");
      } catch (error) {
        toast(`图片没能插进来：${String(error)}`, "error");
      }
    },
    [insertMarkdown, toast],
  );

  /** 从资源管理器拖进来的**文件路径**（Tauri 拖放事件给的，不是字节） */
  const attachImagePaths = useCallback(
    async (paths: string[]) => {
      try {
        const rels: string[] = [];
        for (const path of paths) rels.push(await assetImport(path));
        insertMarkdown(rels.map((rel) => `![](${rel})`).join("\n"));
        toast(rels.length > 1 ? `拖进来 ${rels.length} 张图` : "图片已插进正文", "success");
      } catch (error) {
        toast(`拖进来的图片没能插进来：${String(error)}`, "error");
      }
    },
    [insertMarkdown, toast],
  );

  // ★ 真手拖走这条（Tauri 原生拖放）；HTML5 的 onDrop 留着当兜底
  useFileDrop({ onImages: (paths) => void attachImagePaths(paths) });

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const file = imageFromClipboard(event);
      if (!file) return; // 文字就交给浏览器默认粘贴
      event.preventDefault();
      void attachImage(file);
    },
    [attachImage],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      const file = imageFromDataTransfer(event);
      if (!file) return;
      event.preventDefault();
      void attachImage(file);
    },
    [attachImage],
  );

  /** 打开列表：小窗只编辑**文本笔记**（树状图没有 Markdown 正文，在这儿编辑会误导） */
  const docs = useMemo(() => notes.filter((one) => one.kind === "doc"), [notes]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return docs;
    return docs.filter(
      (one) =>
        one.title.toLowerCase().includes(keyword) ||
        (one.content ?? "").toLowerCase().includes(keyword),
    );
  }, [docs, query]);

  /** 点列表里的一条 → 载入编辑区继续编辑 */
  const openNote = (id: string) => {
    const note = docs.find((one) => one.id === id);
    if (!note) return;
    setDraft({ id: note.id, title: note.title, body: note.content ?? "" });
    markDirty(false);
    setMode("compose");
    bodyRef.current?.focus();
  };

  return (
    <div className="flex h-full flex-col bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      {/* 标题条：无边框窗口靠它拖（data-tauri-drag-region），右侧是 × */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800"
      >
        <span data-tauri-drag-region className="text-xs text-slate-400">
          ⠿
        </span>
        <span data-tauri-drag-region className="text-xs font-medium">
          速记
        </span>
        {draft.id && (
          <span data-small-editing className="truncate text-[11px] text-indigo-500">
            编辑中：《{draft.title || "未命名笔记"}》
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-small-tab="compose"
            onClick={() => setMode("compose")}
            className={`rounded px-2 py-0.5 text-[11px] ${
              mode === "compose"
                ? "bg-indigo-600 text-white"
                : "text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
          >
            新建
          </button>
          <button
            type="button"
            data-small-tab="open"
            onClick={() => setMode("open")}
            className={`rounded px-2 py-0.5 text-[11px] ${
              mode === "open"
                ? "bg-indigo-600 text-white"
                : "text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
          >
            打开
          </button>
          {/* ⑥ 2026-10-11（v2.21.0 · 用户反馈第 6 条）：用户原话「电脑版，发现快捷小窗无法多开……
              再次点按，居然就把这小窗给删了」＋「想同时开好几个」→ 这里给一个**再开一个**的门。
              ⚠️ 它跟旁边那颗「＋」不是一回事：那颗是"把当前这个清空重写"，这颗是"再来一个窗"。
              F9 / Ctrl+Space 的老语义没动（只收/放 1 号窗）。 */}
          <button
            type="button"
            data-small-clone
            title="再开一个速记窗（可以同时开好几个，最多 5 个）"
            onClick={() => {
              void smallWindowNew()
                .then((label) => {
                  if (label) toast(`又开了一个速记窗（${label}）`, "success");
                })
                .catch((error) => toast(`再开一个没成：${String(error)}`, "error"));
            }}
            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            ⧉
          </button>
          <button
            type="button"
            data-small-new
            title="清空，写新的一条"
            onClick={startFresh}
            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            ＋
          </button>
          <button
            type="button"
            data-small-close
            title="收起（Esc）—— 收之前会把没存的存掉"
            onClick={() => void close()}
            className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-rose-100 hover:text-rose-600 dark:text-slate-300 dark:hover:bg-rose-500/20 dark:hover:text-rose-300"
          >
            ✕
          </button>
        </div>
      </header>

      {mode === "open" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-3 py-2">
            <input
              autoFocus
              data-small-search
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜标题或正文…"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:bg-slate-900"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-400">
                {docs.length === 0 ? "还没有文本笔记" : "没找到匹配的笔记"}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {filtered.slice(0, 50).map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      data-small-note={note.id}
                      onClick={() => openNote(note.id)}
                      className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <p className="truncate text-xs font-medium">{note.title}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                        <span className="truncate">
                          {(note.content ?? "").replace(/\s+/g, " ").slice(0, 40) || "（空）"}
                        </span>
                        <span className="ml-auto shrink-0">{formatStamp(note.updatedAt)}</span>
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <input
            data-small-title
            value={draft.title}
            onChange={(event) => {
              markDirty(true);
              setDraft((old) => ({ ...old, title: event.target.value }));
            }}
            placeholder="标题（可以不写）"
            className="shrink-0 border-b border-slate-100 bg-transparent px-3 py-2 text-sm font-medium outline-none placeholder:text-slate-400 dark:border-slate-800"
          />
          <textarea
            ref={bodyRef}
            autoFocus
            data-small-body
            value={draft.body}
            onChange={(event) => {
              markDirty(true);
              setDraft((old) => ({ ...old, body: event.target.value }));
            }}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(event) => {
              // 不 preventDefault 的话浏览器会当作"导航到文件"把整个页面换掉
              if (imageFromDataTransfer(event)) event.preventDefault();
            }}
            placeholder="想到什么先写下来…（-[]文字 在执行区会变成待办；图片可以直接粘/拖进来）"
            className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-slate-400"
          />
          <footer className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-700">
            <span data-small-status className="text-[11px] text-slate-400">
              {draft.body.length} 字 · {isDirty ? "未保存" : "已保存"}
            </span>
            <button
              type="button"
              data-small-clear
              onClick={() => {
                markDirty(true);
                setDraft({ id: null, title: "", body: "" });
              }}
              className="ml-auto rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              清空
            </button>
            <button
              type="button"
              data-small-save
              disabled={saving}
              onClick={() => void persist(false)}
              className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </footer>
        </div>
      )}

      <Toast />
    </div>
  );
}
