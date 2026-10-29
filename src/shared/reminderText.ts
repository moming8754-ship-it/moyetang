/**
 * **信息提醒要显示的那几行字，只在这一处拼**（2026-10-11 用户反馈第 1 条）。
 *
 * 用户原话：「1 如图，通知里面，看不到信息区的内容，因为有一些信息太长，
 * 可以取信息的第一行来表示。」
 *
 * 改之前的事实（都是当场核过的，别凭印象改回去）：
 * ① 后端**早就把信息正文传过来了** —— `ReminderPayload.text`（`store/reminder.rs`
 *    造 `InfoStale` 那一段：有正文就是正文，空正文才写「（图片）…」/「（空信息）」）。
 * ② 但**手机首页那张卡片只显示了一句写死的话**（`〔未分类〕这条还没推进下一步`），
 *    正文一个字都没露 → 用户根本认不出是哪条信息（这是他报的那条现象）。
 * ③ 电脑版首页卡片与顶部横幅显示的是**正文原文**（可能很长，被 `truncate` 硬切）→
 *    一起改成"第一行"，两端看起来才是同一件事。
 *
 * ⚠️ 用户要的是**第一行**（到第一个换行为止），不是"前 N 个字"—— 别改成 slice。
 * ⚠️ 只在**显示层**用；`payload.text` 本身（后端存的、同步走的）一个字都不动。
 */

/** 第一行最多留几个字（超了加省略号）。CSS 那边还有一层 `truncate` 兜底。 */
export const INFO_HEADLINE_MAX = 60;

/**
 * 取正文第一行：去掉首尾空白 + 超长截断。
 * 空正文返回空串（要不要兜底由调用方决定）。
 */
export function firstLine(text: string | undefined, max = INFO_HEADLINE_MAX): string {
  const line = (text ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 信息类提醒要显示的那行正文（空正文给一句占位，别让卡片上出现空白行）。
 */
export function infoHeadline(text: string | undefined): string {
  return firstLine(text) || "（这条信息没有正文）";
}
