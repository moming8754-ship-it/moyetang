/**
 * 数据目录里的图片怎么显示给前端。
 *
 * 图片存在数据目录的 `assets/` 下（不在前端包里），所以要走 Tauri 的 asset 协议：
 * 后端用 `asset_abs_path` 把相对路径算成绝对路径，前端再用 `convertFileSrc` 变成
 * `asset://` URL。数据目录的放行范围在 Rust 启动时限定为**数据目录这一棵树**。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { isMobileEnv, isMobilePreview } from "../mobile/platform";
import * as api from "./api";

/** 相对路径 → asset URL；同一个路径只算一次 */
const cache = new Map<string, string>();

export async function assetUrl(relPath: string): Promise<string> {
  const hit = cache.get(relPath);
  if (hit) return hit;
  const abs = await api.assetAbsPath(relPath);
  const url = convertFileSrc(abs);
  cache.set(relPath, url);
  return url;
}

/** React 里用的版本：拿到 URL 之前返回 null（图片位置先留个占位） */
export function useAssetUrl(relPath?: string): string | null {
  return useAssetImage(relPath).url;
}

/**
 * [`useAssetUrl`] 的「**会告诉你失败了**」版本 —— 缺图兜底要用它。
 *
 * 为什么要区分 `url === null` 与 `failed`：前者是"还没算出来"，后者是
 * "算不出来"（路径不合法等）。只有后者该立刻出占位，不然会一直转圈。
 */
export function useAssetImage(relPath?: string): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>(() => ({
    url: relPath ? cache.get(relPath) ?? null : null,
    failed: false,
  }));

  useEffect(() => {
    if (!relPath) {
      setState({ url: null, failed: false });
      return;
    }
    const hit = cache.get(relPath);
    if (hit) {
      setState({ url: hit, failed: false });
      return;
    }
    let alive = true;
    assetUrl(relPath)
      .then((value) => {
        if (alive) setState({ url: value, failed: false });
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 图片地址解析失败", error);
        if (alive) setState({ url: null, failed: true });
      });
    return () => {
      alive = false;
    };
  }, [relPath]);

  return state;
}

/**
 * 图不在的时候，那句话该怎么说（2026-10-06，用户真机截图点名的那条）。
 *
 * 两端**不是同一件事**，文案必须分开：
 * - **手机**：`assets/` 根本不参与同步（《同步协议》L34 定的"不传"），所以缺图是**正常状态**
 *   —— 图好端端在电脑上。协议 §L165 早就写了「手机上会看到『图片在电脑上』的占位」。
 * - **电脑**：数据就在本机，缺图就是真找不到（图被删了 / 路径手打错了一个字）。
 *
 * ⚠️ 别在组件里硬编码这两句话，**只有这一处**是口径来源。
 */
export function missingImageText(relPath?: string, compact = false): string {
  if (isMobileEnv() || isMobilePreview()) {
    return compact ? "🖼 在电脑上" : "🖼 图片在电脑上（手机版不传图片）";
  }
  return compact ? "图片没找到" : `图片没找到：${relPath ?? ""}`;
}
