/**
 * 扫码同步的「认码」部分（P2-A，2026-10-06）。
 *
 * 电脑上那个二维码里编的就是一行文本：`moye-sync://<ip>:<port>/<token>`
 * （电脑侧由 Rust 的 `qrcode` crate 生成 SVG；解析在 `sync_server::parse_qr_text`）。
 *
 * 🔴 这里的判据必须跟 Rust 那侧**一一对应**（前缀 / 缺端口不认 / 缺 IP 不认 / 缺令牌不认）——
 *    改一边就要改另一边，跟 `marker.rs` ↔ `markers.ts` 那条老规矩一样。
 *
 * 为什么单独一个文件：解析与解码都是**纯函数**，不碰相机、不碰 React，
 * 于是能在验收时直接喂一张图进去验（不必真举着手机）。
 */
import jsQR from "jsqr";

export interface ScannedTarget {
  /** 扫到的原文（整条 URL）—— 直接塞进「电脑地址」那一栏即可：
   *  Rust 侧 `sync_proto::parse_manual` 认整条 URL，那时候不用再填 6 位短码 */
  raw: string;
  /** 给人看的那部分：`192.168.x.x:端口` */
  addr: string;
  /** 令牌（二维码里的那一串） */
  token: string;
}

const PREFIX = "moye-sync://";

/** 认不认得出这条码（跟 `sync_server::parse_qr_text` 同一套判据） */
export function parseScanText(text: string): ScannedTarget | null {
  const raw = (text ?? "").trim();
  if (!raw.startsWith(PREFIX)) return null;
  const rest = raw.slice(PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut <= 0) return null; // 没有 `/` 或在开头 → 缺端口/缺令牌
  const addr = rest.slice(0, cut);
  const token = rest.slice(cut + 1);
  const colon = addr.lastIndexOf(":");
  if (colon <= 0) return null; // 缺 IP 或缺端口
  const ip = addr.slice(0, colon);
  const port = Number(addr.slice(colon + 1));
  if (!ip || !token) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { raw, addr, token };
}

/** 把一帧画面解成二维码文本（解不出来返回 null） */
export function decodeQrFrame(data: Uint8ClampedArray, width: number, height: number): string | null {
  // attemptBoth：深色背景上的浅色码也认（有人把电脑主题调成暗色时拍照会反相）
  const found = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return found ? found.data : null;
}
