/**
 * 技能区（M12）—— 两块：
 * 1. **奖状与证书**（M12-A，已做）；
 * 2. **格言与原则**（M12-C，已做）；
 *
 * 技能树已于 2026-10-27 由用户明确永久不做，入口和占位页一起删除。
 */
import { useState } from "react";
import PageShell from "../components/PageShell";
import AwardsPane from "../features/skills/AwardsPane";
import MottosPane from "../features/skills/MottosPane";

type TabKey = "awards" | "motto";

const TABS: { key: TabKey; label: string; ready: boolean }[] = [
  { key: "awards", label: "奖状与证书", ready: true },
  { key: "motto", label: "格言与原则", ready: true },
];

export default function SkillPage() {
  const [tab, setTab] = useState<TabKey>("awards");

  return (
    <PageShell
      title="技能区"
      subtitle="把自己挣来的东西挂起来 —— 看得见，才走得远"
      badge="M12-A · 奖状"
    >
      <div className="flex min-h-full flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((one) => (
            <button
              key={one.key}
              type="button"
              data-skill-tab={one.key}
              data-skill-tab-ready={one.ready ? "1" : "0"}
              onClick={() => setTab(one.key)}
              className={`rounded-lg px-3 py-1 text-xs ${
                tab === one.key
                  ? "bg-indigo-600 text-white"
                  : one.ready
                    ? "border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    : "border border-dashed border-slate-300 text-slate-400 hover:bg-slate-100 dark:border-slate-700"
              }`}
            >
              {one.label}
              {!one.ready && <span className="ml-1 text-[10px]">（还没做）</span>}
            </button>
          ))}
        </div>

        {tab === "awards" && <AwardsPane />}

        {tab === "motto" && <MottosPane />}

      </div>
    </PageShell>
  );
}
