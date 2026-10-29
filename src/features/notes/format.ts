/**
 * 编辑辅助栏的插入/包裹规则（M3-3）。
 *
 * 纯函数：给「正文 + 选区 + 按钮」，算出「改哪一段、换成什么、光标放哪」，
 * 由调用方交给 CodeMirror 执行 —— 这样撤销/重做仍然是一步一步的（花笺当年
 * 用 execCommand 保住撤销栈，CodeMirror 本身就带 undo 历史，不用那套）。
 *
 * 规则（用户不记 Markdown 语法，所以按钮要"能教人"）：
 * - 包裹类（B / I / </>）：选中就包住；没选中就插占位文字并**选中占位文字**，
 *   直接打字就替换掉了；再点一次同样的按钮 = 取消。
 * - 行级（H1 / H2 / • / 1. / ☐）：作用在**光标所在行 / 选中的每一行**上；
 *   再点一次同一级 = 取消（H1→取消，H2 再从 H1 点 H2 就是降级）。
 * - 目录（`toc`，2026-10-02 用户反馈加的）：**选中了文字就包成 `toc那一行`**（他已经写好标题的情况），
 *   没选就把 `toc` 插在**行首**、光标停在后面（直接打标题）；这一行已经有 `toc` 前缀了 → 再点一次取消。
 */
import type { ChangeSpec } from "@codemirror/state";

export type ToolbarAction =
  | "bold"
  | "italic"
  | "h1"
  | "h2"
  | "bullet"
  | "ordered"
  | "marker"
  | "code"
  | "spoiler"
  | "strike"
  | "link"
  | "toc";

/** 一次格式化的结果（CodeMirror 的变更 + 变更后的选区） */
export interface FormatEdit {
  change: ChangeSpec;
  anchor: number;
  head: number;
}

const WRAP: Partial<Record<ToolbarAction, { mark: string; placeholder: string }>> = {
  bold: { mark: "**", placeholder: "粗体文字" },
  italic: { mark: "*", placeholder: "斜体文字" },
  code: { mark: "`", placeholder: "代码" },
  // #2（2026-10-21）：色块隐藏 —— 跟 B / I 同一套「选中就包住、再点一次取消」的规则
  spoiler: { mark: "||", placeholder: "要藏起来的文字" },
  // 反馈·1022 #1（2026-10-25）：中划线 —— 同一套包裹规则，再点一次取消
  strike: { mark: "~~", placeholder: "划掉的文字" },
};

/** 网址占位符（🔗 插入后会被选中，直接粘贴网址就替换掉了） */
const URL_PLACEHOLDER = "网址";

export function buildFormatEdit(
  doc: string,
  from: number,
  to: number,
  action: ToolbarAction,
): FormatEdit | null {
  const selected = doc.slice(from, to);

  // ───────── 目录：toc（M14-A 的自创语法，这儿给它一个按钮）
  if (action === "toc") {
    const lineFrom = doc.lastIndexOf("\n", from - 1) + 1;

    // ① 选中了文字 → 包成 `toc那一行`
    if (selected) {
      const before = doc.slice(lineFrom, from);
      const already = before === "toc" || /^\s*toc$/.test(before);
      // 同一行、且已经是 toc 行 → 再点一次取消
      if (already && !selected.includes("\n")) {
        return {
          change: { from: lineFrom, to, insert: selected },
          anchor: lineFrom,
          head: lineFrom + selected.length,
        };
      }
      const insert = `toc${selected}`;
      return {
        change: { from, to, insert },
        anchor: from + 3,
        head: from + insert.length,
      };
    }

    // ② 没选 → 把 toc 插到**行首**
    const lineEndRaw = doc.indexOf("\n", from);
    const lineEnd = lineEndRaw === -1 ? doc.length : lineEndRaw;
    const line = doc.slice(lineFrom, lineEnd);

    // 已经是 toc 行 → 再点一次取消（把前缀摘掉）
    const prefixed = /^([ \t\u3000]*)toc[ \t\u3000]?/.exec(line);
    if (prefixed && !isAsciiAlnum(line.charAt(prefixed[0].length))) {
      const drop = prefixed[0].length;
      return {
        change: { from: lineFrom, to: lineFrom + drop, insert: "" },
        anchor: Math.max(lineFrom, from - drop),
        head: Math.max(lineFrom, from - drop),
      };
    }

    // 空行：只插 `toc`（别留个尾空格，难看也没用）
    if (line.trim().length === 0) {
      return {
        change: { from: lineFrom, to: lineEnd, insert: "toc" },
        anchor: lineFrom + 3,
        head: lineFrom + 3,
      };
    }

    // 有文字：行首插 `toc`，光标停在它后面（接着打标题），原来那行文字一个字不动
    return {
      change: { from: lineFrom, to: lineFrom, insert: "toc" },
      anchor: from + 3,
      head: from + 3,
    };
  }

  // ───────── 包裹类：B / I / </>
  const wrap = WRAP[action];
  if (wrap) {
    const { mark, placeholder } = wrap;

    // 多行选中的 </> → 代码块
    if (action === "code" && selected.includes("\n")) {
      const insert = `\`\`\`\n${selected}\n\`\`\``;
      return {
        change: { from, to, insert },
        anchor: from + 4,
        head: from + 4 + selected.length,
      };
    }

    // 已经被同样的记号包着 → 再点一次取消
    const before = doc.slice(Math.max(0, from - mark.length), from);
    const after = doc.slice(to, to + mark.length);
    if (before === mark && after === mark) {
      return {
        change: { from: from - mark.length, to: to + mark.length, insert: selected },
        anchor: from - mark.length,
        head: from - mark.length + selected.length,
      };
    }

    const body = selected || placeholder;
    return {
      change: { from, to, insert: mark + body + mark },
      anchor: from + mark.length,
      head: from + mark.length + body.length,
    };
  }

  // ───────── 链接：🔗
  if (action === "link") {
    const label = selected || "链接文字";
    const insert = `[${label}](${URL_PLACEHOLDER})`;
    const urlStart = from + insert.indexOf(URL_PLACEHOLDER);
    return {
      change: { from, to, insert },
      anchor: urlStart,
      head: urlStart + URL_PLACEHOLDER.length,
    };
  }

  // ───────── 行级：H1 / H2 / • / 1. / ☐（作用在光标行或选中的每一行）
  let end = to;
  if (end > from && doc[end - 1] === "\n") end -= 1; // 选区正好停在下一行行首时别带上那一行
  const lineFrom = doc.lastIndexOf("\n", from - 1) + 1;
  const nextBreak = doc.indexOf("\n", end);
  const lineTo = nextBreak === -1 ? doc.length : nextBreak;

  const oldLines = doc.slice(lineFrom, lineTo).split("\n");
  const newLines = transformLines(oldLines, action);
  const insert = newLines.join("\n");

  return {
    change: { from: lineFrom, to: lineTo, insert },
    anchor: mapPosition(lineFrom, oldLines, newLines, from),
    head: mapPosition(lineFrom, oldLines, newLines, to),
  };
}

function transformLines(lines: string[], action: ToolbarAction): string[] {
  switch (action) {
    case "h1":
      return lines.map((line) => setHeading(line, 1));
    case "h2":
      return lines.map((line) => setHeading(line, 2));
    case "bullet":
      return lines.map(toggleBullet);
    case "ordered":
      return toggleOrdered(lines);
    case "marker":
      return lines.map(toggleMarker);
    default:
      return lines;
  }
}

/** `# ` / `## `：已经是这一级就取消；是别的级就换过去 */
function setHeading(line: string, level: 1 | 2): string {
  const matched = /^(#{1,6})\s+(.*)$/.exec(line);
  if (matched) {
    return matched[1].length === level
      ? matched[2]
      : `${"#".repeat(level)} ${matched[2]}`;
  }
  return `${"#".repeat(level)} ${line}`;
}

/** `- ` 无序列表（再来一次取消） */
function toggleBullet(line: string): string {
  const matched = /^(\s*)- (.*)$/.exec(line);
  const indent = leadingSpace(line);
  if (matched) return matched[1] + matched[2];
  return `${indent}- ${line.slice(indent.length)}`;
}

/** `1. 2. 3.` 有序列表（整段一起编号；全是编号了就取消） */
function toggleOrdered(lines: string[]): string[] {
  const numbered = /^\s*\d+\.\s/;
  const allNumbered = lines.every((line) => line.trim().length === 0 || numbered.test(line));
  if (allNumbered) {
    return lines.map((line) => {
      const matched = /^(\s*)\d+\.\s(.*)$/.exec(line);
      return matched ? matched[1] + matched[2] : line;
    });
  }
  let index = 0;
  return lines.map((line) => {
    if (line.trim().length === 0) return line;
    index += 1;
    const indent = leadingSpace(line);
    const body = line.slice(indent.length).replace(/^\d+\.\s/, "");
    return `${indent}${index}. ${body}`;
  });
}

/** `-[]` 待办标记（再来一次取消）；标记必须在行首，所以插在缩进之后 */
function toggleMarker(line: string): string {
  const indent = leadingSpace(line);
  const body = line.slice(indent.length);
  if (body.startsWith("-[]")) return indent + body.slice(3).trimStart();
  return `${indent}-[]${body}`;
}

function leadingSpace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

/** 认不认得出是"防误吃那道闸"要挡的字符（`toc2` / `tocontinue`）—— 跟 `toc.ts` 同一套 */
export function isAsciiAlnum(ch: string): boolean {
  return /[0-9A-Za-z]/.test(ch);
}

/** 把变更前的一个位置换算成变更后的位置（行内前缀变化时整体平移） */
function mapPosition(
  lineFrom: number,
  oldLines: string[],
  newLines: string[],
  pos: number,
): number {
  let oldStart = lineFrom;
  let newStart = lineFrom;
  for (let i = 0; i < oldLines.length; i += 1) {
    const oldEnd = oldStart + oldLines[i].length;
    if (pos >= oldStart && pos <= oldEnd) {
      const delta = newLines[i].length - oldLines[i].length;
      const inLine = Math.max(0, Math.min(newLines[i].length, pos - oldStart + delta));
      return newStart + inLine;
    }
    oldStart = oldEnd + 1;
    newStart += newLines[i].length + 1;
  }
  return newStart;
}
