/**
 * 手机端「返回手势 / 返回键」支持（P0-2，2026-10-06 加）
 *
 * # 用户报的现象
 * 在手机上打开一条笔记，**边缘滑动 / 返回键**不是回到列表，而是**直接退到桌面** ✗。
 *
 * # 为什么（定因）
 * 手机外壳是个**状态驱动的单页**（`openNote` / `moreOpen` 这些 React state），
 * 全过程**没有一条 WebView 历史记录**、也**没接 Android 的返回键** ——
 * 于是系统的返回手势找不到"上一层"，只能把 WebView 关掉 = 退出应用。
 *
 * # 怎么修（尽量不碰业务代码）
 * 1. 谁要"可返回"，就调 [`registerBackLayer`] 登记一个"关掉我自己"的回调
 *    （组件卸载 / 关掉自己时**必须**调用返回的注销函数）；
 * 2. 全局只接**一个** `popstate` 监听（放在本模块顶层，只执行一次）：
 *    - 有登记的层级 → 关掉最上面那层，并**立刻再压一条历史**（保证下次返回还有东西可关，不会漏到"退出应用"）；
 *    - 没有层级、但当前不在首页 → 回首页（也是"返回上一层"的合理落点）；
 *    - 都没有（就在首页）→ **不拦**，让返回手势照常退出应用（安卓的正常行为）。
 *
 * # 为什么用 `history` 而不是插件
 * 安卓 WebView 的返回手势**本来就会调 `history.back()`** —— 只要历史栈里有东西，就会触发
 * `popstate`，我们就能接管。这条链路不需要任何新插件、也不碰系统权限。
 */
import { useUi } from "../store/ui";

type Closer = () => boolean;

/** 已登记的层级（后进先出：最上面那层最先被返回关掉） */
const closers: Closer[] = [];
/** 是否已经压过一条"哨兵"历史（有层级时才需要） */
let armed = false;

function arm(): void {
  if (armed) return;
  armed = true;
  try {
    history.pushState({ dshBack: 1 }, "");
  } catch {
    /* 浏览器预览模式等场景：压不进去就算了，退化成"照常退出" */
  }
}

function disarm(): void {
  armed = false;
}

/**
 * 登记一个"可返回层级"。返回**注销函数**（在 useEffect 的清理里调用）。
 *
 * 例：
 * ```ts
 * useEffect(() => {
 *   if (!openNote) return;
 *   return registerBackLayer(() => {
 *     setOpenNote(null);   // 关掉这一层
 *     return true;         // 告诉返回逻辑"我处理了"
 *   });
 * }, [openNote]);
 * ```
 */
export function registerBackLayer(close: Closer): () => void {
  closers.push(close);
  arm();
  return () => {
    const i = closers.indexOf(close);
    if (i >= 0) closers.splice(i, 1);
    if (closers.length === 0) disarm();
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const top = closers.pop();
    if (top) {
      let handled = false;
      try {
        handled = top();
      } catch {
        handled = false;
      }
      // 关掉一层之后**立刻再压一条**：否则下一次返回就没东西可关 → 直接退出应用
      if (handled) {
        try {
          history.pushState({ dshBack: 1 }, "");
          armed = true;
        } catch {
          /* 忽略 */
        }
        return;
      }
    }
    // 没有层级可关：不在首页就回首页；已经在首页 → 不拦（让系统正常退出应用）
    const ui = useUi.getState();
    if (ui.view !== "home") {
      ui.setView("home");
      try {
        history.pushState({ dshBack: 1 }, "");
        armed = true;
      } catch {
        /* 忽略 */
      }
    }
  });
}
