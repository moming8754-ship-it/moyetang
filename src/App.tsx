import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { listen } from "@tauri-apps/api/event";
import Sidebar from "./components/Sidebar";
import Toast from "./components/Toast";
import ConfirmDialog from "./components/ConfirmDialog";
import ReminderBanner from "./components/ReminderBanner";
import { notifyOutsideApp } from "./shared/systemNotify";
import { firstLine } from "./shared/reminderText";
import HomePage from "./pages/HomePage";
import InfoPage from "./pages/InfoPage";
import CognitionPage from "./pages/CognitionPage";
import TodoPage from "./pages/TodoPage";
import SchedulePage from "./pages/SchedulePage";
import SkillPage from "./pages/SkillPage";
import SettingsPage from "./pages/SettingsPage";
import ArchivePage from "./pages/ArchivePage";
// M18（v2.1.0）：手机外壳（真机 或 开发模式下的强制手机布局开关）
import MobileShell from "./mobile/MobileShell";
import { isMobileEnv, isMobilePreview } from "./mobile/platform";
import PomodoroPanel from "./features/todos/Pomodoro";
import { applyTheme, useUi } from "./store/ui";
import type { ViewKey } from "./store/ui";
import { useData } from "./store/data";
import { useFocusSession } from "./store/focusSession";
import {
  focusMonitorState,
  focusMonitorStop,
  focusWindowClose,
  mainShow,
  notesImportAndroidPending,
} from "./features/api";
import {
  clearFocusNumbers,
  readLiveSession,
  rememberFocusNumbers,
  type FocusNumbers,
} from "./store/focusNumbers";
import { applyFonts } from "./shared/fonts";
import { useAlertSound } from "./shared/useAlertSound";
import { isDaytime, formatDateTime, logoSrc, useClock } from "./shared/daytime";
import { appInfo, iconRefresh, inTauri } from "./features/api";

/** 视图切换：不引路由库，用 Zustand 里的 view 直接映射页面（够快、够简单） */
const PAGES: Record<ViewKey, ComponentType> = {
  home: HomePage,
  info: InfoPage,
  cognition: CognitionPage,
  todo: TodoPage,
  schedule: SchedulePage,
  skill: SkillPage,
  settings: SettingsPage,
  // M15：档案库（导航里默认不出现，设置里启用「档案区」才有入口）
  archive: ArchivePage,
};

/**
 * 重载后"算不算被挂起过"的判据（秒）。
 *
 * 比 Rust 那边的 `SLEEP_GAP_SECONDS = 3` 松一点：正常的页面重载本身要一两秒，
 * 拿 3 秒去卡会把每一次普通重载都记成"休眠暂停"；5 秒以上才认定"这段时间机器睡了 / 被挂起了"。
 * ⚠️ 判错的代价是不对称的：**多记一点暂停**只是数字偏保守，**少记**就是用户的时间白丢（用户明确的红线）。
 */
const RESTORE_SUSPEND_GAP_SECONDS = 5;

export default function App() {
  const view = useUi((s) => s.view);
  const theme = useUi((s) => s.theme);
  const setView = useUi((s) => s.setView);
  const refresh = useData((s) => s.refresh);
  const config = useData((s) => s.config);
  const notes = useData((s) => s.notes);
  const infos = useData((s) => s.infos);
  const setFocusRef = useData((s) => s.setFocusRef);
  const addPomodoro = useData((s) => s.addPomodoro);
  /** B 批：谁在专注（`null` = 没有会话，面板不显示） */
  const focusTodo = useFocusSession((s) => s.todo);
  const stopFocusSession = useFocusSession((s) => s.stop);
  const resumeFocusSession = useFocusSession((s) => s.resume);
  const todos = useData((s) => s.todos);
  /**
   * v1.14.1：开机把"上一次没结束的那一场专注"接回来。
   * `null` = 没有要接的（正常情况）；有值时交给面板恢复锚点/时长/暂停状态。
   */
  const [focusRestore, setFocusRestore] = useState<{
    record: FocusNumbers;
    rustAlive: boolean;
  } | null>(null);
  /** 只尝试恢复一次（数据到位后才行，见下面那个 effect） */
  const restoreTriedRef = useRef(false);
  const now = useClock();
  /** 收到 Rust 的 icon-changed 时 +1：让"白天/夜晚"立刻重算，不必等下一次 30s 轮询 */
  const [clockNudge, setClockNudge] = useState(0);
  /** 当前版本号（M10.2-3）：来自 Rust 的 `app_info`，**不许在前端硬编码** */
  const [version, setVersion] = useState("");
  const daytime = useMemo(() => isDaytime(new Date()), [now, clockNudge]);
  const Page = PAGES[view];

  /** C 批：提醒一"响"就放提示音（判据 = 数据里多了一条已弹的提醒，见那个文件的注释） */
  useAlertSound();

  /**
   * 面板上"来源"那一行（照抄 `TodoPage` 里那份 —— 面板搬上来之后它也得能跳回去）。
   * ⚠️ 从 `useData` 现取笔记 / 信息列表，**不缓存**：笔记改名、信息被删都要立刻反映。
   */
  const source = useMemo((): { text: string; open?: () => void } => {
    const todo = focusTodo;
    if (!todo) return { text: "" };
    if (todo.source.kind === "note") {
      const note = notes.find((one) => one.id === todo.source.noteId);
      const where = todo.source.nodeId ? "节点" : "自动检测";
      if (!note) return { text: `来自认知区《笔记已删除》·${where}` };
      return {
        text: `来自认知区《${note.title}》·${where}`,
        open: () => {
          setFocusRef({ kind: "note", id: note.id });
          setView("cognition");
        },
      };
    }
    if (todo.source.kind === "info") {
      const info = infos.find((one) => one.id === todo.source.infoId);
      if (!info) return { text: "来自信息区《信息已删除》" };
      const label = info.text.trim() ? info.text.trim().slice(0, 14) : "图片信息";
      return {
        text: `来自信息区《${label}》`,
        open: () => {
          setFocusRef({ kind: "info", id: info.id });
          setView("info");
        },
      };
    }
    return { text: "手动建的" };
  }, [focusTodo, infos, notes, setFocusRef, setView]);

  /**
   * 面板上那个 ✕ / 结束收尾后走这里。
   *
   * ⚠️ **只管"谁在专注"这件事，不碰计时**：真正的收尾（记账 + 标完成）在面板里，它做完才调这里。
   * 顺手把小窗收掉、把 Rust 那个每秒采样的线程停掉（M13-A/B 的约定，别漏）。
   *
   * 🔴 v1.14.1：**还要把那份"这一场的底"清掉** —— 不清的话下次开机会把已经结束的那一场又接回来。
   */
  const closeSession = useCallback(() => {
    stopFocusSession();
    setFocusRestore(null);
    clearFocusNumbers();
    void focusWindowClose().catch(() => undefined);
    void focusMonitorStop().catch(() => undefined);
  }, [stopFocusSession]);

  /**
   * 🔴 v1.14.1：**开机把"上一次没结束的那一场专注"接回来**（用户实测 bug 的修法）。
   *
   * 用户原话：「我启动了一个测试待办，然后关上屏幕后回来变成这样了」——
   * 面板显示「没有正在进行的待办」，数据里也**没有**任何记录：那一场成了孤儿。
   * 根因是会话只活在内存里：主窗被系统挂起后重载 → `focusSession.todo` 变回 `null` →
   * `{focusTodo && <PomodoroPanel/>}` 把面板卸掉，Rust 那边那份没人读、也没人结算。
   *
   * 现在的顺序：读那份底 → 按 id 找回待办 → **问后端会话还在不在** → 接回来。
   * - 后端还活着：**绝不重开会话**（重开会把它攒的"睡过 300 秒"清零）；
   * - 后端没了（进程重启）：重开一场，数字由前端这份底带着走；中间被挂起的那段
   *   **宁可补进暂停秒数**，也绝不当没发生过（用户定的规矩）。
   */
  useEffect(() => {
    if (restoreTriedRef.current) return;
    const record = readLiveSession();
    if (!record) {
      restoreTriedRef.current = true;
      return;
    }
    // 数据还没到位（`refresh` 没回来）→ 等下一轮，别急着判定"待办不存在"
    if (!todos.length) return;
    restoreTriedRef.current = true;

    const todo = todos.find((one) => one.id === record.todoId);
    if (!todo) {
      // 待办被删 / 被收纳了 → 会话没有落脚点。**明说一句**，不静默
      console.warn("[东方摩耶堂] 上次那场专注对应的待办已不存在，丢弃这场会话", record.todoId);
      clearFocusNumbers();
      return;
    }

    const gap =
      record.savedAt > 0 ? Math.max(0, Math.floor((Date.now() - record.savedAt) / 1000)) : 0;

    void focusMonitorState()
      .then((state) => {
        const alive = !!state?.active && state.todoId === record.todoId;
        if (!alive && record.running && gap > RESTORE_SUSPEND_GAP_SECONDS) {
          record.pausedSeconds += gap;
          record.running = false;
          rememberFocusNumbers(record);
        }
        setFocusRestore({ record, rustAlive: alive });
        resumeFocusSession(todo, { rustAlive: alive });
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 读取专注会话状态失败（当作后端那份已丢）", error);
        setFocusRestore({ record, rustAlive: false });
        resumeFocusSession(todo, { rustAlive: false });
      });
  }, [todos, resumeFocusSession]);

  // 启动时加载数据（信息列表 + 设置）；设置里的主题在这一步被应用上去
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Android 文件管理器把 `.md` 交给应用后，Kotlin 先把内容放进进程内队列。
   * 这里在应用启动、回到前台以及应用已开着时短间隔取走，导入成新笔记。
   * 「文件管理器 → 用东方摩耶堂打开」可能不会让页面重新挂载，所以不能只依赖一次性启动。
   */
  useEffect(() => {
    if (!inTauri() || !isMobileEnv() || !/Android/i.test(navigator.userAgent)) return;
    let stopped = false;
    let busy = false;
    let errorShown = false;
    const ingest = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const report = await notesImportAndroidPending();
        if (stopped) return;
        if (report.notes.length > 0) {
          await refresh();
          useUi.getState().toast(
            `已从文件管理器导入 ${report.notes.length} 篇：${report.notes.join("、")}`,
            "success",
          );
        }
        if (report.failed.length > 0) {
          useUi.getState().toast(`有 ${report.failed.length} 个文件没导入：${report.failed[0]}`, "error");
        }
      } catch (error) {
        // JNI/命令失败时只提示一次；空队列轮询不应刷屏。
        if (!errorShown && !stopped) {
          errorShown = true;
          useUi.getState().toast(`读取安卓待导入文件失败：${String(error)}`, "error");
        }
      } finally {
        busy = false;
      }
    };
    void ingest();
    const timer = window.setInterval(() => void ingest(), 1600);
    const onVisible = () => {
      if (document.visibilityState === "visible") void ingest();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  /**
   * 🔴 2026-10-20（用户反馈「正文延迟」）：**回到前台就重拉一次** —— 兜底所有"改了但没广播"的路径。
   *
   * 为什么要这层兜底：`data-changed` 是唯一的重拉触发源（见下面那个 effect），可总有些路
   * 不一定能广播到 —— **同步在后台线程里落地**、小窗存完之后主窗没收到、手机那边改完。
   * 用户原话：「手机改完、电脑要重启才看见」「小窗存完主窗要刷新」。
   *
   * 规则：**只在「藏起来/失去焦点 → 又回到前台」这一刻拉一次**，不是每次 focus 都拉
   * （否则点一下窗口就重读一遍盘，白白抖一下）。首次挂载时 `wasHidden=false`，不触发
   * （启动数据由上面那个 effect 负责）。
   */
  useEffect(() => {
    if (!inTauri()) return;
    let wasHidden = document.visibilityState === "hidden";
    const pullIfBack = () => {
      if (!wasHidden) return; // 一直可见 → 不重复拉
      wasHidden = false;
      void useData.getState().refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") wasHidden = true;
      else pullIfBack();
    };
    // 有些平台「点了别的程序」只是失焦、`visibilitychange` 不来，所以 focus/blur 也听着
    const onBlur = () => {
      wasHidden = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", pullIfBack);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", pullIfBack);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 顶部要一直显示版本号（M10.2-3）：单一来源是 tauri.conf.json 的 version，经 app_info 读回来
  useEffect(() => {
    void appInfo()
      .then((meta) => setVersion(meta.version))
      .catch((error) => console.error("[东方摩耶堂] 读取版本号失败", error));
  }, []);

  // Rust 侧事件：data-changed（数据变了 → 重新拉）/ icon-changed（跨 6:00·18:00 边界 → 换 logo）
  useEffect(() => {
    if (!inTauri()) return;
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = (fn: () => void) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    };
    const onError = (name: string) => (error: unknown) => {
      console.error(`[东方摩耶堂] 监听 ${name} 失败`, error);
    };

    listen("data-changed", () => {
      void useData.getState().refresh();
    })
      .then(track)
      .catch(onError("data-changed"));

    // B3（2026-10-07 用户反馈）：提醒到点时**手机也要在通知栏响一声** ——
    // 原来手机只有应用内横幅，切到别的 App 就看不见了。
    // ⚠️ 桌面端不发（它有托盘气泡，两边都发会响两声）—— 判断在 `notifyOutsideApp` 里。
    listen<Array<{ payload?: { text?: string; categoryText?: string } }>>(
      "reminder-fired",
      (event) => {
        const list = event.payload ?? [];
        void notifyOutsideApp(
          list.map((one) => ({
            title: "东方摩耶堂 · 该推进一下了",
            // 2026-10-11 用户反馈第 1 条：通知栏里原来取的是**前 80 个字**，
            // 信息一长就被切在半句话上 → 改成**正文第一行**（跟应用内那条同一份文案）。
            body: firstLine(one.payload?.text) || "有一条信息还没推进下一步（点开看看）",
          })),
        );
      },
    )
      .then(track)
      .catch(onError("reminder-fired"));

    listen<boolean>("icon-changed", () => {
      setClockNudge((n) => n + 1);
    })
      .then(track)
      .catch(onError("icon-changed"));

    // E 批（2026-10-03）：桌面挂件点了条目 → 把它唤回来并跳到对应位置。
    // ⚠️ 挂件自己**不写数据、也不改选中态**（它连"当前选中哪篇"都不知道）——
    //    它只发意图，"跳过去"这件事必须主窗做（主窗手上才有 focusRef / setView 那套）。
    listen<{ action?: string; view?: string; kind?: string; id?: string }>(
      "widget-intent",
      (event) => {
        const payload = event.payload ?? {};
        if (payload.action !== "open") return;
        // 先把主窗拉出来（挂件可能盖在它上面，用户点了当然是想看主窗）
        void mainShow().catch(() => undefined);
        if (payload.view) setView(payload.view as ViewKey);
        if (payload.id && (payload.kind === "todo" || payload.kind === "note")) {
          setFocusRef({ kind: payload.kind, id: payload.id });
        }
      },
    )
      .then(track)
      .catch(onError("widget-intent"));

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      unlisteners = [];
    };
  }, []);

  // 主题落到 <html>
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 字体/字号落到 <html> 的 CSS 变量（M7，见 shared/fonts.ts）
  useEffect(() => {
    applyFonts(config);
  }, [config]);

  // "跟随系统"时，系统切深浅色要立刻跟上
  useEffect(() => {
    if (theme !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  // 白天/夜晚变化时让 Rust 同步窗口+任务栏图标（界面 logo 跟着 daytime 走，两边规则同一条）
  // 注：跨 6:00/18:00 的边界切换 Rust 侧另有定时器兜底，这里是第二道保险
  useEffect(() => {
    void iconRefresh().catch(() => undefined);
  }, [daytime]);

  // ── M18（v2.1.0）：手机外壳 ──────────────────────────────────────────
  // 真机（安卓）或开发模式下的「强制手机布局」开关 → 走手机外壳；
  // 否则**电脑版一行都不变**（下面的分支就是原来的代码）。
  if (isMobileEnv() || isMobilePreview()) {
    return (
      <div className="flex h-full bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
        {/* M19：按当前 view 渲染对应的手机版区页（`src/mobile/zones/`） */}
        <MobileShell />
        <Toast />
        <ConfirmDialog />
      </div>
    );
  }

  return (
    <div className="flex h-full bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar daytime={daytime} />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶部条：应用名 + 日期时间 */}
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white/70 px-8 py-4 dark:border-slate-800 dark:bg-slate-900/50">
          <div className="flex items-center gap-3">
            <img
              src={logoSrc(daytime)}
              alt="东方摩耶堂"
              className="h-7 w-7 rounded-lg object-cover ring-1 ring-slate-200 dark:ring-slate-700"
            />
            <span className="text-sm font-medium">东方摩耶堂</span>
            {/* 版本号（M10.2-3）：数据来自 app_info，前端不硬编码 —— 改 tauri.conf.json 就跟着变 */}
            {version && (
              <span
                data-app-version
                title="当前版本号（来自 tauri.conf.json，经 app_info 命令读取）"
                className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                v{version}
              </span>
            )}
          </div>
          <span className="font-mono text-xs text-slate-400">{formatDateTime(now)}</span>
        </header>

        {/* 提醒横幅：45 分钟没联动的信息会在这里冒出来（M2） */}
        <ReminderBanner />

        <div className="min-h-0 flex-1">
          <Page />
        </div>
      </main>

      {/* ───────── B 批（2026-10-02）：番茄钟面板 ─────────
          原来是套在 `Modal` 里的全屏模态遮罩（`fixed inset-0 + backdrop-blur`），
          一开番茄钟就把整个界面的鼠标吃掉 —— 用户实测原话「一旦开始待办，其他地方雾化，无法点击」。
          现在它是一块**普通面板**（不铺遮罩、不吞鼠标），而且挂在 `App` 这一层：
          切页面**不会把它卸载**（挂 `TodoPage` 里的话，切个区计时就断了）。 */}
      {focusTodo && (
        <PomodoroPanel
          todo={focusTodo}
          restore={focusRestore}
          sourceText={source.text}
          onOpenSource={source.open}
          onFinish={(mode, seconds, note, finish, extra) =>
            void addPomodoro(focusTodo.id, mode, seconds, note, finish, extra)
          }
          onClose={closeSession}
        />
      )}

      <Toast />
      <ConfirmDialog />
    </div>
  );
}
