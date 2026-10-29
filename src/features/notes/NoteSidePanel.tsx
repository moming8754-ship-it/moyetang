/**
 * 认知区右侧那条边栏（M14）—— 两个页签：**目录**（A）与**批注**（B）。
 *
 * # 目录（M14-A）
 * 从正文里扫 `toc第二章`（规则见 `toc.ts`）→ 列出来；点一条就滚到那一行。
 * 🔴 **正文一个字都不改**：这里只读，条目是算出来的。
 *
 * # 批注（M14-B）
 * 每条批注锚在**一句话**上（锚点四件套见 `annotations.ts`）；
 * 🔴 用户 2026-09-26 定：**批注栏是"档案区"的东西**，所以这个页签只在
 *    **设置 →「启用档案区」开着**的时候才出现（M15 做档案库入口时接同一个开关）。
 *
 * # 为什么写数据的活儿在这一层
 * 小窗那边（`FocusWindow`）发意图、主窗落盘 —— 这里就是"主窗"这一侧，
 * 所以 `anno_*` 命令由这里直接调，改完顺手 `refresh`。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { annoCreate, annoDelete, annoList, annoSet } from "../api";
import { useUi } from "../../store/ui";
import type { Annotation, Note } from "../types";
import {
  makeAnchor,
  resolveAnchor,
  sentenceAt,
  splitSentences,
} from "./annotations";
import { scanToc } from "./toc";
import TocList from "./TocList";

interface NoteSidePanelProps {
  note: Note;
  content: string;
  /** 设置里「启用档案区」开着吗（关着就不显示批注页签） */
  archiveEnabled: boolean;
  /** 光标现在在第几个字符（新建批注要锚到"光标那句"） */
  cursorOffset: () => number;
  /** 跳到第 N 行（目录点击 / 点批注卡片都走它） */
  onJumpToLine: (line: number) => void;
}

export default function NoteSidePanel({
  note,
  content,
  archiveEnabled,
  cursorOffset,
  onJumpToLine,
}: NoteSidePanelProps) {
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<"toc" | "anno">("toc");
  const [items, setItems] = useState<Annotation[]>([]);
  /** 正在写的那条（null = 没在写） */
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** 目录里高亮哪一条（点过的那个；点完滚过去） */
  const [activeLine, setActiveLine] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!archiveEnabled) {
      setItems([]);
      return;
    }
    void (async () => {
      try {
        const all = await annoList();
        if (!cancelled) setItems(all.filter((one) => one.noteId === note.id));
      } catch (error) {
        console.error("[东方摩耶堂] 读取批注失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [archiveEnabled, note.id]);

  // 关掉开关时页签也没了 → 把 tab 拉回目录，不然会停在一个不存在的页上
  useEffect(() => {
    if (!archiveEnabled && tab === "anno") setTab("toc");
  }, [archiveEnabled, tab]);

  const toc = useMemo(() => scanToc(content), [content]);
  const sentences = useMemo(() => splitSentences(content), [content]);

  /** 每条批注现在钉在哪一行（算给你看，也顺手把"孤儿"标出来） */
  const placed = useMemo(
    () =>
      items.map((one) => ({
        anno: one,
        hit: resolveAnchor(content, {
          quote: one.quote,
          prefix: one.prefix,
          suffix: one.suffix,
          hash: one.hash,
        }),
      })),
    [items, content],
  );

  const jump = (line: number) => {
    setActiveLine(line);
    onJumpToLine(line);
  };

  const startDraft = useCallback(() => {
    const sentence = sentenceAt(content, cursorOffset());
    if (!sentence) {
      toast("先把光标放到要批注的那句话上", "error");
      return;
    }
    setDraft("");
    setTab("anno");
    // 记下要锚的那句，提交时现算（免得用户又改了正文）
    setEditing(null);
    setDraftTarget(sentence.from);
  }, [content, cursorOffset, toast]);

  /** 要锚的那一句在正文里的起点（点「＋」那一刻记下来） */
  const [draftTarget, setDraftTarget] = useState<number | null>(null);

  const submitDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    const sentence =
      draftTarget === null ? null : sentenceAt(content, draftTarget);
    if (!sentence) {
      toast("那句话已经找不到了（正文改过了？）", "error");
      return;
    }
    const anchor = makeAnchor(content, sentence);
    try {
      const created = await annoCreate(
        note.id,
        anchor.quote,
        anchor.prefix,
        anchor.suffix,
        anchor.hash,
        text,
      );
      setItems((all) => [...all, created]);
      setDraft("");
      setDraftTarget(null);
      toast("批注写好了", "success");
    } catch (error) {
      toast(`批注没存上：${String(error)}`, "error");
    }
  };

  const saveEdit = async (id: string) => {
    const text = editText.trim();
    if (!text) return;
    try {
      const updated = await annoSet(id, text);
      setItems((all) => all.map((one) => (one.id === id ? updated : one)));
      setEditing(null);
    } catch (error) {
      toast(`批注没改成：${String(error)}`, "error");
    }
  };

  const removeOne = async (id: string) => {
    try {
      await annoDelete(id);
      setItems((all) => all.filter((one) => one.id !== id));
    } catch (error) {
      toast(`批注没删掉：${String(error)}`, "error");
    }
  };

  return (
    <aside
      data-note-side
      className="flex w-[196px] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex shrink-0 items-stretch border-b border-slate-200 text-xs dark:border-slate-800">
        <button
          type="button"
          data-side-tab="toc"
          onClick={() => setTab("toc")}
          className={`flex-1 px-2 py-1.5 ${
            tab === "toc"
              ? "bg-slate-50 font-medium text-indigo-600 dark:bg-slate-800 dark:text-indigo-300"
              : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800"
          }`}
        >
          目录{toc.length > 0 ? ` ${toc.length}` : ""}
        </button>
        {archiveEnabled && (
          <button
            type="button"
            data-side-tab="anno"
            onClick={() => setTab("anno")}
            className={`flex-1 px-2 py-1.5 ${
              tab === "anno"
                ? "bg-slate-50 font-medium text-indigo-600 dark:bg-slate-800 dark:text-indigo-300"
                : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800"
            }`}
          >
            批注{items.length > 0 ? ` ${items.length}` : ""}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-xs">
        {tab === "toc" ? (
          /* 🔴 2026-10-11（P3 档案区返工那轮）：目录列表抽成公共件 `TocList.tsx`
             —— 认知区这条边栏、档案区的「目录」页签、手机档案区的弹出目录**共用一份**。
             抓手 `data-toc-item` / `data-toc-line` / `data-toc-empty` 一个字没改（m14 正盯着）。 */
          <TocList
            entries={toc}
            activeLine={activeLine}
            onJump={jump}
            empty={
              <p data-toc-empty className="px-1 leading-relaxed text-slate-400">
                还没有目录。
                <br />
                在行首写 <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">toc第二章</code>
                就会出现在这里（点一下就跳过去）。
              </p>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              data-anno-add
              onClick={startDraft}
              className="rounded-lg border border-dashed border-slate-300 px-2 py-1 text-left text-slate-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-400"
            >
              ＋ 给光标那一句写批注
            </button>

            {draftTarget !== null && (
              <div data-anno-draft className="rounded-lg border border-indigo-300 p-1.5 dark:border-indigo-500">
                <div className="mb-1 line-clamp-2 border-l-2 border-slate-300 pl-1.5 text-[11px] text-slate-500 dark:border-slate-600 dark:text-slate-400">
                  {sentenceAt(content, draftTarget)?.text ?? "（那句话找不到了）"}
                </div>
                <textarea
                  data-anno-input
                  autoFocus
                  rows={2}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="写点什么…"
                  className="w-full resize-none rounded border border-slate-200 bg-transparent px-1.5 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:text-slate-100"
                />
                <div className="mt-1 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDraftTarget(null)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    data-anno-save
                    onClick={() => void submitDraft()}
                    className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] text-white hover:bg-indigo-700"
                  >
                    存下
                  </button>
                </div>
              </div>
            )}

            {placed.length === 0 && draftTarget === null && (
              <p data-anno-empty className="px-1 leading-relaxed text-slate-400">
                还没有批注。把光标放到正文某一句上，点上面的「＋」。
              </p>
            )}

            {placed.map(({ anno, hit }) => (
              <div
                key={anno.id}
                data-anno-card={anno.id}
                data-anno-kind={hit.kind}
                className={`rounded-lg border p-1.5 ${
                  hit.kind === "orphan"
                    ? "border-amber-400/70 dark:border-amber-500/50"
                    : "border-slate-200 dark:border-slate-700"
                }`}
              >
                <button
                  type="button"
                  data-anno-quote={anno.id}
                  onClick={() => hit.kind !== "orphan" && jump(hit.line)}
                  className="mb-1 block w-full border-l-2 border-slate-300 pl-1.5 text-left text-[11px] text-slate-500 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-400"
                  title={hit.kind === "orphan" ? "原句已改，跳不过去" : "点一下跳过去"}
                >
                  「{anno.quote}」
                </button>
                {hit.kind === "orphan" && (
                  <p data-anno-orphan={anno.id} className="mb-1 text-[10.5px] text-amber-600 dark:text-amber-400">
                    ⚠ 原文已改 / 找不到了（原话还在上面）
                  </p>
                )}
                {editing === anno.id ? (
                  <>
                    <textarea
                      data-anno-edit={anno.id}
                      autoFocus
                      rows={2}
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      className="w-full resize-none rounded border border-slate-200 bg-transparent px-1.5 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:text-slate-100"
                    />
                    <div className="mt-1 flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        data-anno-edit-save={anno.id}
                        onClick={() => void saveEdit(anno.id)}
                        className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] text-white hover:bg-indigo-700"
                      >
                        存下
                      </button>
                    </div>
                  </>
                ) : (
                  <p
                    data-anno-text={anno.id}
                    onClick={() => {
                      setEditing(anno.id);
                      setEditText(anno.text);
                    }}
                    className="cursor-text whitespace-pre-wrap text-slate-700 dark:text-slate-200"
                  >
                    {anno.text}
                  </p>
                )}
                {editing !== anno.id && (
                  <button
                    type="button"
                    data-anno-del={anno.id}
                    onClick={() => void removeOne(anno.id)}
                    className="mt-1 text-[10.5px] text-slate-400 hover:text-rose-500"
                  >
                    删掉
                  </button>
                )}
              </div>
            ))}

            {sentences.length === 0 && (
              <p className="px-1 text-[11px] text-slate-400">正文还是空的，没句子可批注。</p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
