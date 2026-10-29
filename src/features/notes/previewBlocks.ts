/**
 * 把正文拆成三类"块"，交给预览渲染（M3-4 勾选框行 / M3-5 联动信息只读块）。
 *
 * 为什么不直接把整篇丢给 react-markdown：
 * 1. `-[]文字` 不是标准 Markdown（标准是 `- [ ]`），remark-gfm 认不出来；
 * 2. 联动信息那几行要渲染成**只读**的"引用块 + 来源标记"，还得能点回信息区 ——
 *    交给 Markdown 渲染器就只能拿到一段 HTML，塞不进按钮。
 *
 * 所以：标记行与引用行单独成块（自己渲染），其余行按顺序攒成 Markdown 块。
 * 行号一直带在块上，勾选框才能对应回 `markerKey`。
 *
 * ⚠️ 2026-10-02 新增 `image` 块（用户反馈"小窗粘了图、认知区预览看不到"）：
 *    图片路径**单独占一行**时不再当普通文字，交给 {@link MarkdownPreview} 渲染成图。
 *    判定放在这里（而不是让 Markdown 渲染器处理）是为了**跟别的不一样**：
 *    只有"这一行除了图片路径什么都没有"才算，句子中间的路径照旧是文字。
 */
import { markerKeyOf, markerTextOf } from "./markers";
import { tocTextOf } from "./toc";

export type PreviewBlock =
  | { kind: "md"; line: number; text: string }
  | { kind: "marker"; line: number; key: string; text: string }
  | { kind: "info"; line: number; text: string }
  /** M14-A：`toc第二章` 这一行 —— 预览里画成标题（编辑模式里它仍是原样的正文） */
  | { kind: "toc"; line: number; text: string }
  /** 2026-10-02：图片路径单独占一行 —— 预览里画成图（编辑模式里仍是原样文字） */
  | { kind: "image"; line: number; path: string };

/** 联动信息的固定写法（与 Rust `store::note::link_info` 一致） */
const INFO_QUOTE = /^>\s*\*〔联动信息〕(.*)\*$/;

/**
 * 图片路径的两种写法（**整行只有它**才算）：
 * 1. `assets/xxxx.png` —— 用户手打 / 小窗粘图留下的裸路径；
 * 2. `![](assets/xxxx.png)` —— Markdown 语法，尾部允许 `![](... "标题")` 那种写法。
 */
const IMAGE_LINE_BARE = /^assets\/[^\s()[\]]+\.(?:png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_LINE_MD = /^!\[[^\]]*\]\(\s*(assets\/[^\s)]+)\s*(?:"[^"]*")?\s*\)$/i;

/**
 * 这一行是不是"只有一张图"？是就给出相对路径，不是给 `null`。
 *
 * ⚠️ 只认 `assets/` 开头的（那是本软件自己存图的地方）——
 * 随便一段 `http://…/x.png` 或别人写的相对路径**不许**被当成图，免得预览乱吃正文。
 */
export function imagePathOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const md = IMAGE_LINE_MD.exec(trimmed);
  if (md) return md[1];
  return IMAGE_LINE_BARE.test(trimmed) ? trimmed : null;
}

export function parsePreviewBlocks(noteId: string, content: string): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    if (text.trim().length > 0) blocks.push({ kind: "md", line: bufferStart, text });
    buffer = [];
  };

  content.split("\n").forEach((line, index) => {
    const marker = markerTextOf(line);
    if (marker) {
      flush();
      blocks.push({
        kind: "marker",
        line: index,
        key: markerKeyOf(noteId, marker),
        text: marker,
      });
      return;
    }

    const info = INFO_QUOTE.exec(line);
    if (info) {
      flush();
      blocks.push({ kind: "info", line: index, text: info[1].trim() });
      return;
    }

    // M14-A：`toc文字` 单独成块（⚠️ 必须先 flush —— 不然它会跟上下行并成一个 Markdown 块，
    // 预览里就画不成标题了；2026-09-27 验收就是栽在这里：`[data-toc-heading]` 一个都没有）
    const toc = tocTextOf(line);
    if (toc) {
      flush();
      blocks.push({ kind: "toc", line: index, text: toc });
      return;
    }

    // 2026-10-02：图片路径单独占一行 → 预览里画成图（**必须单独成块**，理由同 toc 那条）
    const image = imagePathOf(line);
    if (image) {
      flush();
      blocks.push({ kind: "image", line: index, path: image });
      return;
    }

    if (buffer.length === 0) bufferStart = index;
    buffer.push(line);
  });

  flush();
  return blocks;
}
