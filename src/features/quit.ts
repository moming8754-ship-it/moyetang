/**
 * 退出程序的统一入口（左侧导航底部 quit 与首页 quit 卡片共用）。
 *
 * 两个要点：
 * 1. 先弹自建确认框（`window.confirm` 在 Tauri 的 WebView 里不生效）。
 * 2. **不要吞掉 Promise 异常**：失败要弹 Toast 说出来，否则就成了"点了没反应"。
 */
import { useUi } from "../store/ui";
import { quitApp } from "./api";

export function useQuitAction(): () => void {
  const askConfirm = useUi((s) => s.askConfirm);
  const toast = useUi((s) => s.toast);

  return () => {
    askConfirm({
      title: "退出东方摩耶堂？",
      message: "数据已保存在数据目录中，退出不会丢失内容。",
      confirmText: "退出",
      onConfirm: () => {
        void quitApp().catch((error: unknown) => {
          toast(`退出失败：${String(error)}`, "error");
        });
      },
    });
  };
}
