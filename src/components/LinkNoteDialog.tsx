import { useState } from "react";
import Modal from "./Modal";
import type { Note, NoteKind } from "../features/types";

interface LinkNoteDialogProps {
  /** 用来给"新建笔记"想一个默认标题 */
  defaultTitle: string;
  notes: Note[];
  onCancel: () => void;
  onConfirm: (options: { noteId?: string; noteTitle?: string; noteKind?: NoteKind }) => void;
}

/** 联动 A：把信息送到认知区 —— 可以**新建**笔记，也可以**选已有**笔记（PRD 5.1 联动） */
export default function LinkNoteDialog({
  defaultTitle,
  notes,
  onCancel,
  onConfirm,
}: LinkNoteDialogProps) {
  const docNotes = notes;
  // 默认**新建**、而且不预先选中任何一篇（2026-09-20 改）：
  // 原来默认「选已有笔记」并预选第一篇，用户点两下就把信息塞进了某篇不相干的笔记里
  // —— 联动会往那篇笔记里写内容，事后很难摘干净。默认新建最坏也只是多出一篇新笔记。
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [title, setTitle] = useState(defaultTitle);
  const [kind, setKind] = useState<NoteKind>("doc");
  const [picked, setPicked] = useState<string>("");

  const canSubmit = mode === "new" ? true : picked.length > 0;

  const submit = () => {
    if (mode === "new") {
      onConfirm({ noteTitle: title.trim() || defaultTitle, noteKind: kind });
    } else {
      onConfirm({ noteId: picked });
    }
  };

  return (
    <Modal
      title="联动到认知区"
      onClose={onCancel}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            联动
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="inline-flex self-start rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {(
            [
              { key: "existing", label: "选已有笔记" },
              { key: "new", label: "新建笔记" },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setMode(option.key)}
              disabled={option.key === "existing" && docNotes.length === 0}
              className={`rounded-lg px-4 py-1.5 text-sm transition-colors disabled:opacity-40 ${
                mode === option.key
                  ? "bg-white font-medium text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {mode === "new" ? (
          <div className="flex flex-col gap-3">
            <label className="text-xs text-slate-500 dark:text-slate-400">
              笔记标题
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
              />
            </label>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              笔记类型
              <div className="mt-1 flex gap-2">
                {(
                  [
                    { key: "doc", label: "📝 文本编辑器" },
                    { key: "tree", label: "🌳 树状图" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setKind(option.key)}
                    className={`rounded-xl border px-3 py-1.5 text-sm transition-colors ${
                      kind === option.key
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-500/15 dark:text-indigo-300"
                        : "border-slate-200 text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:text-slate-400"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              联动会往选中的笔记里写内容，选错了事后不好摘 —— 所以这里不预先替你选。
            </p>
            <ul className="flex flex-col gap-2">
              {docNotes.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(note.id)}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                      picked === note.id
                        ? "border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-500/15"
                        : "border-slate-200 hover:border-slate-300 dark:border-slate-700"
                    }`}
                  >
                    <span>{note.kind === "tree" ? "🌳" : "📝"}</span>
                    <span className="min-w-0 flex-1 truncate">{note.title}</span>
                    {note.sourceInfoIds.length > 0 && (
                      <span className="shrink-0 text-xs text-slate-400">
                        已含 {note.sourceInfoIds.length} 条联动
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
