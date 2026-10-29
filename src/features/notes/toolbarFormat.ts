/**
 * 「光标现在处在什么格式里」的判定（P2-C 手机文本页工具条，2026-10-06）。
 *
 * 为什么要单独一个文件：手机工具条要**高亮"这行已经是 H2"**这类状态，
 * 而判据必须跟 `format.ts` 里「再点一次取消」的判据**同源** ——
 * 两处各写一套迟早会对不上（`marker.rs` ↔ `features/notes/markers.ts` 就是这么栽过的）。
 *
 * 纯函数：只吃字符串、不碰 CodeMirror，改起来好核。
 */
import { isAsciiAlnum, type ToolbarAction } from "./format";

// 行首允许的空白：半角空格 / Tab / 全角空格 —— 跟 `format.ts` 的 `leadingSpace` 同一套
const MARKER_LINE = /^[ \t\u3000]*-\[\]/;
const BULLET_LINE = /^[ \t\u3000]*- /;
const ORDERED_LINE = /^[ \t\u3000]*\d+\.\s/;
const TOC_LINE = /^[ \t\u3000]*toc/;

/** 这一行的**行级**格式（一行最多报一个） */
export function lineFormatsOf(line: string): ToolbarAction[] {
  // `-[]` 必须排在项目符号前面判：`-[]文字` 是待办，不是"项目符号"
  if (MARKER_LINE.test(line)) return ["marker"];
  // `## ` 与 `# ` 互斥（`#{2}\s` 匹配不到 `# `，反之亦然）；`### ` 两级都不是
  if (/^#{2}\s/.test(line)) return ["h2"];
  if (/^#{1}\s/.test(line)) return ["h1"];
  if (BULLET_LINE.test(line)) return ["bullet"];
  if (ORDERED_LINE.test(line)) return ["ordered"];
  const toc = TOC_LINE.exec(line);
  // `toc2` / `tocontinue` 不算目录行 —— 跟 `format.ts` 那道"防误吃"闸同一套
  if (toc && !isAsciiAlnum(line.charAt(toc[0].length))) return ["toc"];
  return [];
}

/** 光标 / 选区是不是**正被同一对记号包着**（= 再点一次会取消） */
export function inlineFormatsAt(doc: string, from: number, to: number): ToolbarAction[] {
  const wrapped = (mark: string) =>
    doc.slice(Math.max(0, from - mark.length), from) === mark &&
    doc.slice(to, to + mark.length) === mark;
  const out: ToolbarAction[] = [];
  // `**` 要先判：`*` 的判据在 `**粗体**` 上也会成立
  if (wrapped("**")) out.push("bold");
  else if (wrapped("*")) out.push("italic");
  if (wrapped("`")) out.push("code");
  return out;
}

/** 合起来用：这块正文 + 这个光标位置 → 工具条该高亮哪几个按钮 */
export function toolbarFormatsAt(doc: string, pos: number): ToolbarAction[] {
  const at = Math.max(0, Math.min(doc.length, pos));
  const lineFrom = doc.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const breakAt = doc.indexOf("\n", at);
  const lineEnd = breakAt === -1 ? doc.length : breakAt;
  return [...lineFormatsOf(doc.slice(lineFrom, lineEnd)), ...inlineFormatsAt(doc, at, at)];
}
