/**
 * 手机版 · 设置（M19.8 / v2.9.0）
 *
 * 照设计稿 `.spike\M18D-rest-zones.html`（设置那一格）：🔴 电脑版设置有 **10 个分组**，
 * 手机上平铺太长 → **只留手机用得上的，分四组**：
 *   ① 同步（同步电脑 · 同一个 WiFi 下手输电脑上的地址 + 6 位短码；上次同步时间是真的）
 *   ② 外观与字（主题 / 字号 / 首页常驻项）
 *   ③ 提醒与专注（到点提醒 / 锁屏自动暂停 / 离开多久算走神 / 自定义番茄时长）
 *   ④ 数据（档案库开关 / 导出 · 导入备份）
 * 电脑上那些"手机上没对应东西"的（数据目录、快捷键、清理、窗口）**不显示**。
 *
 * ⚠️ 复用的是电脑版同一套：`saveConfig(patch)`、`configGet/configSave`、`backupExport/backupImport`、
 *    `THEMES`（七套主题 + 内置三态）。手机上"改设置"跟电脑上是同一份 `config.json`。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { backupExportDownloads, backupImportBytes, syncStateGet } from "../../features/api";
import { fileToBase64 } from "../../shared/imageFile";
import { THEMES } from "../../shared/themes";
import type { ThemeMode } from "../../features/types";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import MobileSync from "./MobileSync";
import { registerBackLayer } from "../back";

/** 字号档（手机上给三档就够；电脑版是连续可调） */
const FONT_STEPS: { key: string; label: string; size: number }[] = [
  { key: "sm", label: "小", size: 14 },
  { key: "md", label: "中", size: 16 },
  { key: "lg", label: "大", size: 18 },
  { key: "xl", label: "特大", size: 20 },
];

const BASE_MODES: { key: ThemeMode; label: string }[] = [
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
  { key: "system", label: "跟系统" },
];

/** 一行设置（左边标题、右边值） */
function Row({
  label,
  value,
  onClick,
  hook,
  hint,
}: {
  label: string;
  value?: string;
  onClick?: () => void;
  hook?: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      data-mset-row={hook ?? label}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 dark:border-slate-800"
    >
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="mt-0.5 block text-[10.5px] text-slate-400">{hint}</span>}
      </span>
      <span className="shrink-0 text-[11.5px] text-slate-400">{value ?? "›"}</span>
    </button>
  );
}

export default function SettingsZone() {
  const config = useData((s) => s.config);
  const saveConfig = useData((s) => s.saveConfig);
  const refresh = useData((s) => s.refresh);
  const toast = useUi((s) => s.toast);
  const askConfirm = useUi((s) => s.askConfirm);
  /** M27：导入备份用的隐藏 input（安卓上 dialog 的「打开文件」没实现，只能自己开） */
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const [sheet, setSheet] = useState<null | "theme" | "font" | "focus" | "sync">(null);

  // 🩹 **P1-2**：「同步电脑」那行原来写死"还没做过"（同步过也这么显示，属于过期/糊弄文案）→
  //    改成读 `sync/state.json` 里**真的**上次同步时间。浏览器预览模式读不到就保持空。
  const [lastSyncAt, setLastSyncAt] = useState("");
  const refreshLastSync = useCallback(async () => {
    try {
      setLastSyncAt((await syncStateGet()).lastSyncAt);
    } catch {
      /* 预览模式：没有 Tauri，保持空 */
    }
  }, []);
  useEffect(() => {
    void refreshLastSync();
  }, [refreshLastSync]);

  // P0-2：返回手势先关设置里的弹出面板
  useEffect(() => {
    if (!sheet) return;
    return registerBackLayer(() => {
      setSheet(null);
      return true;
    });
  }, [sheet]);

  useEffect(() => {
    if (sheet === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheet(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const themeLabel =
    BASE_MODES.find((one) => one.key === config.theme)?.label ??
    THEMES.find((one) => one.id === config.theme)?.name ??
    String(config.theme);
  const fontLabel = FONT_STEPS.find((one) => one.size === config.fontSize)?.label ?? config.fontSize + "px";

  /**
   * M27（v2.18.0）：导出备份 —— **存进手机「下载/东方摩耶堂/」**。
   *
   * 以前这里走 `@tauri-apps/plugin-dialog` 的 `save()`，可**那个插件在安卓上根本没实现**
   * （`DialogPlugin.kt` 里就一行 `// TODO: ACTION_OPEN_DOCUMENT ??`）→ 点了毫无反应。
   * 现在走原生出口（MediaStore 写「下载」）：文件管理里看得见，微信/QQ 也能从那儿发出去。
   */
  const doExport = async () => {
    try {
      const report = await backupExportDownloads();
      toast(`备份已存到「${report.file}」（${report.files} 个文件）`, "success");
    } catch (error) {
      toast("导出失败：" + String(error), "error");
    }
  };

  /**
   * M27：导入备份 —— 用 `<input type=file>` 选 zip（安卓 WebView 认它），
   * 读成字节再交给后端（后端第一步会把当前数据留档，失败就中止）。
   * ⚠️ **会覆盖当前数据** → 先二次确认。
   */
  const doImport = async (file: File) => {
    try {
      const base64 = await fileToBase64(file);
      askConfirm({
        title: "导入这份备份？",
        message: "当前数据会被这份备份**覆盖**（后端会先把现在的内容存一份到 backups/ 里，后悔了还能导回来）。",
        confirmText: "导入",
        danger: true,
        onConfirm: () => {
          void (async () => {
            try {
              const report = await backupImportBytes(base64);
              await refresh();
              toast(`导入完成：${report.files} 个文件（导入前的数据已留档）`, "success");
            } catch (error) {
              toast("导入失败：" + String(error), "error");
            }
          })();
        },
      });
    } catch (error) {
      toast("读文件失败：" + String(error), "error");
    }
  };

  return (
    <div data-mobile-zone="settings" className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
        {/* ① 同步 */}
        <p className="px-1 pb-1.5 pt-1 text-[11px] text-slate-400">同步</p>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Row
            label="同步电脑"
            hook="sync"
            hint="同一个 WiFi 下手输电脑上的地址 + 6 位短码"
            value={lastSyncAt ? lastSyncAt.slice(5, 16).replace("T", " ") : "还没同步过"}
            onClick={() => setSheet("sync")}
          />
        </div>

        {/* ② 外观与字 */}
        <p className="px-1 pb-1.5 pt-4 text-[11px] text-slate-400">外观与字</p>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Row label="主题" hook="theme" value={themeLabel} onClick={() => setSheet("theme")} />
          <Row label="字号" hook="font" value={fontLabel} onClick={() => setSheet("font")} />
          <Row
            label="首页常驻项"
            hook="home-sticky"
            value={
              [config.homeSticky.reminders ? "提醒" : "", config.homeSticky.recentTodos ? "最近待办" : ""]
                .filter(Boolean)
                .join(" · ") || "都关着"
            }
          />
        </div>

        {/* ③ 提醒与专注 */}
        <p className="px-1 pb-1.5 pt-4 text-[11px] text-slate-400">提醒与专注</p>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <Row
            label="到点提醒"
            hook="remind"
            value={config.reminders.infoStaleEnabled ? "开" : "关"}
            onClick={() => void saveConfig({ reminders: { ...config.reminders, infoStaleEnabled: !config.reminders.infoStaleEnabled } }, "改好了")}
          />
          <Row
            label="锁屏自动暂停"
            hook="pause-on-lock"
            value={config.focus.pauseOnLock ? "开" : "关"}
            onClick={() => void saveConfig({ focus: { ...config.focus, pauseOnLock: !config.focus.pauseOnLock } }, "改好了")}
          />
          <Row
            label="离开多久算走神"
            hook="focus"
            value={Math.round(config.focus.awayThresholdSeconds / 60) + " 分钟"}
            onClick={() => setSheet("focus")}
          />
          <Row label="自定义番茄时长" hook="focus-minutes" value={config.focus.customMinutes + " 分钟"} onClick={() => setSheet("focus")} />
        </div>

        {/* ④ 数据 */}
        <p className="px-1 pb-1.5 pt-4 text-[11px] text-slate-400">数据</p>
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
          <div className="bg-white dark:bg-slate-900">
            <Row
              label="档案库（收纳功能）"
              hook="archive"
              value={config.archive.enabled ? "开" : "关"}
              hint={config.archive.enabled ? "导航里会出现档案库" : "默认藏起来，开了才有入口"}
              onClick={() => void saveConfig({ archive: { enabled: !config.archive.enabled } }, "改好了")}
            />
            <Row
              label="导出备份"
              hook="export"
              hint="存到「下载/东方摩耶堂/」，文件管理里能找到"
              onClick={() => void doExport()}
            />
            <Row
              label="导入备份"
              hook="import"
              hint="选一个压缩包恢复（会先自动备份当前数据）"
              onClick={() => zipInputRef.current?.click()}
            />
            {/* M27：导入备份的入口 —— 安卓 WebView 认 `<input type=file>`（dialog 插件在安卓上没实现） */}
            <input
              ref={zipInputRef}
              data-mset-import-input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                // 先清空，再处理：不清空的话"同一个文件选第二次"不会再触发 onChange
                event.target.value = "";
                if (picked) void doImport(picked);
              }}
            />
            {/* B1（2026-10-07 用户反馈原话：「为什么点击进去后是默认预览，我没说这个不好，只是不习惯，
                应该在设置加一个可以修改的地方」）⚠️ 只管手机端；电脑端笔记本体面板一直是编辑态，不跟着改。 */}
            <Row
              label="打开笔记默认"
              hook="note-open-mode"
              value={config.noteOpenMode === "edit" ? "编辑" : "阅读"}
              hint={config.noteOpenMode === "edit" ? "点开就能直接打字" : "点开先看，想改再点「编辑」"}
              onClick={() =>
                void saveConfig(
                  { noteOpenMode: config.noteOpenMode === "edit" ? "read" : "edit" },
                  "改好了",
                )
              }
            />
            {/* ④（2026-10-11 用户反馈第 4 条）：认知区列表默认折叠方式 —— 点一下切换。
                两端共用 `config.cognitionGroupDefault`（电脑版设置页里有同一项的分段按钮）。 */}
            <Row
              label="认知区默认"
              hook="cog-group-default"
              value={config.cognitionGroupDefault === "collapse-grouped" ? "分类收起" : "全部展开"}
              hint={
                config.cognitionGroupDefault === "collapse-grouped"
                  ? "分好类的收起来，没分类的直接摊开"
                  : "所有笔记都摊开（分好类的也能点一下收起）"
              }
              onClick={() =>
                void saveConfig(
                  {
                    cognitionGroupDefault:
                      config.cognitionGroupDefault === "collapse-grouped" ? "expand" : "collapse-grouped",
                  },
                  "改好了",
                )
              }
            />
          </div>
        </div>

        <p className="px-1 pt-4 text-[10.5px] leading-relaxed text-slate-400">
          电脑上那些手机上没对应东西的设置（数据目录、快捷键、清理、窗口）**不在这里显示** ——
          手机的数据放在应用自己的私有目录里，跟电脑是两份。
        </p>
      </div>

      {/* 主题选择 */}
      {sheet === "theme" && (
        <div data-mset-sheet="theme" className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setSheet(null)}>
          <div className="max-h-[75%] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">主题</p>
            <div className="flex flex-wrap gap-1.5">
              {BASE_MODES.map((one) => (
                <button
                  key={one.key}
                  type="button"
                  data-mset-theme={one.key}
                  onClick={() => {
                    setSheet(null);
                    void saveConfig({ theme: one.key }, "主题换好了");
                  }}
                  className={
                    "rounded-full border px-3 py-1 text-[12px] " +
                    (config.theme === one.key ? "border-indigo-400 text-indigo-600 dark:text-indigo-300" : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                  }
                >
                  {one.label}
                </button>
              ))}
            </div>
            <p className="px-1 pb-1.5 pt-3 text-[11px] text-slate-400">七套配色</p>
            <div className="flex flex-wrap gap-1.5">
              {THEMES.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  data-mset-theme={one.id}
                  onClick={() => {
                    setSheet(null);
                    void saveConfig({ theme: one.id }, "主题换好了");
                  }}
                  className={
                    "rounded-full border px-3 py-1 text-[12px] " +
                    (config.theme === one.id ? "border-indigo-400 text-indigo-600 dark:text-indigo-300" : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                  }
                >
                  {one.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 字号选择 */}
      {sheet === "font" && (
        <div data-mset-sheet="font" className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setSheet(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">字号</p>
            <div className="flex flex-wrap gap-1.5">
              {FONT_STEPS.map((one) => (
                <button
                  key={one.key}
                  type="button"
                  data-mset-font={one.key}
                  onClick={() => {
                    setSheet(null);
                    void saveConfig({ fontSize: one.size }, "字号改好了");
                  }}
                  className={
                    "rounded-full border px-3 py-1 text-[12px] " +
                    (config.fontSize === one.size ? "border-indigo-400 text-indigo-600 dark:text-indigo-300" : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                  }
                >
                  {one.label}（{one.size}）
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 专注两项 */}
      {sheet === "focus" && (
        <div data-mset-sheet="focus" className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setSheet(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-[13px] font-bold">专注</p>
            <p className="px-1 pb-1 text-[11px] text-slate-400">离开多久算走神（分钟）</p>
            <div className="flex flex-wrap gap-1.5">
              {[1, 3, 5, 10, 30, 60].map((one) => (
                <button
                  key={one}
                  type="button"
                  data-mset-away={one}
                  onClick={() => void saveConfig({ focus: { ...config.focus, awayThresholdSeconds: one * 60 } }, "改好了")}
                  className={
                    "rounded-full border px-3 py-1 text-[12px] " +
                    (Math.round(config.focus.awayThresholdSeconds / 60) === one
                      ? "border-indigo-400 text-indigo-600 dark:text-indigo-300"
                      : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                  }
                >
                  {one}
                </button>
              ))}
            </div>
            <p className="px-1 pb-1 pt-3 text-[11px] text-slate-400">自定义番茄时长（分钟，1~999）</p>
            <div className="flex flex-wrap gap-1.5">
              {[15, 25, 45, 60, 90].map((one) => (
                <button
                  key={one}
                  type="button"
                  data-mset-minutes={one}
                  onClick={() => void saveConfig({ focus: { ...config.focus, customMinutes: one } }, "改好了")}
                  className={
                    "rounded-full border px-3 py-1 text-[12px] " +
                    (config.focus.customMinutes === one
                      ? "border-indigo-400 text-indigo-600 dark:text-indigo-300"
                      : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                  }
                >
                  {one}
                </button>
              ))}
            </div>
            <button type="button" data-mset-sheet-close onClick={() => setSheet(null)} className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              收起
            </button>
          </div>
        </div>
      )}

      {/* 同步（M23：手输地址 + 6 位短码；扫码留作以后，协议里本来就把它定为兜底）*/}
      {sheet === "sync" && (
        <div data-mset-sheet="sync" className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setSheet(null)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <MobileSync
              onClose={() => {
                setSheet(null);
                // 同步完回到设置页 → 那行「上次同步」要立刻变成刚才那次（P1-2）
                void refreshLastSync();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
