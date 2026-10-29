/**
 * **把「从资源管理器拖一个文件进来」接到组件里**（M7.2）。
 *
 * # 为什么非要用 Tauri 的事件，而不是 HTML5 的 `ondrop`
 * Tauri 的窗口默认 `dragDropEnabled: true` —— 它会**接管**整个 webview 的拖放，
 * 于是页面里那些 `onDrop` / `dragover` **一个都收不到**（合成事件测试却照样通过，
 * 因为合成事件是直接派发到元素上的，绕过了系统这一层）。
 *
 * 2026-09-21 用户实测："小窗功能，已经可以粘贴剪贴板的图片了，
 * 但我拖动图片进入小窗时，依然无法显示" —— 就是这个原因：
 * 小窗当时用的是 HTML5 `onDrop`，真手拖根本到不了。信息区之所以一直好使，
 * 是因为它从一开始就走的是 `getCurrentWebview().onDragDropEvent`。
 *
 * # 对照：**信息区和树状图一直是对的**
 * 信息区的"拖图进来"（`InfoPage.tsx`）和树状图的"把图片拖到节点上"
 * （`TreeNotePane.tsx`）从一开始监听的就是 `getCurrentWebview().onDragDropEvent` ——
 * 这两处的真手拖是好使的。**只有小窗**当时写成了 HTML5 `onDrop`，
 * 而合成事件的验收脚本测不出这个差别（假绿）。这个 hook 是给小窗补上，
 * 顺便把"该怎么写"固化下来，免得下次再有人手写 `onDrop`。
 *
 * # 为什么还留着一个自定义事件
 * `dsh:file-drop` 是**给验收脚本用的钩子**：系统级的拖放没法用脚本伪造，
 * 但"拿到一串路径之后该干什么"这段逻辑必须能自动验（不然只能靠人手点）。
 * 脚本 `window.dispatchEvent(new CustomEvent('dsh:file-drop', {detail:{paths:[...]}}))`
 * 就能把整条处理链跑一遍 —— 而"系统真的会派发事件"这一环，信息区已经用了很久，
 * 是可信的。生产里没人会发这个事件，多一个监听器没有副作用。
 */
import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { inTauri } from "./api";

/** 只看图片（判断靠扩展名；真正的格式校验在后端按文件头魔数做） */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

interface FileDropOptions {
  /** 拖进来的文件路径（已经过滤成图片）；**只在这里做业务**，别的东西不用管 */
  onImages: (paths: string[]) => void;
  /** 拖到窗口上方时（用来给个视觉反馈，可选） */
  onDragStateChange?: (dragging: boolean) => void;
}

/**
 * 监听拖放。组件挂载时注册、卸载时注销 —— 所以"哪个界面在处理拖放"
 * 天然由"谁挂载着"决定（信息区 / 认知区树面板 / 小窗各管各的，不会打架）。
 */
export function useFileDrop({ onImages, onDragStateChange }: FileDropOptions): void {
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          onDragStateChange?.(true);
          return;
        }
        if (payload.type === "drop") {
          onDragStateChange?.(false);
          const images = (payload.paths ?? []).filter(isImagePath);
          if (images.length > 0) onImages(images);
          return;
        }
        onDragStateChange?.(false);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 监听拖放失败", error);
      });

    // 验收脚本用的钩子（见文件头注释）
    const onSynthetic = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: string[] }>).detail;
      const images = (detail?.paths ?? []).filter(isImagePath);
      if (images.length > 0) onImages(images);
    };
    window.addEventListener("dsh:file-drop", onSynthetic);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("dsh:file-drop", onSynthetic);
    };
  }, [onImages, onDragStateChange]);
}
