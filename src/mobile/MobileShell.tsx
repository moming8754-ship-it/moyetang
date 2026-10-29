/**
 * 手机版外壳（M18 / v2.1.0）
 *
 * 结构照设计稿 `.spike\M18-mobile-shell.html` 的**方案②**（用户 2026-09-27 拍板）：
 *   顶部标题栏（当前区名 + 「⋯」）｜ 内容区 ｜ 底部 **6 格**导航
 *   6 格 = 首页 / 信息区 / 认知区 / 执行区 / 日程 / **更多**
 *   「更多」面板里 = 技能区 / 档案库 / 设置 / 同步电脑
 *
 * ⚠️ 图标**不复用** `components/Icon.tsx`（那套是给侧栏用的、尺寸写死），
 *    这里用设计稿里那几条 inline SVG 路径，尺寸 16.5px、字号 9px（6 格才塞得下）。
 *
 * ⚠️ 电脑版**一行观感都不许变**：本文件只在 `App.tsx` 判定要手机布局时才渲染。
 */
import { useEffect, useState, type ReactNode } from "react";

import { useData } from "../store/data";
import { useUi, type ViewKey } from "../store/ui";
import { isMobilePreview } from "./platform";
import MobileZone from "./zones";
import { registerBackLayer } from "./back";

/** 区名（跟 `shared/nav.ts` 的 label 一致；这里单独列一份，免得手机外壳依赖侧栏那套结构） */
const LABELS: Record<ViewKey, string> = {
  home: "首页",
  info: "信息区",
  cognition: "认知区",
  todo: "执行区",
  schedule: "日程",
  skill: "技能区",
  settings: "设置",
  archive: "档案库",
};

/** 底栏 6 格（顺序就是用户看惯的顺序） */
const TABS: { key: ViewKey | "more"; label: string; d: string }[] = [
  { key: "home", label: "首页", d: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" },
  { key: "info", label: "信息区", d: "M3 12h5l2-3h4l2 3h5M3 12v7h18v-7" },
  { key: "cognition", label: "认知区", d: "M5 4h14v16H5zM8 9h8M8 13h8M8 17h5" },
  { key: "todo", label: "执行区", d: "M4 6h10M4 12h10M4 18h6M17 14l2 2 3.5-3.5" },
  { key: "schedule", label: "日程", d: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" },
  { key: "more", label: "更多", d: "M5 12h.01M12 12h.01M19 12h.01" },
];

/** 「更多」面板里的四个入口（**档案库那格要看开关**，见下面的 `MORE_ITEMS.filter`） */
const MORE_ITEMS: { key: ViewKey | "sync"; label: string; desc: string }[] = [
  { key: "skill", label: "技能区", desc: "奖状 · 格言" },
  { key: "archive", label: "档案库", desc: "收纳起来的东西" },
  { key: "settings", label: "设置", desc: "外观 · 字号 · 数据" },
  { key: "sync", label: "同步电脑", desc: "同一个 WiFi 下手输地址 + 短码" },
];

/** 某个区还没轮到做（M19.x 逐个替换成真页面） */
interface ShellProps {
  children?: ReactNode;
}

export default function MobileShell({ children }: ShellProps) {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const [moreOpen, setMoreOpen] = useState(false);
  /**
   * 档案库那格**跟着开关走**（用户 2026-10-07 反馈）：
   * 原话「既然知道它要在设置里面启用，为什么点了一个更多会看到这个『档案区』呀，要在设置之外彻底隐藏才行」——
   * 所以没启用时**连入口都不出现**（不是灰掉、不是点进去提示"还没启用"）。
   */
  const archiveEnabled = useData((s) => s.config.archive.enabled);

  // P0-2：返回手势先关「更多」面板
  useEffect(() => {
    if (!moreOpen) return;
    return registerBackLayer(() => {
      setMoreOpen(false);
      return true;
    });
  }, [moreOpen]);

  const shell = (
    <div
      data-mobile-shell="1"
      className="flex h-full w-full flex-col overflow-hidden bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100"
    >
      {/* 顶部标题栏 */}
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <h1 data-mobile-title className="text-base font-bold">
          {LABELS[view]}
        </h1>
        <button
          type="button"
          data-mobile-more-btn
          aria-label="更多"
          title="更多"
          onClick={() => setMoreOpen(true)}
          className="rounded-lg px-2 py-1 text-slate-500 active:bg-slate-200 dark:text-slate-400 dark:active:bg-slate-800"
        >
          ⋯
        </button>
      </header>

      {/* 内容区：**滚动交给各区自己管**（这样「＋」这种浮动按钮才不会被列表带走） */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {children ?? <MobileZone view={view} label={LABELS[view]} />}
      </div>

      {/* 底部 6 格 */}
      <nav
        data-mobile-tabbar
        className="flex shrink-0 items-stretch border-t border-slate-200 bg-white/90 pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900/80"
      >
        {TABS.map((tab) => {
          const active = tab.key !== "more" && tab.key === view;
          return (
            <button
              key={tab.key}
              type="button"
              data-mobile-tab={tab.key}
              data-mobile-tab-active={active ? "1" : "0"}
              aria-label={tab.label}
              onClick={() => {
                if (tab.key === "more") setMoreOpen(true);
                else setView(tab.key as ViewKey);
              }}
              className={
                "relative flex flex-1 flex-col items-center justify-center gap-[3px] py-2 text-[9px] " +
                (active ? "text-indigo-500 dark:text-indigo-300" : "text-slate-400 dark:text-slate-500")
              }
            >
              {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-indigo-500 dark:bg-indigo-300" />}
              <svg
                viewBox="0 0 24 24"
                style={{ width: 16.5, height: 16.5 }}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={tab.d} />
              </svg>
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* 「更多」面板 */}
      {moreOpen && (
        <div data-mobile-more className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setMoreOpen(false)}>
          <div
            className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="px-1 pb-2 text-sm font-bold">更多</p>
            <div className="grid grid-cols-2 gap-2">
              {MORE_ITEMS.filter((item) => item.key !== "archive" || archiveEnabled).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-mobile-more-item={item.key}
                  onClick={() => {
                    // 🩹 P1-2：这里原来是 `return`（M18 时"同步还没做"留下的死按钮 —— 点了没反应）。
                    //    同步的入口在**设置页**（`MobileSync` 那个弹出面板），所以这儿跳到设置页去。
                    setView(item.key === "sync" ? "settings" : (item.key as ViewKey));
                    setMoreOpen(false);
                  }}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-left dark:border-slate-700"
                >
                  <span className="block text-[13px] font-semibold">{item.label}</span>
                  <span className="block text-[10px] text-slate-500 dark:text-slate-400">{item.desc}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              data-mobile-more-close
              onClick={() => setMoreOpen(false)}
              className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              收起
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // 验收用：在电脑上把手机外壳放进一个 360×800 的框里（真机上直接铺满）
  if (isMobilePreview()) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-300 p-4 dark:bg-slate-800">
        <div
          data-mobile-frame="1"
          className="relative overflow-hidden rounded-[28px] border border-slate-400 shadow-2xl dark:border-slate-600"
          style={{ width: 360, height: 800 }}
        >
          {shell}
        </div>
      </div>
    );
  }
  return shell;
}
