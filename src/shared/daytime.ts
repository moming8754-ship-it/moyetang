/**
 * 白天/夜晚判定与时钟 —— 与 Rust 端 `is_daytime()` 保持同一条规则。
 *
 * 约定：白天 6:00–18:00 用哥尔赞，其余时间用美尔巴；窗口/任务栏图标由 Rust 切，
 * 界面 logo 由前端切（两边规则必须一致）。
 */
import { useEffect, useState } from "react";

export const DAY_START_HOUR = 6;
export const DAY_END_HOUR = 18;

export function isDaytime(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

/** 界面 logo：白天哥尔赞 / 夜晚美尔巴（public/ 下的方图，由 tools/make-icons.ps1 生成） */
export function logoSrc(daytime: boolean): string {
  return daytime ? "/logo-day.png" : "/logo-night.png";
}

/** 每隔 intervalMs 刷新一次的当前时间（用于界面 logo 与右上角时间） */
export function useClock(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 周${
    WEEKDAYS[date.getDay()]
  } ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 列表里的时间戳：今天 → "今天 HH:mm"，昨天 → "昨天 HH:mm"，更早 → "YYYY-MM-DD HH:mm" */
export function formatStamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  // 时间戳坏了就原样显示，别在界面上写 NaN
  if (Number.isNaN(date.getTime())) return iso;

  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `昨天 ${hm}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}
