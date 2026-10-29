/**
 * 「当前正在专注的那条待办」（B 批新增，2026-10-02；v1.14.1 加"接回来"）。
 *
 * # 为什么要单独一个 store，而不是留在 `TodoPage` 的 useState 里
 *
 * 用户实测反馈的原话是「一旦开始待办，其他地方雾化、无法点击」—— 根因是番茄钟面板套在
 * **全屏模态遮罩**里（`fixed inset-0` + `backdrop-blur`）把鼠标全吃了。去掉遮罩之后紧接着
 * 冒出一个新问题：**面板一挪出 `TodoPage`，切到别的区就把它整个卸载了** ——
 * 而"计时的权威"就在那个组件里（`startedAt` / `elapsed` / 与 Rust 的 `focus-tick` 订阅），
 * 一旦卸载，计时、专注小窗、托盘那行字全断。
 *
 * 所以：**谁在专注这件事挪到 store（跟页面同生共死），面板本身挂在 `App` 上** ——
 * 切页面不卸载，计时和小窗都不受影响；用户回来还能看见那块面板。
 *
 * ⚠️ 这里**仍然不存计时数字**：秒数还是 `Pomodoro` 组件手里的权威
 * （跟 M13-A 定的"计时的权威只有一处"一致）。跨重载活下来的那份底在
 * `store/focusNumbers.ts`（它连"锚点/模式/时长"一起存），两边分工：
 * **这里管"谁在专注"，那里管"这一场走到哪了"**。
 *
 * # 🔴 v1.14.1：为什么必须有 `resume`
 *
 * 用户实测：合上盖子睡一觉回来，那一场番茄**凭空消失**（面板显示"没有正在进行的待办"、
 * 数据里也没多一条记录）。根因是这里**只是内存**：主窗被系统挂起后重载，
 * `todo` 变回 `null` → `App` 里 `{focusTodo && <PomodoroPanel/>}` 直接把面板卸掉，
 * 后端那份会话没人读、也没人结算 —— 成了"孤儿"。
 *
 * 有了 `resume` + `focusNumbers` 那份底，重载后会：找回待办 → **问后端会话还在不在** →
 * 接回来（面板继续显示那条待办，已暂停的显示「已暂停 · 休眠」等用户点「继续」）。
 */
import { create } from "zustand";
import { focusMonitorStart, focusWindowOpen } from "../features/api";
import type { Todo } from "../features/types";
import { clearFocusNumbers } from "./focusNumbers";

interface FocusSessionState {
  /** 正在专注的待办（`null` = 没有会话，面板不显示） */
  todo: Todo | null;
  /**
   * 开始专注：**开专注小窗 + 开 Rust 的专注监控**都在这里做。
   *
   * ⚠️ 为什么开窗要**显式**调用、不靠组件的挂载/卸载：那是异步的，
   * React StrictMode 的「挂载 → 清理 → 再挂载」会把开/关打乱顺序，最后可能留下"关着"
   * （2026-09-26 验收真逮到：小窗内容在、`focus_window_visible` 却是 false）。
   */
  start: (todo: Todo) => void;
  /**
   * **把没结束的那一场接回来**（v1.14.1）。
   *
   * `rustAlive` = 后端那份会话**还在**（进程没重启、`focus_monitor_state` 说 active 且是这条待办）。
   *
   * 🔴 **`rustAlive === true` 时绝对不能调 `focusMonitorStart`**：
   * 后端 `focus::start` 是"新建一场"（重置计账器），一调就把已经攒下的
   * "睡了 300 秒"清零 —— 那正是这次要修的 bug 的另一副面孔。
   */
  resume: (todo: Todo, options: { rustAlive: boolean }) => void;
  /** 结束 / 收起面板（**计时由面板自己收尾**，这里只管"谁在专注"这件事） */
  stop: () => void;
}

export const useFocusSession = create<FocusSessionState>((set) => ({
  todo: null,
  start: (todo) => {
    set({ todo });
    // 2026-10-05（v1.14.0）：新的一场 = 上一次留下的"数字底"必须清掉，
    // 否则同一条待办再专注时会把上一场的暂停/中断算进这一场（见 `store/focusNumbers.ts`）
    clearFocusNumbers();
    void focusWindowOpen(`东方摩耶堂 · 专注中：${todo.title}`).catch((error: unknown) => {
      console.error("[东方摩耶堂] 打开专注小窗失败", error);
    });
    // M13-B：同时开一次"专注会话" —— 键鼠空闲 / 锁屏 / 睡过由 Rust 那个每秒采样的线程盯着，
    // 前端每秒收一条 `focus-tick`（判定只有一处，前端不自己猜）
    void focusMonitorStart(todo.id).catch((error: unknown) => {
      console.error("[东方摩耶堂] 开启专注监控失败", error);
    });
  },
  resume: (todo, options) => {
    set({ todo });
    // ⚠️ 这里**不清** `focusNumbers`：那份底就是这一场的账，正是靠它接回来的
    void focusWindowOpen(`东方摩耶堂 · 专注中：${todo.title}`).catch((error: unknown) => {
      console.error("[东方摩耶堂] 打开专注小窗失败（接回会话时）", error);
    });
    if (!options.rustAlive) {
      // 后端那份没了（进程重启 / 会话被清）→ 重新起一场，**数字由前端那份底带着走**
      void focusMonitorStart(todo.id).catch((error: unknown) => {
        console.error("[东方摩耶堂] 接回会话时重开监控失败", error);
      });
    }
  },
  stop: () => set({ todo: null }),
}));
