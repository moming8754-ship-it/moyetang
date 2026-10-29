/**
 * 导航图标的**统一出口**（M16-A）。
 *
 * # 为什么要有这个文件
 * 原来侧栏用的是 emoji（`🏠 📥 🧠 …`），字体不同机器长得不一样、还跟着系统版本变。
 * 换成开源图标库之后，**图标只从这一处出** —— 以后想换库（Lucide → 别的）只改这一个文件，
 * 页面里不用动。
 *
 * # 三条规矩
 * 1. 🔴 **图标必须来自开源库**（用户明确说过"不要让 AI 生成图标"）—— 这里用的是
 *    [Lucide](https://lucide.dev)（ISC 许可），细线 2px、圆头圆角，跟界面原来的克制风格一致；
 * 2. **`currentColor` 自动随主题变色**（Lucide 都是这么写的），所以不用做深浅两套；
 * 3. 每个图标都要有 **`aria-label` + `title`**：换成图标后，光看图认不出意思，
 *    悬停与读屏都得说清楚（侧栏收起时只剩图标，这条尤其重要）。
 */
import {
  Archive,
  Award,
  Brain,
  CalendarDays,
  CircleCheckBig,
  Inbox,
  House,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  Settings,
  type LucideIcon,
} from "lucide-react";

/** 图标的名字（导航那一批由 `shared/nav.ts` 用；后三个是侧栏底部的操作图标） */
export type NavIconName =
  | "home"
  | "inbox"
  | "brain"
  | "todo"
  | "schedule"
  | "skill"
  | "archive"
  | "settings"
  | "collapse"
  | "expand"
  | "quit";

const ICONS: Record<NavIconName, LucideIcon> = {
  home: House,
  inbox: Inbox,
  brain: Brain,
  todo: CircleCheckBig,
  schedule: CalendarDays,
  skill: Award,
  archive: Archive,
  settings: Settings,
  // 侧栏底部那两个：收起/展开 + 退出（原来用的是 « » ⏻ 这种字符，跟线稿放一起不搭）
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,
  quit: Power,
};

interface IconProps {
  name: NavIconName;
  /** 无障碍名字（= 界面上的那个词，例如「信息区」） */
  label: string;
  className?: string;
  /** 图标大小（px），默认 18 —— 侧栏那一档 */
  size?: number;
}

export default function Icon({ name, label, className, size = 18 }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={2}
      role="img"
      aria-label={label}
      className={className}
      // ⚠️ 不给 `<title>` 元素而是给 title 属性：侧栏按钮本身已有文字，
      //    这里只是"鼠标悬停时也能认出来"（收起侧栏时按钮上的 title 是同一句话）。
      data-nav-icon={name}
    />
  );
}
