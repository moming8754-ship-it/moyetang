/**
 * 目录列表 —— 从认知区右侧边栏里**抽出来的公共件**（2026-10-11 · P3 档案区返工那轮）。
 *
 * # 为什么要抽
 * 现在有三处要显示**同一份**目录：认知区右侧边栏（目录页签）、档案区的「目录」页签、
 * 手机档案区的底部弹层。抄三份迟早写得不一样（用户的规矩：别抄第二份）。
 * 🔴 **解析规则一个字都不在这里** —— 全在 `toc.ts`（`scanToc`），这里只负责"画出来 + 点了跳行"。
 *
 * # 抓手
 * 条目上那两件（`data-toc-item` / `data-toc-line`）**照旧**，认知区老套件 m14 正盯着它们；
 * 空状态那件 `data-toc-empty` 也照旧。
 */
import type { ReactNode } from "react";
import type { TocEntry } from "./toc";

interface TocListProps {
  /** 已经扫好的条目（`scanToc(content)` 的结果由调用方算 —— 它本来就有 content） */
  entries: TocEntry[];
  /** 当前高亮哪一条（点了的那条；不传就不高亮） */
  activeLine?: number | null;
  /** 点一条 → 跳到那一行（编辑态 = 光标过去，阅读态 = 滚过去，由调用方决定） */
  onJump: (line: number) => void;
  /** 一条都没有时显示什么（三处文案/排版略不同，所以由调用方给） */
  empty?: ReactNode;
}

export default function TocList({ entries, activeLine, onJump, empty }: TocListProps) {
  if (entries.length === 0) {
    return <>{empty ?? <p data-toc-empty className="px-1 leading-relaxed text-slate-400">还没有目录。</p>}</>;
  }

  return (
    <ul data-toc-list className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <li key={`${entry.line}-${entry.text}`}>
          <button
            type="button"
            data-toc-item={entry.text}
            data-toc-line={entry.line}
            onClick={() => onJump(entry.line)}
            className={`w-full truncate rounded-lg px-1.5 py-1 text-left ${
              activeLine === entry.line
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
            title={entry.text}
          >
            {entry.text}
          </button>
        </li>
      ))}
    </ul>
  );
}
