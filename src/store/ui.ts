/**
 * 全局 UI 状态（Zustand）：当前页面、主题、Toast、确认弹窗。
 *
 * ⚠️ 教训：删除确认**必须自建弹窗**，`window.confirm` 在 Tauri 的 WebView 里不生效（草笺项目踩过）。
 * 所以这里提供 askConfirm()，全项目统一走 ConfirmDialog。
 *
 * 主题三态（light/dark/system）：值存在 config.json 里（M1 起落盘），这里只负责"应用"。
 */
import { create } from "zustand";
import type { ThemeMode } from "../features/types";
import {
  isThemeId,
  paletteOf,
  themeById,
  THEME_ATTR,
  THEME_VAR_NAMES,
} from "../shared/themes";

export type { ThemeMode };

export type ViewKey =
  | "home"
  | "info"
  | "cognition"
  | "todo"
  | "schedule"
  | "skill"
  | "settings"
  /** M15：档案库（**默认没有入口**，设置里启用「档案区」才出现） */
  | "archive";
export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  /**
   * M15：可选的**动作按钮** —— "收进档案库"之后要给 5 秒「撤销」。
   * 传了它，这个提示就多一个可点的按钮；点了先跑动作、再自动关掉。
   */
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** true = 危险操作（删除等），确认按钮转红 */
  danger?: boolean;
  onConfirm?: () => void;
}

interface UiState {
  view: ViewKey;
  theme: ThemeMode;
  /** 左侧导航是否收起 */
  sidebarCollapsed: boolean;
  /**
   * 首页动态区里被「×」**临时收起**的卡片（PRD §3.2：每张卡片右上角 × 临时收起，永久取消去设置）。
   *
   * 为什么放在**内存里**而不是 `config.json`：PRD 用的词是"临时"—— 重开程序就该回来。
   * 真要永久关掉，去设置里关那个常驻项（那才是写进 config 的）。
   */
  hiddenHomeCards: string[];
  toasts: ToastItem[];
  confirm: ConfirmRequest | null;
  setView: (view: ViewKey) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  /** 临时收起首页某张动态卡片（`reminders` / `todos`）；重开程序会回来 */
  hideHomeCard: (key: string) => void;
  toast: (
    text: string,
    kind?: ToastKind,
    action?: { label: string; run: () => void },
  ) => void;
  dismissToast: (id: number) => void;
  askConfirm: (request: ConfirmRequest) => void;
  closeConfirm: () => void;
}

/**
 * `system` 时跟随系统深浅色，其余按选择来。
 *
 * M16-B：七套主题（青瓷绿…）都是**浅底**一族，所以一律按 `light` 算 ——
 * `.dark` 变体不参与，颜色全靠 `applyTheme` 里那批重映射的 CSS 变量。
 */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (isThemeId(mode)) return "light";
  if (mode !== "system") return mode;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * 把主题写到 `<html>` 上：
 * - 内置三态（浅色 / 深色 / 跟随系统）：**只切 `.dark` 类**，跟改之前一模一样；
 * - 七套主题（M16-B）：额外把 `--color-*` 那批变量**行内覆盖**成主题算出来的颜色 ——
 *   全应用的 `bg-white` / `text-slate-600` / `bg-indigo-600` 会一起变，不用逐页改类名。
 *   ⚠️ 切回去时必须**按名单逐条删掉**这些变量，否则会残留上一套的颜色。
 */
export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveTheme(theme) === "dark");

  for (const name of THEME_VAR_NAMES) root.style.removeProperty(name);

  const def = isThemeId(theme) ? themeById(theme) : null;
  if (!def) {
    root.removeAttribute(THEME_ATTR);
    return;
  }
  for (const [name, value] of Object.entries(paletteOf(def))) {
    root.style.setProperty(name, value);
  }
  root.setAttribute(THEME_ATTR, def.id);
}

let toastSeq = 0;

export const useUi = create<UiState>((set, get) => ({
  view: "home",
  theme: "light",
  sidebarCollapsed: false,
  hiddenHomeCards: [],
  toasts: [],
  confirm: null,

  setView: (view) => set({ view }),

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    // 当前是"跟随系统"时，按肉眼看到的效果切到相反的那个明确主题
    const next: ThemeMode = resolveTheme(get().theme) === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  hideHomeCard: (key) =>
    set((state) => ({
      hiddenHomeCards: state.hiddenHomeCards.includes(key)
        ? state.hiddenHomeCards
        : [...state.hiddenHomeCards, key],
    })),

  toast: (text, kind = "info", action) => {
    const id = ++toastSeq;
    set((state) => ({ toasts: [...state.toasts, { id, text, kind, action }] }));
    // 带动作的（"撤销"那种）多留一会儿，不然还没看清就没了
    window.setTimeout(() => get().dismissToast(id), action ? 5000 : 2800);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  askConfirm: (request) => set({ confirm: request }),

  closeConfirm: () => set({ confirm: null }),
}));
