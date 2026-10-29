import { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import SyncPanel from "../features/sync/SyncPanel";
import PageShell from "../components/PageShell";
import { useData } from "../store/data";
import { useUi } from "../store/ui";
import { BUTTONS, toolbarButtons } from "../features/notes/EditorToolbar";
import type { ToolbarAction } from "../features/notes/format";
import { appInfo, autostartGet, autostartSet, backupExport, backupImport, dataDirOpen, shortcutStatus } from "../features/api";
import { FALLBACK_UI_FONT, FONT_PRESETS, FONT_SIZES } from "../shared/fonts";
import { SOUND_KINDS, SOUND_LABEL, playAlert } from "../shared/sound";
import type { AppInfo, Config, ShortcutStatus, ThemeMode } from "../features/types";
import { THEMES } from "../shared/themes";

const CARD =
  "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900";

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: "light", label: "白天主题" },
  { key: "dark", label: "夜晚主题" },
  { key: "system", label: "跟随系统" },
];

/** 字节数说成人话 */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 唤起小窗的常用候选键（写死几个常见组合，够用且不用做按键录制器）。
 * 顺序 = 建议顺序：`Ctrl+Space` 是 PRD 指定的默认值，其余是"它被占用时的替代"。
 */
const KEY_CANDIDATES = ["Ctrl+Space", "Ctrl+Alt+Space", "Ctrl+Shift+Space", "Ctrl+Alt+M", "F9"];

/**
 * 首页常驻项（PRD §5.5「首页常驻项开关（提醒/单日行程/最近待办）各自可关」）。
 *
 * 「单日行程」依赖第二版的日程功能（PRD §9 红线），第一版只留个位置、
 * 置灰不可点 —— 让用户知道"这里以后有东西"，而不是一片空白。
 *
 * #8（2026-10-21）：加一项「十字待办（四象限）」—— 用户让把执行区那块搬到首页，
 * 并要求跟现有常驻项一样能在设置里关掉。默认开。
 */
const HOME_STICKY_OPTIONS: { key: keyof Config["homeSticky"]; label: string; locked?: boolean }[] = [
  { key: "reminders", label: "提醒" },
  { key: "recentTodos", label: "最近待办（最近 3 个）" },
  { key: "quadrant", label: "十字待办（四象限）" },
  { key: "singleDayItinerary", label: "单日行程（第二版）", locked: true },
];

export default function SettingsPage() {
  const config = useData((s) => s.config);
  /**
   * M15：设置里那张「档案区」卡**平时只显示一行小字**，点了才展开开关
   * （用户定的"不仔细在设置里寻找就无法启用"）。**已经启用的用户直接展开**，
   * 不然每次进设置都要再点一下。
   */
  const [archiveRevealed, setArchiveRevealed] = useState(() => config.archive.enabled);
  const saveConfig = useData((s) => s.saveConfig);
  const refresh = useData((s) => s.refresh);
  const purgeTrash = useData((s) => s.purgeTrash);
  const toast = useUi((s) => s.toast);
  const askConfirm = useUi((s) => s.askConfirm);

  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState("");

  // ── M7：备份 / 快捷键状态 / 关于 ──
  const [backupBusy, setBackupBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [shortcut, setShortcut] = useState<ShortcutStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  // ── M7：字体 / 字号（输入框用本地草稿，失焦或回车才落盘，别每敲一个字写一次文件） ──
  const [uiFontDraft, setUiFontDraft] = useState(config.uiFont ?? "");
  const [bodyFontDraft, setBodyFontDraft] = useState(config.bodyFont ?? "");
  const toolbarActions = toolbarButtons(config.toolbarActions).map((button) => button.action);

  useEffect(() => {
    setUiFontDraft(config.uiFont ?? "");
    setBodyFontDraft(config.bodyFont ?? "");
  }, [config.uiFont, config.bodyFont]);

  const commitFont = (key: "uiFont" | "bodyFont", value: string) => {
    const next = value.trim();
    if (next === (config[key] ?? "")) return;
    void saveConfig({ [key]: next });
  };

  const saveToolbarActions = (next: ToolbarAction[]) => {
    if (next.length === 0) return;
    void saveConfig({ toolbarActions: next });
  };

  const moveToolbarAction = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= toolbarActions.length) return;
    const next = [...toolbarActions];
    [next[index], next[target]] = [next[target], next[index]];
    saveToolbarActions(next);
  };

  const handlePurgeTrash = () => {
    askConfirm({
      title: "清空回收站？",
      // ⚠️ 弹窗文案是纯文本，别写 Markdown 星号
      message:
        "notes/_trash/ 里是以前删掉的笔记（连同它们的 .bak）。清空之后就从回收站找不回来了。\n\n" +
        "不影响现在的笔记，也不影响已经导出的备份。",
      confirmText: "清空",
      danger: true,
      onConfirm: () => void purgeTrash(),
    });
  };

  const reloadAbout = useCallback(async () => {
    try {
      const [status, meta] = await Promise.all([shortcutStatus(), appInfo()]);
      setShortcut(status);
      setInfo(meta);
    } catch (error) {
      toast(`读取程序信息失败：${String(error)}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    void reloadAbout();
  }, [reloadAbout]);

  // ── M10-6：开机自启（`null` = 还没读出来） ──
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const on = await autostartGet();
        if (alive) setAutostart(on);
      } catch (error) {
        if (alive) {
          setAutostart(false);
          toast(`读开机自启状态失败：${String(error)}`, "error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [toast]);

  /** 开/关开机自启：界面按系统回读的真实状态显示（用户可能在任务管理器里改过） */
  const handleAutostart = async (next: boolean) => {
    try {
      const real = await autostartSet(next);
      setAutostart(real);
      toast(real ? "已设成开机自启（自启时直接收进托盘）" : "已关掉开机自启", "success");
    } catch (error) {
      toast(`设置开机自启失败：${String(error)}`, "error");
    }
  };

  /** 换一个唤起小窗的快捷键（`config_save` 里会顺手重注册，所以立即生效） */
  const handlePickKey = async (key: string) => {
    const ok = await saveConfig({ shortcuts: { ...config.shortcuts, toggleSmallWindow: key } });
    if (ok) await reloadAbout();
  };

  /** 导出备份：先让用户挑路径，挑完再导出 */
  const handleExportBackup = async () => {
    setBackupBusy(true);
    try {
      const dest = await saveDialog({
        title: "导出备份到…",
        defaultPath: `笔记备份-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
      });
      if (!dest) return; // 用户取消了
      const report = await backupExport(dest);
      toast(`已导出 ${report.files} 个文件（${humanBytes(report.bytes)}）`, "success");
    } catch (error) {
      toast(`导出备份失败：${String(error)}`, "error");
    } finally {
      setBackupBusy(false);
    }
  };

  /** 导入备份：先选包 → 二次确认 → 恢复 → 重新加载界面 */
  const handleImportBackup = async () => {
    try {
      const picked = await openDialog({
        title: "选择备份包（.zip）",
        multiple: false,
        filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
      });
      if (!picked) return; // 取消了
      const src = Array.isArray(picked) ? picked[0] : picked;
      if (!src) return;

      askConfirm({
        title: "用这个备份覆盖当前数据？",
        // ⚠️ 弹窗文案是**纯文本**，别在这里写 Markdown 星号（会原样显示出来）
        message:
          `「${src}」里的内容会覆盖现在的信息、笔记、待办和设置（附件也一并覆盖）。\n\n` +
          "程序会先把当前数据自动备份一份放进 backups/，万一后悔还能导回来。",
        confirmText: "覆盖恢复",
        danger: true,
        onConfirm: () => {
          setImporting(true);
          void (async () => {
            try {
              const report = await backupImport(src);
              await refresh();
              await reloadAbout();
              toast(`已恢复 ${report.files} 个文件；覆盖前的数据已留档`, "success");
            } catch (error) {
              toast(`导入备份失败：${String(error)}`, "error");
            } finally {
              setImporting(false);
            }
          })();
        },
      });
    } catch (error) {
      toast(`打开备份包失败：${String(error)}`, "error");
    }
  };

  const dataDirText = config.dataDir || "（浏览器预览模式：数据目录不可用）";

  const handleOpenDir = async () => {
    setOpening(true);
    try {
      await dataDirOpen();
      toast("已打开数据目录", "success");
    } catch (error: unknown) {
      toast(`打开数据目录失败：${String(error)}`, "error");
    } finally {
      setOpening(false);
    }
  };

  const handleTheme = (next: ThemeMode) => {
    if (next === config.theme) return;
    void saveConfig({ theme: next });
  };

  const handleSaveNow = async () => {
    setSaving(true);
    try {
      await saveConfig({}, "设置已保存到 config.json");
    } finally {
      setSaving(false);
    }
  };

  const startEditDir = () => {
    setDirDraft(config.dataDir);
    setEditingDir(true);
  };

  const handleSwitchDir = () => {
    const target = dirDraft.trim();
    if (!target) {
      toast("先填一个目录路径", "info");
      return;
    }
    if (target === config.dataDir) {
      setEditingDir(false);
      return;
    }
    askConfirm({
      title: "切换数据目录？",
      message: `现有数据会复制到「${target}」，原目录不会被删除；目标目录里已有的同名文件不会被覆盖。切换后程序立刻改用新目录。`,
      confirmText: "切换",
      onConfirm: () => {
        void (async () => {
          const ok = await saveConfig({ dataDir: target });
          if (!ok) return;
          await refresh();
          setEditingDir(false);
          toast("已切换数据目录", "success");
        })();
      },
    });
  };

  return (
    <PageShell
      title="设置"
      subtitle="数据目录、外观、快捷键、提醒开关"
      note="摩耶，意为幻象"
      badge="M1 / M7"
    >
      <div className="flex max-w-3xl flex-col gap-4">
        {/* M22：同步（手机 ↔ 电脑）—— 设计稿 .spike\M17-sync-entry.html，用户已过目「放设置页里」 */}
        <section className={CARD} data-settings-sync>
          <h2 className="text-sm font-semibold">同步（手机 ↔ 电脑）</h2>
          <div className="mt-3">
            <SyncPanel />
          </div>
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-semibold">数据目录</h2>
          <p className="mt-1 text-xs text-slate-400">
            所有信息、笔记、图片、备份都存在这里。切换目录时数据会被
            <strong className="font-medium text-slate-500 dark:text-slate-300">复制</strong>
            过去，原目录保留不删。
          </p>
          <div className="mt-4 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xl bg-slate-100 px-3 py-2 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {dataDirText}
            </code>
            <button
              type="button"
              onClick={() => void handleOpenDir()}
              disabled={opening}
              className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {opening ? "打开中…" : "打开目录"}
            </button>
            {!editingDir && (
              <button
                type="button"
                onClick={startEditDir}
                className="shrink-0 rounded-xl px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                更改…
              </button>
            )}
          </div>

          {editingDir && (
            <div className="mt-3 flex items-center gap-2">
              <input
                value={dirDraft}
                onChange={(event) => setDirDraft(event.target.value)}
                spellCheck={false}
                placeholder="D:\新的数据目录"
                className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-400 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
              />
              <button
                type="button"
                onClick={handleSwitchDir}
                className="shrink-0 rounded-xl bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600"
              >
                切换
              </button>
              <button
                type="button"
                onClick={() => setEditingDir(false)}
                className="shrink-0 rounded-xl px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                取消
              </button>
            </div>
          )}
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-semibold">外观</h2>
          <p className="mt-1 text-xs text-slate-400">
            白天（6:00–18:00）用哥尔赞、其余时间用美尔巴；窗口与任务栏图标由程序按时间自动切换。
          </p>
          <div className="mt-4 inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => handleTheme(option.key)}
                className={`rounded-lg px-4 py-1.5 text-sm transition-colors ${
                  config.theme === option.key
                    ? "bg-white font-medium text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            主题存在 config.json 里，关掉重开还记得。
          </p>

          {/* ── M16-B：七套配色（用户 2026-09-26 给的色号；"做给别人用的"） ── */}
          <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              七套配色（做给别人用的）
            </p>
            <p className="mt-1 text-xs text-slate-400">
              主色当强调色、副色当底色；点一下就换。**上面那三档（浅色 / 深色 / 跟随系统）一直都在**，
              点它们就切回来 —— 你自己那套深色没被并进来。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {THEMES.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  data-theme-option={one.id}
                  onClick={() => handleTheme(one.id)}
                  title={one.desc}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs ${
                    config.theme === one.id
                      ? "border-indigo-400 ring-1 ring-indigo-300 dark:border-indigo-500"
                      : "border-slate-200 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                  }`}
                >
                  <span
                    className="h-4 w-4 shrink-0 rounded-full border border-black/10"
                    style={{ background: `linear-gradient(135deg, ${one.accent} 0 55%, ${one.tint} 55% 100%)` }}
                  />
                  <span className="text-slate-600 dark:text-slate-300">{one.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── 字体与字号（PRD §5.5「外观」） ── */}
          <div className="mt-5 flex flex-col gap-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">界面字体</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  data-font-ui
                  value={uiFontDraft}
                  onChange={(event) => setUiFontDraft(event.target.value)}
                  onBlur={() => commitFont("uiFont", uiFontDraft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitFont("uiFont", uiFontDraft);
                  }}
                  placeholder={`留空 = 默认（${FALLBACK_UI_FONT}）`}
                  className="w-56 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
                />
                {FONT_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    data-font-ui-preset={preset.value || "default"}
                    onClick={() => void saveConfig({ uiFont: preset.value })}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                正文字体（编辑器与预览；留空 = 跟着界面字体）
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  data-font-body
                  value={bodyFontDraft}
                  onChange={(event) => setBodyFontDraft(event.target.value)}
                  onBlur={() => commitFont("bodyFont", bodyFontDraft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitFont("bodyFont", bodyFontDraft);
                  }}
                  placeholder="留空 = 跟着界面字体"
                  className="w-56 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-500 dark:focus:bg-slate-800"
                />
                {FONT_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    data-font-body-preset={preset.value || "default"}
                    onClick={() => void saveConfig({ bodyFont: preset.value })}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">字号</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {FONT_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    data-font-size={size}
                    onClick={() => void saveConfig({ fontSize: size })}
                    className={`rounded-lg border px-3 py-1 text-xs ${
                      config.fontSize === size
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                        : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                    }`}
                  >
                    {size}px
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                设完立刻生效（不用重启）。字体名带空格（比如 Microsoft YaHei）也没关系，程序会自动加引号。
              </p>
            </div>
          </div>
        </section>

        <section className={CARD} data-settings-toolbar>
          <h2 className="text-sm font-semibold">编辑辅助栏</h2>
          <p className="mt-1 text-xs text-slate-400">
            电脑和手机的 Markdown 按钮共用这一套顺序与显隐。撤销、重做、插图是固定能力，始终保留。
            鼠标停在按钮上仍会显示它会插入什么语法。
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {toolbarActions.map((action, index) => {
              const button = BUTTONS.find((one) => one.action === action);
              if (!button) return null;
              return (
                <div
                  key={action}
                  data-toolbar-config-row={action}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700"
                >
                  <span className="min-w-10 rounded-lg bg-slate-100 px-2 py-1 text-center font-mono text-xs dark:bg-slate-800">
                    {button.label}
                  </span>
                  <span className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400">
                    {button.hint}
                  </span>
                  <button
                    type="button"
                    data-toolbar-up={action}
                    disabled={index === 0}
                    onClick={() => moveToolbarAction(index, -1)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-slate-600"
                    aria-label="向前移动"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-toolbar-down={action}
                    disabled={index === toolbarActions.length - 1}
                    onClick={() => moveToolbarAction(index, 1)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-slate-600"
                    aria-label="向后移动"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    data-toolbar-remove={action}
                    disabled={toolbarActions.length <= 1}
                    onClick={() => saveToolbarActions(toolbarActions.filter((one) => one !== action))}
                    className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-30 dark:border-rose-500/40 dark:text-rose-300"
                    aria-label="从辅助栏移除"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">可添加的按钮</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {BUTTONS.filter((button) => !toolbarActions.includes(button.action)).map((button) => (
                <button
                  key={button.action}
                  type="button"
                  data-toolbar-add={button.action}
                  title={button.hint}
                  onClick={() => saveToolbarActions([...toolbarActions, button.action])}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  ＋ {button.label}
                </button>
              ))}
              {toolbarActions.length === BUTTONS.length && (
                <span className="py-1.5 text-xs text-slate-400">全部按钮都已经在栏里。</span>
              )}
            </div>
          </div>

          <button
            type="button"
            data-toolbar-reset
            onClick={() => saveToolbarActions(BUTTONS.map((button) => button.action))}
            className="mt-4 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            恢复默认顺序
          </button>
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-semibold">保存</h2>
          <p className="mt-1 text-xs text-slate-400">
            设置改动都会立刻写入 <code className="font-mono">config.json</code>
            （每次保存保留上一版 <code className="font-mono">config.json.bak</code>）。这里给一个手动保存的按钮，图个安心。
          </p>
          <button
            type="button"
            onClick={() => void handleSaveNow()}
            disabled={saving}
            className="mt-4 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {saving ? "保存中…" : "立即保存"}
          </button>
        </section>

        {/* ── M7：清理（回收站） ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">清理</h2>
          <p className="mt-1 text-xs text-slate-400">
            删除笔记是「挪到回收站」（<code className="font-mono">notes/_trash/</code>
            ）而不是真删 —— 这是"留后路"，但也意味着它会越堆越多。这里给它一个清理入口。
          </p>
          <button
            type="button"
            data-trash-purge
            onClick={handlePurgeTrash}
            className="mt-4 rounded-xl border border-rose-300 px-4 py-2 text-sm text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
          >
            清空回收站
          </button>
          <p className="mt-2 text-xs text-slate-400">
            清空之后那些笔记就找不回来了（点的时候会先问你一次）。已经导出的备份不受影响 ——
            备份里本来就不含回收站。
          </p>
        </section>

        {/* ── M7：首页常驻项（PRD §5.5 / 10.6 第 2 条） ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">首页常驻项</h2>
          <p className="mt-1 text-xs text-slate-400">
            首页的常驻项（左边动态区 ＋ 右边十字待办）。关掉某一项，首页就不再显示它（提醒和最近待办在那类内容为空时，本来也不显示）。
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {HOME_STICKY_OPTIONS.map((item) => (
              <label key={item.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-home-sticky={item.key}
                  checked={config.homeSticky[item.key]}
                  disabled={item.locked}
                  onChange={(event) =>
                    void saveConfig({
                      homeSticky: { ...config.homeSticky, [item.key]: event.target.checked },
                    })
                  }
                  className="h-4 w-4 accent-indigo-600 disabled:opacity-40"
                />
                <span className={item.locked ? "text-slate-400" : ""}>{item.label}</span>
              </label>
            ))}
          </div>
        </section>

        {/* ── M7：提醒开关（PRD §5.5） ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">提醒</h2>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-reminder-toggle
              checked={config.reminders.infoStaleEnabled}
              onChange={(event) =>
                void saveConfig({
                  reminders: { ...config.reminders, infoStaleEnabled: event.target.checked },
                })
              }
              className="h-4 w-4 accent-indigo-600"
            />
            <span>信息放了 {config.reminders.infoStaleMinutes} 分钟还没联动，就提醒我</span>
          </label>
          <p className="mt-2 text-xs text-slate-400">
            只影响「信息放久了」这一类。待办自己的「再次设定时间提醒」不受这个开关影响。
          </p>
          <p className="mt-1 text-xs text-slate-400">
            提醒只在应用内出现（顶部横幅 + 首页动态区），关掉程序就不会响 —— 系统通知第一版不做。
          </p>

          {/* ───────── C 批（2026-10-02）：提示音 ─────────
              用户脑图第 4 条：「要有更明显的闹钟声音，要可以自由设置音效」。
              声音是**现场合成**的（`shared/sound.ts`），没有音频文件、不联网。 */}
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800" data-settings-sound>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-500 dark:text-slate-400">提示音</span>
              <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                {SOUND_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    data-sound-option={kind}
                    onClick={() => {
                      void saveConfig({
                        reminders: { ...config.reminders, soundKind: kind },
                      });
                      // 点一下就试听 —— 不然他得等 45 分钟才知道这档是啥声
                      playAlert(kind, config.reminders.soundVolume, config.reminders.soundTimes);
                    }}
                    className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                      config.reminders.soundKind === kind
                        ? "bg-white font-medium text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300"
                        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    {SOUND_LABEL[kind]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-sound-test
                onClick={() =>
                  playAlert(
                    config.reminders.soundKind,
                    config.reminders.soundVolume,
                    config.reminders.soundTimes,
                  )
                }
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                🔔 试听
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400">音量</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  data-sound-volume
                  value={config.reminders.soundVolume}
                  onChange={(event) =>
                    void saveConfig({
                      reminders: { ...config.reminders, soundVolume: Number(event.target.value) },
                    })
                  }
                  className="w-32 accent-indigo-600"
                />
                <span className="w-8 font-mono text-xs text-slate-400">
                  {config.reminders.soundVolume}
                </span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400">响几声</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  data-sound-times
                  value={config.reminders.soundTimes}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value));
                    if (!Number.isFinite(value)) return;
                    void saveConfig({
                      reminders: {
                        ...config.reminders,
                        soundTimes: Math.max(1, Math.min(5, value)),
                      },
                    });
                  }}
                  className="w-16 rounded-lg border border-slate-300 bg-transparent px-2 py-1 text-center outline-none focus:border-indigo-400 dark:border-slate-600 dark:text-slate-100"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              声音是程序自己合成的（不联网、不带音频文件）。选「静音」就一点声都不出。
            </p>
          </div>
        </section>

        {/* ── M13-B：专注（番茄钟的"意外中断"）── */}
        <section className={CARD} data-settings-focus>
          <h2 className="text-sm font-semibold">专注</h2>
          <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>多久没动键鼠算「疑似离开」</span>
            <input
              type="number"
              min={1}
              max={86400}
              data-focus-threshold
              value={config.focus.awayThresholdSeconds}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                if (!Number.isFinite(value)) return;
                void saveConfig({
                  focus: {
                    ...config.focus,
                    awayThresholdSeconds: Math.max(1, Math.min(86400, value)),
                  },
                });
              }}
              className="w-20 rounded-lg border border-slate-300 bg-transparent px-2 py-1 text-center outline-none focus:border-indigo-400 dark:border-slate-600 dark:text-slate-100"
            />
            <span>秒</span>
          </label>
          <p className="mt-1 text-xs text-slate-400">
            超过这个时间没动键鼠 → 番茄钟**继续走**，但这次会被标成"疑似离开"并累计时长。
            <br />
            🔴 单纯"没操作"**永远不会**自动暂停（你 2026-09-26 定的）—— 只有下面两种才算暂停。
          </p>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-focus-pause-lock
              checked={config.focus.pauseOnLock}
              onChange={(event) =>
                void saveConfig({
                  focus: { ...config.focus, pauseOnLock: event.target.checked },
                })
              }
              className="h-4 w-4 accent-indigo-600"
            />
            <span>锁屏 / 电脑休眠时自动暂停</span>
          </label>
          <p className="mt-1 text-xs text-slate-400">
            暂停那段时间**不算专注**（回来会问你「继续吗」，点了才接着走）。
          </p>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-focus-ask-finish
              checked={config.focus.askOnFinish}
              onChange={(event) =>
                void saveConfig({
                  focus: { ...config.focus, askOnFinish: event.target.checked },
                })
              }
              className="h-4 w-4 accent-indigo-600"
            />
            <span>番茄结束时问我「计入 / 作废」</span>
          </label>
          <p className="mt-1 text-xs text-slate-400">
            关掉的话：有疑似离开也默认按「计入」记，不再打断你。
            <br />
            不管选哪个，这次番茄都会被记下来、进日历和日报 —— 「作废」只是不计入有效专注，
            并在待办上留一个「⚠ 中断 N 次」的记号。
          </p>

          {/* ───────── 2026-10-05（v1.14.0）：用户点名的"在这里预设自定义时长" ─────────
              原话：「可以在小齿轮那里设置自定义时间，不必再开始之后再设置」。
              ⚠️ 它只是**预设起点**：番茄面板里照样能改这一场的时长（改的是这一场，不动设置）。 */}
          <label className="mt-3 flex flex-wrap items-center gap-2 text-sm" data-settings-custom-minutes>
            <span>自定义番茄时长</span>
            <input
              type="number"
              min={1}
              max={999}
              data-focus-custom-minutes
              value={config.focus.customMinutes}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                if (!Number.isFinite(value)) return;
                void saveConfig({
                  focus: {
                    ...config.focus,
                    customMinutes: Math.max(1, Math.min(999, value)),
                  },
                });
              }}
              className="w-20 rounded-lg border border-slate-300 bg-transparent px-2 py-1 text-center outline-none focus:border-indigo-400 dark:border-slate-600 dark:text-slate-100"
            />
            <span>分钟</span>
          </label>
          <p className="mt-1 text-xs text-slate-400">
            番茄面板一打开就按这个时长开始，**不用每场再进去输一遍**（面板里仍然可以临时改；
            它也会单独占一个时长档位，标着 ★）。
          </p>

          {/* ───────── C 批（2026-10-02）：工作中的定时提示 ─────────
              用户脑图第 8 条：「执行区、工作时间进行时，随机时间弹出提醒我」。
              ⚠️ 我按**固定间隔**做（随机间隔没法预判），提示**只出现在专注小窗上**，默认关。 */}
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800" data-settings-workprompt>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-work-prompt-toggle
                checked={config.focus.workPromptEnabled}
                onChange={(event) =>
                  void saveConfig({
                    focus: { ...config.focus, workPromptEnabled: event.target.checked },
                  })
                }
                className="h-4 w-4 accent-indigo-600"
              />
              <span>专注中每隔几分钟提醒我一句</span>
            </label>
            <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-500 dark:text-slate-400">间隔</span>
              <input
                type="number"
                min={1}
                max={600}
                data-work-prompt-minutes
                value={config.focus.workPromptMinutes}
                onChange={(event) => {
                  const value = Math.round(Number(event.target.value));
                  if (!Number.isFinite(value)) return;
                  void saveConfig({
                    focus: {
                      ...config.focus,
                      workPromptMinutes: Math.max(1, Math.min(600, value)),
                    },
                  });
                }}
                className="w-20 rounded-lg border border-slate-300 bg-transparent px-2 py-1 text-center outline-none focus:border-indigo-400 dark:border-slate-600 dark:text-slate-100"
              />
              <span className="text-slate-500 dark:text-slate-400">分钟</span>
            </label>
            <p className="mt-2 text-xs text-slate-400">
              提示**只出现在右下角那个专注小窗上**（不弹窗、不打断、也不写进数据）——
              会显示已经专注了多久。暂停期间不提示。
            </p>
          </div>
        </section>

        {/* ── M14/M15：档案区（批注栏 + 档案库都属于它）── */}
        {/* 🔴 用户 2026-09-26 定的形态：「不仔细在设置里寻找就无法启用」→ **先只写一行小字，
            点开才出现开关**（2026-09-27 照这个改；原来直接摆了一个开关） */}
        <section className={CARD} data-settings-archive>
          <h2 className="text-sm font-semibold">档案区</h2>
          {!archiveRevealed ? (
            <button
              type="button"
              data-archive-reveal
              onClick={() => setArchiveRevealed(true)}
              className="mt-3 w-full rounded-xl border border-dashed border-slate-300 px-4 py-3 text-left text-sm text-slate-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-400 dark:hover:border-indigo-500 dark:hover:text-indigo-300"
            >
              给「<b>已经被遗忘、今后必将遗忘</b>」的东西留一间屋子。
              <span className="mt-1 block text-[11.5px] text-slate-400">想启用的话，点这行字 →</span>
            </button>
          ) : (
            <>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-archive-toggle
                  checked={config.archive.enabled}
                  onChange={(event) =>
                    void saveConfig({ archive: { enabled: event.target.checked } })
                  }
                  className="h-4 w-4 accent-indigo-600"
                />
                <span>启用档案区（侧栏出现「档案库」；认知区出现「批注」页签）</span>
              </label>
              <p className="mt-1 text-xs text-slate-400">
                打开后：**侧栏多出第七个区「档案库」** —— 收纳那些"已经被遗忘、今后必将遗忘"的东西，
                随时能取出回到原来的区；同时认知区右侧会多一个「批注」页签（给正文里某一句写评价，
                **正文一个字都不会被改**）。
                <br />
                关掉的话两样入口都会消失，但**数据都还在**（`archive.json` / `annotations.json` 不会被删）。
              </p>
            </>
          )}
        </section>

        {/* ── M7：备份 ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">备份</h2>
          <p className="mt-1 text-xs text-slate-400">
            导出会把 info.jsonl、notes/、todos.json、reminders.json、config.json、assets/
            打成一个 zip —— 换电脑、或者怕出事，就导一份放着。
            （回收站 notes/_trash/ 与 backups/ 不进备份。）
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-backup-export
              disabled={backupBusy}
              onClick={() => void handleExportBackup()}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {backupBusy ? "导出中…" : "导出备份"}
            </button>
            <button
              type="button"
              data-backup-import
              disabled={importing}
              onClick={() => void handleImportBackup()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {importing ? "恢复中…" : "导入备份"}
            </button>
          </div>
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            导入是「覆盖」：它会用备份包里的内容替换现在的数据。所以点它之前会先问你一次，
            而且程序会先把当前数据自动备份一份（放进 backups/），万一后悔还能导回来。
          </p>
        </section>

        {/* ── M7：快捷键 ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">快捷键</h2>
          <p className="mt-1 text-xs text-slate-400">
            唤起「速记」小窗的全局快捷键。小窗能在任何界面弹出，写的东西会存成一篇文本笔记。
            <br />
            ⚠️ <strong>2026-10-13 起语义变了</strong>：<strong>再按一次＝再开一个</strong>（最多同时
            5 个）—— 以前是「开着就收、没开就弹」，按第二下会把小窗收走。
            想收起来：按小窗自己的 <kbd>Esc</kbd>、点它标题栏那颗收起键，或者
            <strong>托盘菜单 →「收起所有速记窗」</strong>。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {KEY_CANDIDATES.map((key) => {
              const active = shortcut?.accelerator === key;
              return (
                <button
                  key={key}
                  type="button"
                  data-shortcut-key={key}
                  onClick={() => void handlePickKey(key)}
                  className={`rounded-lg border px-3 py-1.5 font-mono text-xs ${
                    active
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {key}
                  {key === shortcut?.default ? "（默认）" : ""}
                </button>
              );
            })}
          </div>
          {shortcut && (
            <p
              data-shortcut-state={shortcut.registered ? "ok" : "blocked"}
              className={`mt-3 text-xs ${
                shortcut.registered
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {shortcut.registered
                ? `现在用的是「${shortcut.accelerator}」，系统已经接受了这个键。`
                : `现在配的是「${shortcut.accelerator}」，但系统没接受它 —— 多半被输入法或别的程序占用了（Ctrl+Space 常被输入法拿去切全角/半角）。换一个试试，点上面的按钮就行，改完立刻生效。`}
            </p>
          )}

          {/* B4（2026-09-21 用户拍板）：小窗出现在哪儿 */}
          <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
            <h3 className="text-sm font-semibold">小窗出现在哪儿</h3>
            <p className="mt-1 text-xs text-slate-400">
              「跟随鼠标」= 鼠标在屏幕哪儿，小窗就在那儿附近弹出来（写东西时视线不用跑）。
              「屏幕正中」= 每次都弹在屏幕中间，位置固定、心里有数。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  { key: "center", label: "屏幕正中" },
                  { key: "mouse", label: "跟随鼠标" },
                ] as const
              ).map((option) => {
                const active = (config.window?.smallPosition ?? "center") === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    data-small-position={option.key}
                    onClick={() => void saveConfig({ window: { ...config.window, smallPosition: option.key } })}
                    className={`rounded-lg border px-3 py-1.5 text-xs ${
                      active
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                        : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── E 批（2026-10-03）：桌面挂件 ──
            用户脑图第 6 条：「类似 widget 的常驻展示……随时随地能看到格言、待办、日课的效果」。
            他点头的方向：中号 + 普通置顶 + 与专注小窗不合并。 */}
        {/* ④（2026-10-11 用户反馈第 4 条）认知区列表的默认折叠方式 ——
            用户原话：「认知区打开后一大堆笔记……能不能设一个机制，可以去设置里调整是否默认把笔记
            收成文件夹形式（还有一种愿景，我希望分好类的笔记收进文件夹，没分类的笔记就打开）」
            ⚠️ 手机设置页里有同一项（`data-mset-row="cog-group-default"`），**两端共用这一个值**。 */}
        <section className={CARD} data-settings-cog-group>
          <h2 className="text-sm font-semibold">认知区默认怎么摆</h2>
          <p className="mt-1 text-xs text-slate-400">
            「全部展开」= 打开认知区所有笔记都摊开（一直是这样的）。
            「分类收起」= **分好类的收进文件夹、没分类的直接摊开**；
            你在列表上点过一次折叠/展开之后，这一次会话就听你点的（重开程序才回到这里设的默认）。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                { key: "expand", label: "全部展开（默认）" },
                { key: "collapse-grouped", label: "分类收起" },
              ] as const
            ).map((option) => {
              const active = (config.cognitionGroupDefault ?? "expand") === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  data-cog-group-default={option.key}
                  onClick={() => void saveConfig({ cognitionGroupDefault: option.key })}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    active
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </section>

        <section className={CARD} data-settings-widget>
          <h2 className="text-sm font-semibold">桌面挂件</h2>
          <p className="mt-1 text-xs text-slate-400">
            在桌面上贴一块常驻的小窗，随手就能看见<b>今天这一句格言</b>和<b>今天要干的事</b>。
            <br />
            ⚠️ 它跟「专注小窗」是两回事：专注小窗是<b>番茄钟开始时才出现</b>；挂件是
            <b>你想让它在就一直在</b>（不专注的时候也在）。
          </p>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-widget-toggle
              checked={config.widget.enabled}
              onChange={(event) =>
                void saveConfig({ widget: { ...config.widget, enabled: event.target.checked } })
              }
              className="h-4 w-4 accent-indigo-600"
            />
            <span>显示桌面挂件</span>
          </label>

          {/* 尺寸 */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500 dark:text-slate-400">尺寸</span>
            {(
              [
                { key: "small", label: "小（只格言）" },
                { key: "mid", label: "中（格言 + 待办 + 番茄）" },
                { key: "big", label: "大（再加时钟与信息）" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                data-widget-size={option.key}
                onClick={() => void saveConfig({ widget: { ...config.widget, size: option.key } })}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  config.widget.size === option.key
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                    : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* 显示哪几格 */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-500 dark:text-slate-400">显示</span>
            {(
              [
                { key: "motto", label: "格言" },
                { key: "todos", label: "今日待办" },
                { key: "pomodoro", label: "番茄" },
                { key: "info", label: "信息" },
                { key: "clock", label: "时钟" },
                // 2026-10-04：倒计时（目标日 + 一句话 → 挂件上显示「还有 N 天」）
                { key: "countdown", label: "倒计时" },
              ] as const
            ).map((slot) => {
              const on = config.widget.show.includes(slot.key);
              return (
                <label key={slot.key} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    data-widget-slot-toggle={slot.key}
                    checked={on}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...config.widget.show, slot.key]
                        : config.widget.show.filter((one) => one !== slot.key);
                      void saveConfig({ widget: { ...config.widget, show: next } });
                    }}
                    className="h-3.5 w-3.5 accent-indigo-600"
                  />
                  <span className="text-slate-600 dark:text-slate-300">{slot.label}</span>
                </label>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-slate-400">
            挂件上那条<b>空白标题栏可以拖</b>，拖到哪儿下次还在那儿；右上角 ✕ 只是把它收起来
            （这里的开关状态不变）。托盘右键菜单里也有「显示/隐藏挂件」。
          </p>
        </section>

        {/* ── M10-3：关闭窗口时（收进托盘 / 直接退出） ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">关闭窗口时</h2>
          <p className="mt-1 text-xs text-slate-400">
            「收进托盘」= 点窗口右上角的 ✕ 不退出程序，只是躲到右下角通知区（这样 Ctrl+Space
            和到点提醒才继续活着）。想真正退出，用托盘图标的右键菜单「退出」，或者左下角那个 quit。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                { key: true, label: "收进托盘（默认）" },
                { key: false, label: "直接退出" },
              ] as const
            ).map((option) => {
              const active = (config.window?.closeToTray ?? true) === option.key;
              return (
                <button
                  key={String(option.key)}
                  type="button"
                  data-close-to-tray={option.key ? "yes" : "no"}
                  onClick={() =>
                    void saveConfig({ window: { ...config.window, closeToTray: option.key } })
                  }
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    active
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* ── M10-6：开机自启 ── */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">开机自启</h2>
          <p className="mt-1 text-xs text-slate-400">
            打开后，开机时会自动把东方摩耶堂拉起来，并且直接收进托盘（不弹窗口）——
            这样 Ctrl+Space 和到点提醒一开机就都在。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(
              [
                { key: true, label: "开机自启" },
                { key: false, label: "不开机自启" },
              ] as const
            ).map((option) => {
              const active = autostart === option.key;
              return (
                <button
                  key={String(option.key)}
                  type="button"
                  data-autostart={option.key ? "on" : "off"}
                  onClick={() => void handleAutostart(option.key)}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    active
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                      : "border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
            {autostart === null && <span className="text-xs text-slate-400">读取中…</span>}
          </div>
        </section>

        {/* ── M7：关于 ── */}
        <section className={CARD}>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">关于</h2>
            <button
              type="button"
              onClick={() => void reloadAbout()}
              className="ml-auto rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              刷新统计
            </button>
          </div>
          {info ? (
            <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-slate-400">名称 / 版本</p>
                <p className="mt-0.5">
                  {info.name} <span data-about-version className="font-mono">{info.version}</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400">信息</p>
                <p data-about-infos className="mt-0.5">{info.infoCount} 条</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">笔记</p>
                <p data-about-notes className="mt-0.5">{info.noteCount} 篇</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">待办</p>
                <p data-about-todos className="mt-0.5">{info.todoCount} 条</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">附件</p>
                <p className="mt-0.5">
                  {info.assetCount} 个 · {humanBytes(info.assetBytes)}
                </p>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <p className="text-xs text-slate-400">数据目录</p>
                <p className="mt-0.5 truncate font-mono text-xs" title={info.dataDir}>
                  {info.dataDir}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-400">读取中…</p>
          )}
        </section>

        {/* 2026-09-22 小改动：页面最下面这三行（用户指定的句子，居中、与副标题同字号） */}
        <p
          data-settings-motto
          className="mt-2 whitespace-pre-line text-center text-sm text-slate-500 dark:text-slate-400"
        >
          {"信息是摩耶，认知是清醒，执行是选择。\n每一次执行，又生成新的信息，进入下一轮摩耶。\n而你，始终在堂中。"}
        </p>
      </div>
    </PageShell>
  );
}
