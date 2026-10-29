/**
 * 字体与字号（M7）—— 把 `config.uiFont / bodyFont / fontSize` 落到 `<html>` 的 CSS 变量上。
 *
 * # 为什么不直接在组件里写 style
 * 界面字体要影响**整棵树**（包括 Portal 出去的弹窗、以及小窗那个独立 webview），
 * 所以统一挂在 `<html>` 上，由 `styles/index.css` 去引用这几个变量。
 *
 * # 「界面字体」和「正文字体」是两件事（PRD §5.5 分开列的）
 * - `--font-ui`：导航、按钮、设置页这些**界面**文字；
 * - `--font-body`：编辑器与 Markdown 预览里的**正文**（读文章时想换字体，但不影响按钮）。
 *   没单独设正文字体时它跟着界面字体走。
 */
import type { Config } from "../features/types";

/** 界面字体的兜底（和 `styles/index.css` 里 `@theme` 的 `--font-sans` 保持一致） */
export const FALLBACK_UI_FONT = "Microsoft YaHei UI";

/** 正文字体的兜底：跟着界面字体走 */
export const FALLBACK_BODY_FONT = "var(--font-ui)";

/** 常用字体一键填（用户不必手打字体名，也不一定记得住名字） */
export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: "微软雅黑", value: "Microsoft YaHei UI" },
  { label: "宋体", value: "宋体" },
  { label: "楷体", value: "楷体" },
  { label: "等宽（Consolas）", value: "Consolas" },
  { label: "系统默认", value: "" },
];

/** 可选字号（PRD 只要求"字号"，给几档够用的） */
export const FONT_SIZES = [14, 15, 16, 17, 18, 20];

/**
 * 把用户填的字体名拼成能用的 CSS `font-family` 值。
 *
 * ⚠️ 一个必须处理的细节：带**空格**的字体名（`Microsoft YaHei`）**必须加引号**，
 * 否则整条 `font-family` 会被浏览器判成非法声明、直接失效 —— 表现是"设了没用"，
 * 而且控制台不一定报错，很难查。
 */
export function fontStack(name: string, fallback: string): string {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  // 用户自己写了逗号（= 自己给了 fallback 列表）就原样用
  if (trimmed.includes(",")) return trimmed;
  const quoted = /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
  return `${quoted}, ${fallback}`;
}

/** 把字体设置应用到 `<html>`（清空 = 用回默认，所以是 `removeProperty` 而不是赋值） */
export function applyFonts(config: Config): void {
  const root = document.documentElement;
  const ui = (config.uiFont ?? "").trim();
  const body = (config.bodyFont ?? "").trim();
  const size = config.fontSize > 0 ? config.fontSize : 16;

  if (ui) root.style.setProperty("--font-ui", fontStack(ui, "var(--font-sans)"));
  else root.style.removeProperty("--font-ui");

  if (body) root.style.setProperty("--font-body", fontStack(body, FALLBACK_BODY_FONT));
  else root.style.removeProperty("--font-body");

  root.style.setProperty("--font-size-base", `${size}px`);
}
