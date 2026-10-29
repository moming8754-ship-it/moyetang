/**
 * 手机版 · 区的总入口（M19）
 *
 * 一个区一个文件放 `src/mobile/zones/` 下，这里按当前 view 分发。
 * 还没轮到做的区用 `placeholder.tsx`（能点开、内容还没搬过来）。
 *
 * ⚠️ 顺序照 `DEV-PLAN-v3.md` §M19：首页 → 信息区 → 认知区 → 执行区 → 日程 → 技能区 → 档案库 → 设置。
 * ⚠️ 每个区的根节点**必须**带 `data-mobile-zone={view}`（m18/m19 套件靠它认区，别漏）。
 */
import type { ViewKey } from "../../store/ui";

import ArchiveZone from "./ArchiveZone";
import CognitionZone from "./CognitionZone";
import HomeZone from "./HomeZone";
import InfoZone from "./InfoZone";
import ZonePlaceholder from "./placeholder";
import ScheduleZone from "./ScheduleZone";
import SettingsZone from "./SettingsZone";
import SkillZone from "./SkillZone";
import TodoZone from "./TodoZone";

export default function MobileZone({ view, label }: { view: ViewKey; label: string }) {
  switch (view) {
    case "home":
      return <HomeZone />;
    case "info":
      return <InfoZone />;
    case "cognition":
      return <CognitionZone />;
    case "todo":
      return <TodoZone />;
    case "schedule":
      return <ScheduleZone />;
    case "skill":
      return <SkillZone />;
    case "archive":
      return <ArchiveZone />;
    case "settings":
      return <SettingsZone />;
    default:
      return <ZonePlaceholder view={view} label={label} />;
  }
}
