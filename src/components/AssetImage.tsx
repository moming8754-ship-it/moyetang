/**
 * 数据目录里的图片（`assets/xxx.png`），**图不在的时候不画破图**。
 *
 * # 为什么要有这一个组件（2026-10-06，用户真机截图点名）
 * 《同步协议》L34 定的是「图片 / 附件 `assets/` ❌ 不传」，L165 又补了一句
 * 「手机上会看到『图片在电脑上』的占位」—— 但**那句占位从来没写**：
 * 全项目 8 处 `<img>` 一处兜底都没有（只有 `MarkdownPreview` 有）。
 * 于是手机上（图片不参与同步）每个图都渲染成**撕角破图**，用户一眼就看到树节点里那个。
 *
 * 这里统一成一处：**路径解析失败 / 图加载失败 → 出占位**，文案按平台分
 * （手机＝"图片在电脑上"、电脑＝"图片没找到"，见 [`missingImageText`]）。
 *
 * ⚠️ 两条硬约束，改这个组件前先读：
 * ① **需要 `draggable={false}` 的地方必须由调用方通过 `imgProps` 传进来** ——
 *    树节点的图上要是没有它，`pointerdown` 会触发浏览器**原生图片拖拽**，
 *    整个"拖节点"手势会被吞掉（电脑树踩过这个大坑，见 `TreeCanvas.tsx`）。
 * ② **占位文案不许在调用处硬编码**，一律走 [`missingImageText`]。
 */
import type { ImgHTMLAttributes, ReactNode } from "react";
import { useEffect, useState } from "react";
import { missingImageText, useAssetImage } from "../features/asset";

/**
 * 透传给 `<img>` 的属性。
 *
 * ⚠️ 必须额外放行 `data-*`：TSX 里直接写 `<img data-foo>` 合法，但**对象字面量**按
 * `ImgHTMLAttributes` 校验时会报「不存在该属性」—— 而套件（`tools\cdp.ps1` 的
 * `-Action targets` / 验收脚本）恰恰靠这些 data 标记找人，所以这里显式放开。
 */
type AssetImgProps = ImgHTMLAttributes<HTMLImageElement> & {
  [key: `data-${string}`]: unknown;
};

interface AssetImageProps {
  /** 相对路径（`assets/xxx.png`）；空值 = 这块本来就没图 → 什么都不渲染 */
  relPath?: string | null;
  alt?: string;
  /** 出图时的 class（`imgProps.className` 优先级更高） */
  className?: string;
  /** 占位块的 class（不传就用默认的灰底小字块） */
  fallbackClassName?: string;
  /** 自己指定占位文案（不传就按平台自动 —— 一般别传） */
  fallbackText?: string;
  /** 缩略图那种小格子 → 用短文案 */
  compact?: boolean;
  /** URL 还没算出来时显示什么（默认：跟图同尺寸的呼吸块） */
  loading?: ReactNode;
  /** 图加载失败时通知调用方（`ImageViewer` 靠它把"载入中…"改掉） */
  onError?: () => void;
  /** 透传给 `<img>`：`draggable` / `onClick` / `title` / `className` / `data-*` 都走这里 */
  imgProps?: AssetImgProps;
}

/** 默认占位样式：灰底 + 小字，两端主题都跟得上（不写死颜色） */
const FALLBACK_BOX =
  "flex h-full w-full items-center justify-center rounded bg-slate-100 px-1 text-center " +
  "text-[10.5px] leading-tight text-slate-400 dark:bg-slate-800 dark:text-slate-500";

export function AssetImage({
  relPath,
  alt = "",
  className = "",
  fallbackClassName,
  fallbackText,
  compact = false,
  loading,
  onError,
  imgProps,
}: AssetImageProps) {
  const { url, failed } = useAssetImage(relPath ?? undefined);
  const [broken, setBroken] = useState(false);

  // 换一张图（或换到另一个节点）→ 重新给这张图一次机会
  useEffect(() => {
    setBroken(false);
  }, [relPath]);

  if (!relPath) return null;

  if (failed || broken) {
    return (
      <span
        data-asset-missing={relPath}
        title={fallbackText ?? missingImageText(relPath)}
        className={fallbackClassName ?? FALLBACK_BOX}
      >
        {fallbackText ?? missingImageText(relPath, compact)}
      </span>
    );
  }

  if (!url) {
    return (
      <>
        {loading ?? (
          <span className={`${className} animate-pulse bg-slate-100 dark:bg-slate-800`} />
        )}
      </>
    );
  }

  return (
    <img
      {...imgProps}
      src={url}
      alt={alt}
      data-asset-img={relPath}
      className={imgProps?.className ?? className}
      onError={() => {
        setBroken(true);
        onError?.();
      }}
    />
  );
}
