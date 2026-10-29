/**
 * 看大图（通用组件）。
 *
 * # 为什么抽成公共组件
 * 信息区（M2）和树状图节点（M4）都要"点缩略图看大图"。
 * M3.1 的试用反馈修过一个坑：**别用 `max-h-full` 卡高度** ——
 * 1080×2400 的手机长截图会被按高度压成一条窄缝，字全糊。
 * 那份修好的逻辑（按窗口宽度铺满 + 容器可滚动 + 原图 1:1 / 适应宽度切换）
 * 如果再抄一遍，等于把踩过的坑再挖一次。
 *
 * ⚠️ 改这里等于同时改信息区和认知区，动完两处都要回归「点击看大图」。
 */
import { useEffect, useState } from "react";
import { missingImageText } from "../features/asset";
import { AssetImage } from "./AssetImage";

interface ImageViewerProps {
  /** 图片的相对路径（`assets/xxx.png`）；`null` = 不显示 */
  relPath: string | null;
  onClose: () => void;
}

export default function ImageViewer({ relPath, onClose }: ImageViewerProps) {
  /** 默认**按窗口宽度铺满**（长截图只有这样字才看得清），可切回原图 1:1 */
  const [fitWidth, setFitWidth] = useState(true);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  /** 图不在（手机版图片不参与同步 → 常态；电脑上就是真丢了）—— 顶栏别再写"载入中…" */
  const [missing, setMissing] = useState(false);

  // 换一张图就回到"适应宽度"
  useEffect(() => {
    setFitWidth(true);
    setSize(null);
    setMissing(false);
  }, [relPath]);

  // Esc 关掉
  useEffect(() => {
    if (!relPath) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [relPath, onClose]);

  if (!relPath) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/90" onClick={onClose}>
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-3 text-xs text-slate-300">
        <span>
          {missing
            ? missingImageText(relPath)
            : size
              ? `${size.w} × ${size.h}`
              : "载入中…"}{" "}
          · 点背景或按 Esc 关闭
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setFitWidth((fit) => !fit);
            }}
            className="rounded-xl bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            {fitWidth ? "原图 1:1" : "适应宽度"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            关闭 ✕
          </button>
        </div>
      </div>

      {/* 图片区：能滚 —— 长图按宽度铺满后高度会超出屏幕，滚动看下半截。
          注意：stopPropagation 只加在 img 上（不是这个滚动容器），
          否则"点图片旁边的空白关掉大图"就会失效 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <AssetImage
          relPath={relPath}
          alt="大图"
          onError={() => setMissing(true)}
          fallbackClassName="block pt-20 text-center text-sm text-slate-300"
          loading={<p className="pt-20 text-center text-sm text-slate-400">图片载入中…</p>}
          imgProps={{
            "data-image-viewer": true,
            onLoad: (event) =>
              setSize({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              }),
            onClick: (event) => event.stopPropagation(),
            className: "mx-auto block rounded-xl shadow-2xl",
            style: fitWidth ? { maxWidth: "100%" } : { maxWidth: "none" },
          }}
        />
      </div>
    </div>
  );
}
