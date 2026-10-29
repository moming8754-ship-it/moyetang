/**
 * 笔记预览（M3-2 预览侧 / M3-4 勾选框 / M3-5 联动信息只读块）。
 *
 * 三类块各渲染各的（见 `previewBlocks.ts`）：
 * - Markdown 块 → react-markdown + remark-gfm；
 * - `-[]文字` → 带勾选框的一行，勾上/取消都会写回（状态记在执行区的待办上）；
 * - `> *〔联动信息〕…*` → **斜体 + 左边线 + 来源标记**的只读引用，可点回信息区。
 *
 * ⚠️ 单向可见：这里只用 `sourceInfos`（信息区 → 认知区），信息区那边看不到这篇笔记的内容。
 *
 * 2026-10-02 新增：图片路径单独占一行 → 渲染成图并点击看大图（用户反馈"小窗粘了图，
 * 认知区预览看不到"）。⚠️ **改成图这件事本身不改正文一个字** —— 只影响这一处显示。
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { missingImageText, useAssetUrl } from "../asset";
import ImageViewer from "../../components/ImageViewer";
import { formatStamp } from "../../shared/daytime";
import { infoDisplayText } from "../types";
import type { Info } from "../types";
import { parsePreviewBlocks } from "./previewBlocks";
import { remarkSpoiler } from "./spoiler";

interface MarkdownPreviewProps {
  noteId: string;
  content: string;
  /** 已勾选的 markerKey（真源是待办，勾上=那条待办完成） */
  checkedKeys: Set<string>;
  onToggleMarker: (key: string, text: string, checked: boolean) => void;
  /** 这篇笔记联动进来的信息 */
  sourceInfos: Info[];
  /** 点"去信息区"：跳回信息区并高亮那条信息 */
  onOpenInfo: (infoId: string) => void;
}

export default function MarkdownPreview({
  noteId,
  content,
  checkedKeys,
  onToggleMarker,
  sourceInfos,
  onOpenInfo,
}: MarkdownPreviewProps) {
  const blocks = useMemo(() => parsePreviewBlocks(noteId, content), [noteId, content]);

  /** 🔴 点开的大图（`null` = 没开）。图片块点一下就开它 */
  const [lightbox, setLightbox] = useState<string | null>(null);

  /** 引用块 → 具体是哪条信息：先按顺序对，文字不吻合再在剩下的里按文字找 */
  const resolved = useMemo(() => {
    const map = new Map<number, Info>();
    const used = new Set<string>();
    let order = 0;
    for (const block of blocks) {
      if (block.kind !== "info") continue;
      const usable = (one: Info | undefined): boolean =>
        one !== undefined && !used.has(one.id) && infoDisplayText(one) === block.text;

      // 先按顺序取（联动时正文追加与 sourceInfoIds 记账是同一趟，顺序天然对得上），
      // 对不上再在剩下的里按文字找（手工改过正文时的兜底）
      const byOrder = sourceInfos[order];
      const info = usable(byOrder)
        ? byOrder
        : sourceInfos.find((one) => !used.has(one.id) && infoDisplayText(one) === block.text);

      if (info) {
        used.add(info.id);
        map.set(block.line, info);
      }
      order += 1;
    }
    return map;
  }, [blocks, sourceInfos]);

  if (blocks.length === 0) {
    return (
      <p className="p-6 text-sm text-slate-400">
        这篇笔记还是空的。切到「编辑」写点什么，或者点上面那排按钮试试。
      </p>
    );
  }

  return (
    <div className="markdown-preview flex flex-col gap-1.5 px-5 py-4 text-sm leading-relaxed">
      {blocks.map((block) => {
        if (block.kind === "image") {
          return (
            <PreviewImage
              key={`image-${block.line}`}
              line={block.line}
              relPath={block.path}
              onOpen={() => setLightbox(block.path)}
            />
          );
        }

        if (block.kind === "marker") {
          return (
            <MarkerRow
              key={`marker-${block.line}`}
              markerText={block.text}
              checked={checkedKeys.has(block.key)}
              onToggle={(checked) => onToggleMarker(block.key, block.text, checked)}
            />
          );
        }

        if (block.kind === "info") {
          return (
            <LinkedInfoRow
              key={`info-${block.line}`}
              text={block.text}
              info={resolved.get(block.line)}
              onOpenInfo={onOpenInfo}
            />
          );
        }

        // M14-A：`toc第二章` 这种行在**预览**里画成一行标题（编辑模式里仍是原样的正文 —— 铁律：不改用户正文）
        // ⚠️ 它是 `parsePreviewBlocks` 单独分出来的 `toc` 块。**不能**靠"这个块里只有一行"来判断：
        //    连续的普通行会被并成一个 Markdown 块，那样一个标题都画不出来（2026-09-27 验收就栽在这）。
        if (block.kind === "toc") {
          return (
            <h3
              key={`toc-${block.line}`}
              data-toc-line={block.line}
              data-toc-heading={block.text}
              className="mt-2 border-b border-slate-200 pb-1 text-lg font-bold text-slate-800 dark:border-slate-700 dark:text-slate-100"
            >
              {block.text}
            </h3>
          );
        }

        return (
          <div key={`md-${block.line}`} className="md-block">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkSpoiler]}
              components={MD_COMPONENTS}
            >
              {block.text}
            </ReactMarkdown>
          </div>
        );
      })}

      {lightbox && <ImageViewer relPath={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/**
 * 图片块（2026-10-02）：正文里单独占一行的图片路径 → 渲染成图，点一下看大图。
 *
 * ⚠️ **认不出来就退回普通文字**：正文里的路径是手打的，写错一个字、或那张图后来被删了，
 * 都不该让预览里出现一个破图框。
 *
 * 为什么不先问后端"这文件在不在"：`asset_abs_path` 只挡路径穿越、**不校验存在**
 * （`store/assets.rs::abs_path` 就是拼一下路径），要真判存在得再加一条 Rust 命令 ——
 * 为预览加一条命令不值当（新命令要登记三处）。所以这里**乐观渲染 + 加载失败兜底**：
 * 图真不在时 `onError` 会把它退回成一行说明文字，观感和"没这个功能"一样干净。
 *
 * ⚠️ 那句说明文字**按平台分**（2026-10-06 统一）：手机上图片不参与同步（《同步协议》L34），
 * 缺图是常态 → 说「图片在电脑上」；电脑上缺图才是真找不到 → 说「图片没找到：路径」。
 * 口径只有一处：`features/asset.ts` 的 `missingImageText()`，别在这里另写一句话。
 */
function PreviewImage({
  line,
  relPath,
  onOpen,
}: {
  line: number;
  relPath: string;
  onOpen: () => void;
}) {
  const url = useAssetUrl(relPath);
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <p data-preview-image={relPath} data-preview-image-missing="1" className="text-slate-400">
        {missingImageText(relPath)}
      </p>
    );
  }

  return (
    <figure data-preview-image={relPath} data-preview-image-line={line} className="my-1">
      {url ? (
        <button
          type="button"
          onClick={onOpen}
          title="点击看大图"
          className="block overflow-hidden rounded-xl ring-1 ring-slate-200 transition-transform hover:scale-[1.01] dark:ring-slate-700"
        >
          <img
            src={url}
            alt="笔记里的图片"
            onError={() => setBroken(true)}
            className="max-h-72 max-w-full object-contain"
          />
        </button>
      ) : (
        <span
          data-preview-image-loading="1"
          className="inline-block h-24 w-40 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800"
        />
      )}
      <figcaption className="mt-1 text-[11px] text-slate-400">{relPath}</figcaption>
    </figure>
  );
}

/** `-[]文字`：带勾选框的一行 */
function MarkerRow({
  markerText,
  checked,
  onToggle,
}: {
  markerText: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 rounded-xl bg-indigo-50/70 px-3 py-2 dark:bg-indigo-500/10">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
        title={checked ? "点一下取消（执行区同步）" : "点一下勾上（执行区同步）"}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
      />
      <span className={checked ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-200"}>
        {markerText}
      </span>
    </label>
  );
}

/** 联动信息：斜体 + 左边线 + 来源标记，只读引用（点一下回信息区） */
function LinkedInfoRow({
  text,
  info,
  onOpenInfo,
}: {
  text: string;
  info?: Info;
  onOpenInfo: (infoId: string) => void;
}) {
  return (
    <div className="flex items-start gap-3 border-l-2 border-indigo-300 bg-indigo-50/40 py-2 pl-3 dark:border-indigo-500/50 dark:bg-indigo-500/5">
      {info?.assetPath && <InfoThumb relPath={info.assetPath} />}
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words italic text-slate-500 dark:text-slate-400">
          {text}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] not-italic text-slate-400">
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 font-medium text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300">
            〔联动信息〕
          </span>
          {info && <span>{formatStamp(info.createdAt)}</span>}
          {info ? (
            <button
              type="button"
              onClick={() => onOpenInfo(info.id)}
              className="text-indigo-600 hover:underline dark:text-indigo-300"
            >
              去信息区 →
            </button>
          ) : (
            <span className="text-slate-400">（原信息已不在，只剩这段文字）</span>
          )}
        </p>
      </div>
    </div>
  );
}

function InfoThumb({ relPath }: { relPath: string }) {
  const url = useAssetUrl(relPath);
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      className="h-16 w-16 shrink-0 rounded-lg object-cover ring-1 ring-slate-200 dark:ring-slate-700"
    />
  );
}

/**
 * `||文字||` 的色块（#2）：默认是一块深色，把字藏起来；**点一下才显示**，再点一下遮回去。
 *
 * 为什么用 `<button>`：手机上没有悬停，必须能点；键盘 Tab 也能到，回车/空格可开。
 * 藏起来时用 `text-transparent + select-none`（不是 `visibility:hidden`）—— 这样宽度还在，
 * 点开前后版面不跳。
 */
function SpoilerSpan({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      data-spoiler="1"
      data-spoiler-revealed={shown ? "1" : "0"}
      onClick={() => setShown((on) => !on)}
      title={shown ? "再点一下重新遮住" : "点一下显示（||文字|| 是色块隐藏）"}
      className={`mx-0.5 rounded px-1 align-baseline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
        shown
          ? "bg-indigo-50 text-inherit dark:bg-indigo-500/15"
          : "bg-slate-800 text-transparent select-none dark:bg-slate-600"
      }`}
    >
      {children}
    </button>
  );
}

/** Markdown 各元素的样式（Tailwind 4 没装 typography 插件，这里手写一份够用的） */
const MD_COMPONENTS: Components = {
  h1: ({ node, ...rest }) => <h1 className="mt-3 text-xl font-semibold" {...rest} />,
  h2: ({ node, ...rest }) => <h2 className="mt-3 text-lg font-semibold" {...rest} />,
  h3: ({ node, ...rest }) => <h3 className="mt-2 text-base font-semibold" {...rest} />,
  p: ({ node, ...rest }) => <p className="my-1.5 first:mt-0 last:mb-0" {...rest} />,
  /**
   * #2（2026-10-21）：`||文字||` 被 `remarkSpoiler` 落成带 `md-spoiler` 类的 `span`
   * → 这里换成**可点的色块**（点一下显示 / 再点一下遮回去）。
   * 手机上同样有效（没有悬停，统一用"点"）。
   */
  span: ({ node, ...rest }) => {
    const isSpoiler =
      typeof rest.className === "string" && rest.className.split(" ").indexOf("md-spoiler") >= 0;
    if (!isSpoiler) return <span {...rest} />;
    return <SpoilerSpan>{rest.children as ReactNode}</SpoilerSpan>;
  },
  /** `~~文字~~`（GFM 自带）—— 只给样式：中划线 + 灰一点，跟"完成/作废"的观感一致 */
  del: ({ node, ...rest }) => (
    <del className="text-slate-400 decoration-slate-400 dark:text-slate-500" {...rest} />
  ),
  ul: ({ node, ...rest }) => <ul className="my-1.5 list-disc pl-5" {...rest} />,
  ol: ({ node, ...rest }) => <ol className="my-1.5 list-decimal pl-5" {...rest} />,
  li: ({ node, ...rest }) => <li className="my-0.5" {...rest} />,
  blockquote: ({ node, ...rest }) => (
    <blockquote
      className="my-2 border-l-2 border-slate-300 pl-3 italic text-slate-500 dark:border-slate-600 dark:text-slate-400"
      {...rest}
    />
  ),
  pre: ({ node, ...rest }) => (
    <pre
      className="my-2 overflow-x-auto rounded-xl bg-slate-100 p-3 font-mono text-xs dark:bg-slate-800"
      {...rest}
    />
  ),
  code: ({ node, className, children, ...rest }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    return isBlock ? (
      <code className={`font-mono text-xs ${className ?? ""}`} {...rest}>
        {children}
      </code>
    ) : (
      <code
        className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-teal-700 dark:bg-slate-800 dark:text-teal-300"
        {...rest}
      >
        {children}
      </code>
    );
  },
  table: ({ node, ...rest }) => (
    <table className="my-2 w-full border-collapse text-xs" {...rest} />
  ),
  th: ({ node, ...rest }) => (
    <th className="border border-slate-200 px-2 py-1 text-left dark:border-slate-700" {...rest} />
  ),
  td: ({ node, ...rest }) => (
    <td className="border border-slate-200 px-2 py-1 dark:border-slate-700" {...rest} />
  ),
  hr: ({ node, ...rest }) => (
    <hr className="my-3 border-slate-200 dark:border-slate-700" {...rest} />
  ),
  // 预览里的链接第一版不跳转（免得把整个应用窗口导航走）
  a: ({ node, ...rest }) => (
    <a
      className="text-indigo-600 underline decoration-dotted dark:text-indigo-400"
      title="预览里的链接暂不跳转（第一版不做浏览器跳转）"
      onClick={(event) => event.preventDefault()}
      {...rest}
    />
  ),
};
