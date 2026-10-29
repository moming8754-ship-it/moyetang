/**
 * **系统通知**（B3，2026-10-07 用户反馈）。
 *
 * 用户原话：「3提个在认知区文本编辑器之外的问题:这个编辑了信息区，45min没联动的通知怎么改进好?
 * 我今天体验过一次信息区转认知区了，但是最好还是可以在app之外看见这个通知」
 *
 * 原来只有**应用内横幅**（`ReminderBanner`）+ 桌面端的**托盘气泡**；手机版什么都没有 ——
 * 切到别的 App / 锁屏就完全不知道有提醒。
 *
 * # 什么时候发
 * 后端调度器（`scheduler.rs`）到点会广播 `reminder-fired`（它本来就是"提醒真的到点了"的信号，
 * 桌面端的托盘气泡也是听它）→ 这里跟着发一条系统通知。
 *
 * # 两条硬约束
 * ① **只在手机端发**：桌面端已经有托盘气泡，两边都发就是响两声（用户会嫌吵）。
 * ② **用户拒绝了就闭嘴**：`requestPermission()` 没给 `granted` 就直接放弃，
 *    不反复弹权限框（安卓 13+ 第一次会问，之后由系统记住）。
 *
 * ⚠️ 已知边界（如实写在这儿，别当成 bug）：调度器跑在**应用进程**里 —— 应用被彻底杀掉之后
 *    不会再有通知。真正"关掉也能响"要前台服务（那是 M20.1 的事）。
 */
import { isMobileEnv } from "../mobile/platform";

export interface SystemNotice {
  title: string;
  body: string;
}

/** 发系统通知（手机端）。失败只记日志，绝不让它影响应用内的提醒 */
export async function notifyOutsideApp(notices: SystemNotice[]): Promise<void> {
  if (!isMobileEnv()) return; // 桌面端有托盘气泡，不重复响
  if (notices.length === 0) return;
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) granted = (await mod.requestPermission()) === "granted";
    if (!granted) return; // 用户拒绝了 → 不硬来
    // 一次最多响 3 条：同一分钟攒了十几条提醒时，别把通知栏刷满
    for (const one of notices.slice(0, 3)) {
      mod.sendNotification({ title: one.title, body: one.body });
    }
  } catch (error) {
    console.warn("[东方摩耶堂] 系统通知没发出去（不影响应用内提醒）", error);
  }
}
