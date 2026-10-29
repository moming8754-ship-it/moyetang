/**
 * 奖状墙的排序与分段（M12-A）—— 全是纯函数，不碰文件、不碰界面。
 *
 * 规则（照设计稿定的）：
 * 1. **置顶的最前**（"我最得意的"永远在第一眼看得到的地方）；
 * 2. 其余**按年份从新到旧**分段（`2026` / `2025` …）—— 一年一条细线，**积累感看得见**；
 * 3. 同一年里按**日期倒序**；没写日期的排该段最后；
 * 4. 日期里**抓不到年份**的单独归一段「没写日期」，排在所有年份后面。
 *
 * ⚠️ 排序只在这一处做（Rust 的 `award_list` 是原样返回文件顺序），别两边各排一遍。
 */
import type { Award } from "../types";

/** 从自由文本日期里抓四位年份（`2026-08-14` / `2026 年 6 月` 都认）；抓不到返回空串 */
export function yearOf(date: string): string {
  const hit = (date ?? "").match(/(?:19|20)\d{2}/);
  return hit ? hit[0] : "";
}

/** 新的排前面；没写日期的排最后；日期一样就比创建时间 */
function byNewest(a: Award, b: Award): number {
  const left = yearOf(a.date) || "";
  const right = yearOf(b.date) || "";
  if (left !== right) {
    if (!left) return 1;
    if (!right) return -1;
    return right.localeCompare(left);
  }
  if (a.date !== b.date) {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  }
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

/** 一段（一段 = 一条年份细线下面的那一片卡片） */
export interface AwardSection {
  /** `📌 置顶` / `2026` / `没写日期` */
  label: string;
  items: Award[];
}

export function awardSections(items: Award[]): AwardSection[] {
  const sections: AwardSection[] = [];

  const pinned = items.filter((one) => one.pinned).sort(byNewest);
  if (pinned.length > 0) sections.push({ label: "📌 置顶", items: pinned });

  const rest = items.filter((one) => !one.pinned);
  const years = [...new Set(rest.map((one) => yearOf(one.date)).filter(Boolean))].sort().reverse();
  years.forEach((year) => {
    const group = rest.filter((one) => yearOf(one.date) === year).sort(byNewest);
    if (group.length > 0) sections.push({ label: year, items: group });
  });

  const unknown = rest.filter((one) => !yearOf(one.date)).sort(byNewest);
  if (unknown.length > 0) sections.push({ label: "没写日期", items: unknown });

  return sections;
}

/** 最新的一张（拿来写"最近一张是…"）；一张都没有就 null */
export function latestAward(items: Award[]): Award | null {
  if (items.length === 0) return null;
  return [...items].sort(byNewest)[0] ?? null;
}

/**
 * 卡片的"牌面"用什么字（**没图时的兜底**）：
 * 标题的第一个字（去掉最前面的书名号/括号之类），一个都没有就给个 `★`。
 */
export function faceChar(title: string): string {
  const cleaned = (title ?? "").replace(/^[《「【（(\s]+/, "").trim();
  return cleaned.slice(0, 1) || "★";
}

/**
 * 卡片"牌面"的底色：由标题算一个稳定的色号（同一张奖状每次都是同一个色）。
 * 用哈希而不是随机 —— 每次重渲染换一个颜色会闪得人难受。
 */
const FACES = [
  "linear-gradient(135deg,#3f3f6b,#7c3aed)",
  "linear-gradient(135deg,#0f766e,#134e4a)",
  "linear-gradient(135deg,#7c2d12,#b45309)",
  "linear-gradient(135deg,#1e3a8a,#0e7490)",
  "linear-gradient(135deg,#4c1d95,#be185d)",
  "linear-gradient(135deg,#365314,#166534)",
];

export function faceGradient(title: string): string {
  let sum = 0;
  for (let index = 0; index < title.length; index += 1) sum = (sum + title.charCodeAt(index)) % 9973;
  return FACES[sum % FACES.length];
}
