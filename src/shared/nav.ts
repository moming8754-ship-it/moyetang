/**
 * 导航条目定义（Sidebar 与首页入口共用，避免两处标签不一致）
 * 约定：左侧导航 = 首页 + 信息区/认知区/执行区/日程/技能区（+ 启用档案区时的「档案库」）+ 设置 + quit
 *       （「日程」是 M11-A 新增的：日历 = 过去，日程 = 现在与未来）
 *
 * M16-A：`icon` 从 **emoji 字符串**换成了**开源图标库里的名字**（Lucide，见 `components/Icon.tsx`）——
 * 具体长什么样、怎么渲染，全在那一个文件里管；这里只写"用哪个图标"。
 */
import type { ViewKey } from "../store/ui";
import type { NavIconName } from "../components/Icon";

export interface NavItem {
  key: ViewKey;
  label: string;
  /** 图标名（去 `components/Icon.tsx` 里查；**不再写 emoji**） */
  icon: NavIconName;
  /** 首页卡片上的一句话说明 */
  desc: string;
}

/** 功能区（首页之外的几个「区」；顺序 = 左侧导航顺序） */
export const ZONE_ITEMS: NavItem[] = [
  {
    key: "info",
    label: "信息区",
    icon: "inbox",
    desc: "快进快出的收集箱：先放下，不管分类",
  },
  {
    key: "cognition",
    label: "认知区",
    icon: "brain",
    desc: "想法生长的地方：想透、写成体系",
  },
  {
    key: "todo",
    label: "执行区",
    icon: "todo",
    desc: "推进与专注：待办、四象限、番茄钟",
  },
  {
    key: "schedule",
    label: "日程",
    icon: "schedule",
    desc: "日历看过去、日程看现在与未来（M11）",
  },
  {
    key: "skill",
    label: "技能区",
    icon: "skill",
    desc: "长期技能积累与自我激励（第二版）",
  },
];

export const HOME_ITEM: NavItem = {
  key: "home",
  label: "首页",
  icon: "home",
  desc: "总入口 + 动态提醒",
};

export const SETTINGS_ITEM: NavItem = {
  key: "settings",
  label: "设置",
  icon: "settings",
  desc: "数据目录、外观、快捷键、提醒开关",
};

/**
 * M15：档案库（**默认不在导航里**）。
 *
 * 🔴 用户定的形态：「独立的区，但**不仔细在设置里寻找就无法启用**（平时没有入口）」。
 * 所以它**不进 `NAV_ITEMS`** —— 由 `Sidebar` 在 `config.archive.enabled` 为真时才追加，
 * 位置在几个区之后、设置之前。
 */
export const ARCHIVE_ITEM: NavItem = {
  key: "archive",
  label: "档案库",
  icon: "archive",
  desc: "收纳被遗忘的东西（要在设置里启用「档案区」才出现）",
};

/** 左侧导航顺序（quit 单独作为操作按钮渲染；档案库按开关动态追加，见上） */
export const NAV_ITEMS: NavItem[] = [HOME_ITEM, ...ZONE_ITEMS, SETTINGS_ITEM];

/** 首页入口列表（几个区 + 设置；档案库同样按开关动态追加） */
export const HOME_ENTRIES: NavItem[] = [...ZONE_ITEMS, SETTINGS_ITEM];
