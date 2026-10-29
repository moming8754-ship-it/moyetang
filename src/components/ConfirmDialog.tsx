import { useEffect } from "react";
import { useUi } from "../store/ui";

/**
 * 通用确认弹窗。
 * ⚠️ 必须自建：`window.confirm` 在 Tauri 的 WebView 里不生效（草笺项目踩过）。
 */
export default function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const closeConfirm = useUi((s) => s.closeConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeConfirm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirm, closeConfirm]);

  if (!confirm) return null;

  const handleConfirm = () => {
    const action = confirm.onConfirm;
    closeConfirm();
    action?.();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-sm"
      onClick={closeConfirm}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{confirm.title}</h2>
        {confirm.message && (
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {confirm.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          {/* ⚠️ 验收抓手 `data-confirm-ok` / `data-confirm-cancel`：**全项目共用这一个对话框**，
              套件（`tools\m19` 的树页删除那段等）得能用**真鼠标**点到"确认/取消"——
              没有抓手就只能合成 `.click()`，那是假绿。别改名。 */}
          <button
            type="button"
            data-confirm-cancel
            onClick={closeConfirm}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {confirm.cancelText ?? "取消"}
          </button>
          <button
            type="button"
            data-confirm-ok
            onClick={handleConfirm}
            className={`rounded-xl px-4 py-2 text-sm font-medium text-white ${
              confirm.danger ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {confirm.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
