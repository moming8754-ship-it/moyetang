/**
 * `-[]文字` 标记的**前端镜像实现** —— 与 Rust `src-tauri/src/marker.rs` 一一对应。
 *
 * 为什么前端也要有一份：预览和编辑器要在**每一次按键**之后立刻知道
 * "这一行是不是标记、它的 markerKey 是什么"，不能每敲一个字都问一次后端。
 *
 * ⚠️ 改这里的规则就要同步改 Rust 那边（marker.rs 顶部也写了这句话）。
 * 两边真有不一致时，`note_marker_toggle` 还有一层「用文字兜底找」的保险，
 * 但那只是保险，不是可以放任不一致的理由。
 */

/** 一行 `-[]` 标记 */
export interface Marker {
  /** 0 基行号 */
  line: number;
  /** 去重键：`noteId + '#' + 归一化文本` */
  key: string;
  /** `-[]` 后面的文字（已 trim，保留原始大小写） */
  text: string;
}

/** 归一化文本：去掉首尾空白 + 连续空白压成一个空格（**故意不做小写化**） */
export function normalizeMarkerText(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** 去重键：`noteId + '#' + 归一化文本`（DEV-PLAN §4.3） */
export function markerKeyOf(noteId: string, text: string): string {
  return `${noteId}#${normalizeMarkerText(text)}`;
}

/**
 * 这一行是不是 `-[]文字`；是的话给出标记文字。
 *
 * 只认**行首**（前面允许空白）的 `-[]`，`-[]` 后面必须有文字；
 * 标准 Markdown 的 `- [ ]` 在这里**不算**标记（用户指定的写法是 `-[]`）。
 */
export function markerTextOf(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("-[]")) return null;
  const text = trimmed.slice(3).trim();
  return text.length > 0 ? text : null;
}

/** 扫一遍正文，按顺序给出所有标记 */
export function scanMarkers(noteId: string, content: string): Marker[] {
  const found: Marker[] = [];
  content.split("\n").forEach((line, index) => {
    const text = markerTextOf(line);
    if (text) found.push({ line: index, key: markerKeyOf(noteId, text), text });
  });
  return found;
}
