import { useUi } from "../store/ui";
import type { ToastKind } from "../store/ui";

const KIND_STYLE: Record<ToastKind, string> = {
  info: "bg-slate-800 text-white dark:bg-slate-700",
  success: "bg-emerald-600 text-white",
  error: "bg-rose-600 text-white",
};

/**
 * 通用轻提示（顶部居中，自动消失，点击可立即关掉）。
 *
 * M15 起支持**动作按钮**：`toast(文字, kind, { label, run })` —— 用来做
 * 「已收进档案库 · 撤销」（5 秒内可撤回；带动作的会多留一会儿，见 `store/ui.ts`）。
 */
export default function Toast() {
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-5 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex max-w-[70vw] items-center gap-3 rounded-xl px-4 py-2 text-sm shadow-lg ${
            KIND_STYLE[toast.kind]
          }`}
        >
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="max-w-[52vw] truncate text-left"
          >
            {toast.text}
          </button>
          {toast.action && (
            <button
              type="button"
              data-toast-action
              onClick={() => {
                const run = toast.action?.run;
                dismissToast(toast.id);
                run?.();
              }}
              className="shrink-0 rounded-lg bg-white/20 px-2.5 py-0.5 text-[12.5px] font-medium hover:bg-white/30"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
