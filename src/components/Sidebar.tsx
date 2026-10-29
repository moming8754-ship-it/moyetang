import { ARCHIVE_ITEM, HOME_ITEM, NAV_ITEMS, SETTINGS_ITEM, ZONE_ITEMS } from "../shared/nav";
import { logoSrc } from "../shared/daytime";
import Icon from "./Icon";
import { useData } from "../store/data";
import { useUi } from "../store/ui";
import { useQuitAction } from "../features/quit";

interface SidebarProps {
  daytime: boolean;
}

/** 左侧导航：首页 + 几个区 + 设置 + quit（quit 是操作，不是页面） */
export default function Sidebar({ daytime }: SidebarProps) {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const handleQuit = useQuitAction();
  /** M15：档案库**默认没有入口**，只有设置里启用了「档案区」才追加到导航里 */
  const archiveEnabled = useData((s) => s.config.archive.enabled);
  const items = archiveEnabled
    ? [HOME_ITEM, ...ZONE_ITEMS, ARCHIVE_ITEM, SETTINGS_ITEM]
    : NAV_ITEMS;

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 ${
        collapsed ? "w-[68px]" : "w-56"
      }`}
    >
      {/* 应用 logo：白天哥尔赞 / 夜晚美尔巴 */}
      <div className="flex items-center gap-3 px-4 py-5">
        <img
          src={logoSrc(daytime)}
          alt="东方摩耶堂"
          className="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-slate-200 dark:ring-slate-700"
        />
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">东方摩耶堂</div>
            <div className="truncate text-xs text-slate-400">
              {daytime ? "白天 · 哥尔赞" : "夜晚 · 美尔巴"}
            </div>
          </div>
        )}
      </div>

      {/* 导航 */}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2">
        {items.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              title={collapsed ? item.label : undefined}
              onClick={() => setView(item.key)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                active
                  ? "bg-indigo-50 font-medium text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              } ${collapsed ? "justify-center px-0" : ""}`}
            >
              <span className="shrink-0">
                <Icon name={item.icon} label={item.label} />
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* 底部操作：收起 / 退出 */}
      <div className="flex flex-col gap-1 border-t border-slate-200 p-2 dark:border-slate-800">
        <button
          type="button"
          onClick={toggleSidebar}
          title={collapsed ? "展开导航" : "收起导航"}
          className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <span className="shrink-0">
            <Icon name={collapsed ? "expand" : "collapse"} label={collapsed ? "展开导航" : "收起导航"} />
          </span>
          {!collapsed && <span>收起</span>}
        </button>
        <button
          type="button"
          onClick={handleQuit}
          title="退出程序"
          className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-400 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <span className="shrink-0">
            <Icon name="quit" label="退出程序" />
          </span>
          {!collapsed && <span>quit</span>}
        </button>
      </div>
    </aside>
  );
}
