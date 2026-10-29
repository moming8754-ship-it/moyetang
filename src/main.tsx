import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import SmallWindow from "./pages/SmallWindow";
import FocusWindow from "./pages/FocusWindow";
import Widget from "./pages/Widget";
import "./styles/index.css";

/**
 * 主窗和小窗**共用同一份前端产物**（都加载 `index.html`），靠**窗口 label** 分流。
 *
 * 为什么用 label 而不是 URL 参数：label 是 Tauri 现成给的，不用赌 asset 协议怎么处理
 * query/hash；而且窗口一多，label 是唯一稳定的身份。
 */
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // 在纯浏览器里开 vite（非 Tauri 环境）时没有这个 API，当主窗处理
    return "main";
  }
}

const label = currentWindowLabel();
/**
 * 小窗（M6）—— ⚠️ 2026-10-11（v2.21.0 · 用户反馈第 6 条）起**可以同时开好几个**：
 * 1 号仍叫 `small`，多开的叫 `small-2` / `small-3`…，所以这里按**前缀**认，别写 `=== "small"`。
 * （Rust 侧同一套判断在 `window.rs::small_index_of`，改一边要改另一边。）
 */
const isSmallWindow = label === "small" || label.startsWith("small-");
/** M13-A：专注小窗也是运行时建的，同样靠 label 分流 */
const isFocusWindow = label === "focus";
/** E 批（2026-10-03）：桌面挂件也是运行时建的 —— **跟专注小窗是两个窗**，别合并 */
const isWidget = label === "widget";

/**
 * 小窗在**模块装载时就**把 title 改掉（不是等 React 挂载后在 effect 里改）。
 *
 * 为什么非要这么早：验收脚本靠 `cdp.ps1 -TargetTitle` 分窗口，而两个窗口 URL 一样、
 * 只能靠 title 区分。等 effect 之后再改会留出一段"小窗 title 还等于主窗 title"的空档，
 * 那期间脚本挑 target 会挑到小窗上（真实后果：`prd12.ps1` 的 10.1-1 报出
 * "应用标题是《东方摩耶堂 · 速记》"这种莫名其妙的话）。
 * 放在这里，bundle 一执行 title 就定了，空档缩到毫秒级。
 */
if (isSmallWindow) {
  /*
   * ⚠️ 2026-10-11（v2.21.0 · 用户反馈第 6 条）：小窗能多开了 → **title 要带上号**，
   * 否则三个窗在 CDP 的 target 列表里一模一样（都是「东方摩耶堂 · 速记」），
   * 验收脚本没法挑窗口，人也分不出哪个是哪个。
   * 1 号窗的 title **保持原样**（老脚本 `-TargetTitle '东方摩耶堂 · 速记'` 全靠它）。
   */
  document.title = label === "small" ? "东方摩耶堂 · 速记" : `东方摩耶堂 · 速记 ${label.slice(6)}`;
}

// 专注窗同理：**模块装载时**就把 title 定下来（验收脚本靠 title 分 target，
// 等 React 挂载后再改会留一段"两个窗口同名"的空档 —— M7 为此白跑过两轮回归）
if (isFocusWindow) {
  document.title = "东方摩耶堂 · 专注中";
}

// 挂件窗同理（E 批）：title 定成「东方摩耶堂 · 挂件」，脚本靠它挑 target
if (isWidget) {
  document.title = "东方摩耶堂 · 挂件";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSmallWindow ? (
      <SmallWindow />
    ) : isFocusWindow ? (
      <FocusWindow />
    ) : isWidget ? (
      <Widget />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
