/**
 * #2（2026-10-21 · 用户反馈第二批）：「类似 steam 的色块隐藏」。
 *
 * 语法（用户拍板）：
 * - `||文字||` → 预览里画成**一块深色色块**，**点一下才显示**（手机没有悬停，所以统一"点"）；
 * - `~~文字~~` → 中划线（GFM 自带，这里只负责样式，见 `MarkdownPreview` 的 `del`）。
 *
 * 这条是**纯视图**：不改正文一个字、不生成数据、后端没有消费者
 * （判断标准见 §五：没有第二个消费者就别在后端再写一份解析器）。
 *
 * 为什么不用第三方插件：remark 生态里现成的 spoiler 插件要么带一堆依赖、要么语法不同；
 * 这点规则（同一行里 `||…||`）自己写 30 行就够，还能顺手把边界（空内容 / 表格竖线 / 代码块）钉死。
 */

/** 切出来的一小段：普通文字 或 被藏起来的文字 */
export type SpoilerPiece =
  | { kind: "text"; value: string }
  | { kind: "spoiler"; value: string };

/**
 * 把一段**纯文字**按 `||…||` 切开。
 *
 * 边界规则（都写在这里，别在别处再判断一遍）：
 * - **不许跨行**（`[^|\n]`）：跨行的 `||` 多半是两张表叠在一起，不该变成色块；
 * - **内容不能是空的 / 全是空白**（`\S`）：`||||` 原样留着；
 * - 内容里**不许再有 `|`**：Markdown 表格的竖线很多，放进来会让表格莫名其妙被吃掉。
 *
 * 代码块 / 行内代码里的 `||` 不会被传进来 —— 它们不是 text 节点（见 `remarkSpoiler`）。
 */
export function splitSpoilerText(value: string): SpoilerPiece[] {
  const out: SpoilerPiece[] = [];
  const re = /\|\|([^|\n]*[^\s|][^|\n]*)\|\|/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    if (match.index > at) out.push({ kind: "text", value: value.slice(at, match.index) });
    out.push({ kind: "spoiler", value: match[1] });
    at = match.index + match[0].length;
  }
  if (at < value.length) out.push({ kind: "text", value: value.slice(at) });
  return out.length > 0 ? out : [{ kind: "text", value }];
}

/** mdast 的最小形状（只用到这几样，不引 `@types/mdast`） */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/**
 * remark 插件：把每个 text 节点里的 `||…||` 换成 `<span data-spoiler>`。
 *
 * `data.hName` / `data.hProperties` 是 mdast-util-to-hast 的官方口子
 * （自定义节点没有专门 handler 时按这两个字段落地成元素）—— 所以不需要额外的
 * `rehype-raw`、也不会把用户的原始 HTML 放进来。
 *
 * ⚠️ **链接里的文字不切**：`<a>` 里再套一个可点的按钮，点哪一下都容易误触。
 */
export function remarkSpoiler() {
  return (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      if (!node.children) return;
      const next: MdNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
          const pieces = splitSpoilerText(child.value);
          if (pieces.length === 1 && pieces[0].kind === "text") {
            next.push(child);
            continue;
          }
          for (const piece of pieces) {
            if (piece.kind === "text") {
              next.push({ type: "text", value: piece.value });
            } else {
              next.push({
                type: "spoiler",
                data: {
                  hName: "span",
                  hProperties: {
                    "data-spoiler": "1",
                    className: "md-spoiler",
                  },
                },
                children: [{ type: "text", value: piece.value }],
              });
            }
          }
          continue;
        }
        if (child.type !== "link") walk(child);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}
