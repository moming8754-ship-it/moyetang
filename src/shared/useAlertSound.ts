/**
 * 提醒一"响"就播提示音（C 批，2026-10-02）。
 *
 * # 判据：**出现了一条新的"已弹"提醒**
 *
 * 不监听 Rust 事件，而是**看数据**：`store.reminders` 里多出一条 `status === "fired"` 的
 * （或某条从别的状态变成 fired），就响一次。理由有三条：
 * 1. 数据是唯一真源 —— 不管提醒是从后台调度弹的、还是"稍后提醒"重排后又到点，都会落在这里；
 * 2. 提醒被**关掉 / 删掉**时不会误响（那种是条目消失，不是新增）；
 * 3. 一进场就把此刻已有的 fired 记下（`primedRef`）→ **不会**每次切页面/重开都放一遍旧提醒的声。
 *
 * ⚠️ 只放**新出现的**那一条的声：一次冒出三条也只响一次（避免连环轰炸）。
 */
import { useEffect, useRef } from "react";
import { useData } from "../store/data";
import { playAlert } from "./sound";

export function useAlertSound(): void {
  const reminders = useData((s) => s.reminders);
  const config = useData((s) => s.config);

  /** 已经"见过"的已弹提醒 id —— 第一次是全集（不回放历史），之后只认新增 */
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const firedIds = reminders.filter((one) => one.status === "fired").map((one) => one.id);

    // 首轮：把现有的全部记下，**不响**（否则每次启动应用都会为几天前的提醒响一声）
    if (seenRef.current === null) {
      seenRef.current = new Set(firedIds);
      return;
    }

    const fresh = firedIds.filter((id) => !seenRef.current?.has(id));
    if (fresh.length > 0) {
      fresh.forEach((id) => seenRef.current?.add(id));
      playAlert(
        config.reminders.soundKind,
        config.reminders.soundVolume,
        config.reminders.soundTimes,
      );
    }
  }, [reminders, config.reminders.soundKind, config.reminders.soundVolume, config.reminders.soundTimes]);
}
