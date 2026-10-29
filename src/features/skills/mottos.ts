/**
 * 格言 / 原则的排序、筛选、"今天这一句"（M12-C）—— 全是纯函数。
 *
 * ⚠️ **没有"置顶"** —— 用户 2026-09-26 明确说"去掉置顶功能"（格言不该排序）。
 * 所以顺序就一条规则：**新写的在最前**（按加入顺序倒着摆）。
 */
import { dateKey } from "../schedule/aggregate";
import type { Motto, MottoKind } from "../types";

export type MottoFilter = "all" | MottoKind;

/** 类别在界面上的叫法 */
export const KIND_LABEL: Record<MottoKind, string> = {
  motto: "格言",
  rule: "原则",
};

/** 出处那一行的文案：没写就按类别兜一句 */
export function attribution(motto: Motto): string {
  const from = (motto.from ?? "").trim();
  if (from) return motto.kind === "motto" && !from.startsWith("——") ? `—— ${from}` : from;
  return motto.kind === "rule" ? "自己写给自己的" : "—— 出处待补";
}

/** 新写的排最前（文件顺序 = 加入顺序，所以倒着来） */
export function ordered(items: Motto[]): Motto[] {
  return [...items].reverse();
}

export function filterMottos(items: Motto[], filter: MottoFilter): Motto[] {
  if (filter === "all") return items;
  return items.filter((one) => one.kind === filter);
}

export function countBy(items: Motto[], kind: MottoKind): number {
  return items.filter((one) => one.kind === kind).length;
}

/**
 * **今天这一句**：按**本地日期**挑，**同一天固定不变、跨天才换**。
 *
 * ⚠️ 别用 `Math.random()` —— 那样每次重渲染都在跳，看着像坏了。
 * ⚠️ 日期一律本地（`dateKey`），后端存的是 UTC。
 */
export function todayMotto(items: Motto[], now: Date = new Date()): Motto | null {
  if (items.length === 0) return null;
  const key = dateKey(now);
  let sum = 0;
  for (let index = 0; index < key.length; index += 1) sum = (sum * 31 + key.charCodeAt(index)) % 100003;
  return items[sum % items.length] ?? null;
}

/** 随机翻一句（尽量别翻到当前正显示的那条，不然点一下像没反应） */
export function randomMotto(items: Motto[], exceptId?: string): Motto | null {
  if (items.length === 0) return null;
  const pool = items.length > 1 ? items.filter((one) => one.id !== exceptId) : items;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}
