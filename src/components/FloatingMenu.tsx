/**
 * 浮层菜单（2026-10-11 新增，v2.19.0）—— **挂在 `document.body` 上、按触发按钮的位置定位**。
 *
 * # 为什么非要有它
 * 用户反馈第 11 条：「随便点了一篇笔记的三个点的小图标，无法出来完整的内容」。
 * 当场定位到根因：认知区每行的 ⋮ 菜单原来是 `absolute` 挂在**那一行**里的
 * （旧代码 `CognitionPage.tsx` 的 `absolute right-0 z-20 mt-1 w-48`），
 * 而整个笔记列表容器是 `min-h-0 flex-1 overflow-y-auto` ——
 * **菜单一伸出容器就被裁**，底下那几项（导出纯文本 / 导入 / 删除）根本露不出来
 * （他发的截图正好断在「导入 Markdown…」半行上）。
 *
 * # 以后在可滚动容器里放浮层，一律照这三条来
 * ① `createPortal` 到 `document.body` ＋ `position: fixed` → **不受任何祖先 overflow 影响**；
 * ② 位置按**触发按钮的 `getBoundingClientRect()`** 算：左右夹在视口里，
 *    **下面放不下就往上翻**（放不下才贴底），永远不出屏；
 * ③ 外面点一下 / `Esc` / 滚动（菜单自己内部滚动不算）/ 改窗口大小 → **关掉**
 *    （滚动之后菜单会和那一行错位，留着不如关掉）。
 *
 * ⚠️ 用它就别再自己写「点别处关掉」的 effect（会关两次，还会把里面的输入框点掉）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 视口边缘留多少空隙 */
const GAP = 8;
/** 菜单与触发按钮之间的空隙 */
const OFFSET = 4;

export default function FloatingMenu({
  /** 触发按钮的位置（`element.getBoundingClientRect()`） */
  anchor,
  onClose,
  children,
  /** `right` = 右边缘与触发按钮右边缘对齐（列表行里用这个，菜单不会伸到右边去） */
  align = "left",
  width = 208,
  /** 给验收脚本认人用的抓手 */
  testId,
}: {
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 先渲染（藏起来）量高度，再定位 —— 量不到高度就没法决定往上翻还是往下翻
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth || width;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = align === "right" ? anchor.right - w : anchor.left;
    left = Math.max(GAP, Math.min(left, vw - w - GAP));

    const below = anchor.bottom + OFFSET;
    let top = below;
    if (below + h > vh - GAP) {
      const above = anchor.top - h - OFFSET;
      top = above >= GAP ? above : Math.max(GAP, vh - h - GAP);
    }
    setPos({ top, left });
  }, [anchor, align, width]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // ⚠️ 滚动在**捕获阶段**听：列表滚动时菜单会跟那一行错位，直接关掉最省事。
    //    菜单**自己内部**滚动不算（长菜单要能滚）。
    const onScroll = (event: Event) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      data-floating-menu={testId ?? "1"}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        // 再兜一层：万一内容仍然超出视口高度，里面的列表自己滚
        maxHeight: `calc(100vh - ${GAP * 2}px)`,
        overflowY: "auto",
      }}
      className="z-50 rounded-xl border border-slate-200 bg-white p-2 text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
    >
      {children}
    </div>,
    document.body,
  );
}
