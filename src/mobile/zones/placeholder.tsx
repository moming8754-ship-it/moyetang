/**
 * 手机版 · 还没轮到做的区（M19 期间用）
 *
 * ⚠️ 根节点**必须**带 `data-mobile-zone={view}` —— m18/m19 套件靠它认区。
 */
import type { ViewKey } from "../../store/ui";

export default function ZonePlaceholder({ view, label }: { view: ViewKey; label: string }) {
  return (
    <div data-mobile-zone={view} className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-base font-semibold">{label}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        这个区正在做（M19）—— 现在能点开，内容还没搬过来。
      </p>
    </div>
  );
}