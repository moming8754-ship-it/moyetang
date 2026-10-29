/**
 * 手机端「扫一扫」—— 扫电脑上那个二维码来连电脑（P2-A，2026-10-06）。
 *
 * 为什么这么做（而不是装 barcode 插件）：wry 生成的安卓侧**本来就有**
 * `onPermissionRequest`（会申请 CAMERA 权限），所以只要能拿到 `getUserMedia`，
 * 配一个**纯 JS 解码器**（`jsqr`，跟着包一起打进 APK，**不联网**）就够了 ——
 * 不引 Google Play 服务、不引云端识别。
 *
 * 🔴 三条按用户设计稿的默认来（`.spike\P2A-扫码同步-设计稿.html` 底部那张表）：
 * ① 扫到之后**先来一屏「认一下再连」**（同一 WiFi 下可能有好几台电脑，认一下能挡掉连错）；
 * ② **扫到不自动开始同步** —— 同步会改两边数据，必须用户自己再点一次「开始同步」；
 * ③ 相机不行时**就地说清楚**，手输那一块本来就在同一屏（折着），不用再找一层。
 *
 * # 验收抓手（别改名，`tools\m23` 依赖）
 * `data-msscan` · `data-msscan-video` · `data-msscan-hint` · `data-msscan-error`
 * `data-msscan-found` · `data-msscan-addr` · `data-msscan-go` · `data-msscan-retry`
 * `data-msscan-close` · `data-msscan-manual`
 *
 * # 验收钩子
 * 相机没法在电脑上自动点 → 额外听一个 `dsh:scan-result`（`detail.text` 当"扫到的原文"），
 * 走的是**同一条解析 + 同一个界面**（见下面那个 effect 的注释）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeQrFrame, parseScanText, type ScannedTarget } from "./scan";

interface ScanCodeProps {
  /** 用户按了「连这台」—— 上层只负责把地址填好，**不自动开始同步** */
  onPick: (target: ScannedTarget) => void;
  onClose: () => void;
}

type Phase = "starting" | "scanning" | "found" | "error";

export default function ScanCode({ onPick, onClose }: ScanCodeProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState("");
  const [found, setFound] = useState<ScannedTarget | null>(null);
  const [misses, setMisses] = useState(0);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    setPhase("starting");
    setMessage("");
    setFound(null);
    setMisses(0);

    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setMessage("这台机器上没有相机接口（电脑上预览手机界面时就是这样）→ 用手输也一样能同步。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      setPhase("scanning");

      const canvas = document.createElement("canvas");
      let raf = 0;
      let stopped = false;
      const finish = (target: ScannedTarget) => {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((track) => track.stop());
        setFound(target);
        setPhase("found");
      };
      stopRef.current = () => {
        stopped = true;
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((track) => track.stop());
      };

      const tick = () => {
        if (stopped) return;
        const node = videoRef.current;
        if (node && node.readyState >= 2 && node.videoWidth > 0) {
          const w = node.videoWidth;
          const h = node.videoHeight;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(node, 0, 0, w, h);
            const image = ctx.getImageData(0, 0, w, h);
            const text = decodeQrFrame(image.data, w, h);
            if (text) {
              const target = parseScanText(text);
              if (target) {
                finish(target);
                return;
              }
              // 解出来了但不是本软件的码 → 如实说一声，继续扫
              setMisses((n) => n + 1);
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setPhase("error");
      setMessage(
        name === "NotAllowedError"
          ? "没拿到相机权限。到系统设置里给「东方摩耶堂」开一下相机，或者直接用手输。"
          : name === "NotFoundError"
            ? "没找到摄像头。用手输也一样能同步。"
            : "相机打不开：" + String(e).replace(/^Error:\s*/, "") + "（用手输也一样能同步）",
      );
    }
  }, [stop]);

  // 进来自动开相机；退出（关闭/被卸载）一定把轨道关掉，别让相机一直亮着
  useEffect(() => {
    void start();
    return () => stop();
  }, [start, stop]);

  /**
   * 🔴 验收钩子（跟 `features/useFileDrop.ts` 的 `dsh:file-drop`、日报导出的 `dsh:daily-export` 一个路子）：
   * **相机没法在电脑上自动点**，所以额外听一个自定义事件，把"扫到了什么"直接喂进来。
   * 走的仍是同一条解析（`parseScanText`）+ 同一个「认一下再连」界面 —— 只有"从相机拿像素"那一步被换掉，
   * 业务逻辑一份都不复制。真机上的相机路径由用户亲手验（清单见进度.md）。
   */
  useEffect(() => {
    const onFake = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      const target = parseScanText(detail?.text ?? "");
      if (!target) return;
      stop();
      setFound(target);
      setPhase("found");
    };
    window.addEventListener("dsh:scan-result", onFake);
    return () => window.removeEventListener("dsh:scan-result", onFake);
  }, [stop]);

  return (
    <div data-msscan className="absolute inset-0 z-40 flex flex-col bg-slate-900/95 p-3 text-slate-100">
      <div className="flex items-center justify-between pb-2">
        <p className="text-[13px] font-bold">扫电脑上的二维码</p>
        <button type="button" data-msscan-close onClick={onClose} className="rounded-lg px-2 py-1 text-[12px] text-slate-300">
          关闭
        </button>
      </div>

      {/* 取景框 */}
      <div className="relative flex-1 overflow-hidden rounded-2xl border border-slate-700 bg-black">
        <video data-msscan-video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-8 rounded-2xl border-2 border-indigo-400/80" />
        <p data-msscan-hint className="absolute inset-x-0 bottom-2 text-center text-[11.5px] text-slate-300">
          把电脑上那个方块放进框里（电脑：设置 → 同步 → 开始同步）
          {misses > 0 ? ` · 扫到了 ${misses} 次但不是本软件的码` : ""}
        </p>
      </div>

      {phase === "starting" && (
        <p className="pt-2 text-center text-[12px] text-slate-300">正在打开相机…</p>
      )}

      {/* 认一下再连（✅ 用户拍板的默认：要这一屏） */}
      {phase === "found" && found && (
        <div data-msscan-found className="mt-3 rounded-2xl bg-white p-3 text-slate-800 dark:bg-slate-800 dark:text-slate-100">
          <p className="text-[12.5px] font-semibold">认一下再连</p>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">扫到的是这台电脑：</p>
          <p data-msscan-addr className="mt-1 font-mono text-[15px] font-bold tabular-nums">
            {found.addr}
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            令牌 {found.token.slice(0, 6)}…（不用再填那 6 位短码）
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-msscan-go
              onClick={() => {
                stop();
                onPick(found);
              }}
              className="flex-1 rounded-xl bg-indigo-600 py-2 text-[13px] font-medium text-white"
            >
              连这台
            </button>
            <button
              type="button"
              data-msscan-retry
              onClick={() => void start()}
              className="rounded-xl bg-slate-100 px-3 py-2 text-[13px] text-slate-600 dark:bg-slate-700 dark:text-slate-200"
            >
              重扫
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            点「连这台」只是把地址填好；<b>还要自己按一次「开始同步」</b>才会动数据。
          </p>
        </div>
      )}

      {/* 相机不行 → 就地说清楚 + 指回手输 */}
      {phase === "error" && (
        <div data-msscan-error className="mt-3 rounded-2xl bg-white p-3 text-slate-800 dark:bg-slate-800 dark:text-slate-100">
          <p className="text-[12.5px] font-semibold text-rose-600 dark:text-rose-300">相机用不了</p>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">{message}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-msscan-retry
              onClick={() => void start()}
              className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] text-slate-600 dark:bg-slate-700 dark:text-slate-200"
            >
              再试一次
            </button>
            <button
              type="button"
              data-msscan-manual
              onClick={onClose}
              className="flex-1 rounded-xl bg-indigo-600 py-2 text-[13px] font-medium text-white"
            >
              改用手机输
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
