import type { ReactNode } from "react";

interface PageShellProps {
  title: string;
  subtitle?: string;
  /** 副标题下面再补一行（2026-09-22 小改动：设置页用它放「摩耶，意为幻象」） */
  note?: string;
  /** 右上角小标记，例如本区在哪个里程碑实现 */
  badge?: string;
  children?: ReactNode;
}

/** 各页面统一的外壳：标题 + 说明 + 可滚动内容区 */
export default function PageShell({ title, subtitle, note, badge, children }: PageShellProps) {
  return (
    <div className="flex h-full flex-col gap-6 p-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          )}
          {note && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{note}</p>}
        </div>
        {badge && (
          <span className="shrink-0 rounded-full bg-slate-200/70 px-3 py-1 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {badge}
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
