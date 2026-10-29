import { useState } from "react";
import { activeReminder, useData } from "../store/data";
import { useUi } from "../store/ui";
import { AssetImage } from "./AssetImage";
import { formatStamp } from "../shared/daytime";
import { infoHeadline } from "../shared/reminderText";

/**
 * 顶部提醒横幅：45 分钟没联动的信息会在这里冒出来（PRD 3.2 / 10.2）。
 * 四个动作都直接可用：联动到认知区 / 建为待办 / 稍后提醒 / 不再提醒。
 */
export default function ReminderBanner() {
  const reminders = useData((s) => s.reminders);
  const infos = useData((s) => s.infos);
  const minutes = useData((s) => s.config.reminders.infoStaleMinutes);
  const linkToNote = useData((s) => s.linkToNote);
  const linkToTodo = useData((s) => s.linkToTodo);
  const snoozeReminder = useData((s) => s.snoozeReminder);
  const dismissReminder = useData((s) => s.dismissReminder);
  const setView = useUi((s) => s.setView);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  // ⚠️ 只要信息提醒：这四个按钮全是信息专属的，"待办提醒"走首页动态区
  const reminder = activeReminder(reminders, "info-stale");
  const info = reminder ? infos.find((item) => item.id === reminder.refId) : undefined;

  // 本地隐藏（只影响这次会话）：真正的"处理掉"要走稍后提醒/不再提醒
  if (!reminder || hidden) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-8 py-3 dark:border-amber-500/30 dark:bg-amber-500/10">
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none">⏰</span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            你在 {minutes} 分钟前的〔{reminder.payload.categoryText}〕信息还没推进下一步
          </p>
          <div className="mt-1 flex items-center gap-2">
            <AssetImage
              relPath={info?.assetPath}
              compact
              fallbackClassName="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-[11px] ring-1 ring-amber-300 dark:bg-amber-500/15 dark:ring-amber-500/40"
              imgProps={{
                draggable: false,
                className:
                  "h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-amber-300 dark:ring-amber-500/40",
              }}
            />
            <p className="min-w-0 flex-1 truncate text-sm text-amber-800/90 dark:text-amber-200/80">
              {infoHeadline(reminder.payload.text)}
              <span className="ml-2 text-xs text-amber-700/60 dark:text-amber-300/50">
                （{formatStamp(reminder.fireAt)}）
              </span>
            </p>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => linkToNote(reminder.refId))}
              className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
            >
              联动到认知区
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => linkToTodo(reminder.refId))}
              className="rounded-lg bg-white px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100 disabled:opacity-60 dark:bg-transparent dark:text-amber-200 dark:ring-amber-500/40"
            >
              建为待办
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => snoozeReminder(reminder.id, 15))}
              className="rounded-lg bg-white px-3 py-1 text-xs text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100 disabled:opacity-60 dark:bg-transparent dark:text-amber-200 dark:ring-amber-500/40"
            >
              稍后提醒
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => dismissReminder(reminder.id))}
              className="rounded-lg bg-white px-3 py-1 text-xs text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100 disabled:opacity-60 dark:bg-transparent dark:text-amber-200 dark:ring-amber-500/40"
            >
              不再提醒
            </button>
            <button
              type="button"
              onClick={() => setView("info")}
              className="rounded-lg px-3 py-1 text-xs text-amber-700/80 hover:bg-amber-100 dark:text-amber-300/70 dark:hover:bg-amber-500/10"
            >
              去看这条信息
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setHidden(true)}
          title="先收起来（可用「稍后提醒 / 不再提醒」真正处理）"
          className="shrink-0 rounded-lg px-2 py-1 text-amber-700/70 hover:bg-amber-100 dark:text-amber-300/70 dark:hover:bg-amber-500/10"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
