/**
 * 手机版平台判断（M18 / v2.1.0）
 *
 * 两件事：
 * 1. `isMobileEnv()` —— 真机判断（安卓/iOS 的 UA）。
 * 2. `isMobilePreview()` —— **开发/验收用的"强制手机布局"开关**（2026-10-06：改用 sessionStorage —— 只活一次窗口，
 *    避免验收留下的开关活过关机重开、把桌面套件带进"手机布局"从而成片假红）。
 *
 * 🔴 为什么要有第 2 个：手机版每做一个区都要验收，但**不能每次都让用户装机**。
 *    所以在电脑上用一个开关把手机外壳渲染在一个 **360×800 的框**里，
 *    这样普通桌面窗口里就能用 `tools\cdp.ps1` 的**真鼠标**去点、去截图。
 *
 * ⚠️ 硬要求：这个开关**只在开发模式（`import.meta.env.DEV`）生效**。
 *    打出来的正式电脑版**绝不能**因为浏览器存储里有个键就变成手机布局。
 */

/** 真机（安卓/iPhone/iPad）—— 也认 Tauri 注入的标记，UA 认不出来时兜底 */
export function isMobileEnv(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** 验收脚本用的键名（**别改**：`tools\m18\run.ps1` 和后续套件都靠它） */
export const MOBILE_PREVIEW_KEY = "dsh-mobile-preview";

/** 强制手机布局开着吗（**只在开发模式生效**） */
export function isMobilePreview(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return sessionStorage.getItem(MOBILE_PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

/** 该走手机外壳吗 */
export function useMobileLayout(): boolean {
  return isMobileEnv() || isMobilePreview();
}
