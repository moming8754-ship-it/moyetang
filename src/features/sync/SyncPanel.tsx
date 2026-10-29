/**
 * 设置页里的「同步」区块（电脑端）
 *
 * 照设计稿 `.spike\M17-sync-entry.html`（四种状态，用户已过目：「行，就放设置页里」）：
 *   ① 平时：上次同步时间 + 「开始同步」+ 同步前快照路径 + 一句"要连同一个 WiFi"
 *   ② 出二维码：**代码生成**的 SVG 二维码 + 5 分钟倒计时 + 三步说明 + 地址/6 位短码
 *   ③ 已连上 / 正在比对 / 正在落地：连的是哪台 + 逐项日志
 *   ④ 出错/超时：明确原因 + 重新开始
 *
 * 🩹 **P1-2**（2026-10-06，用户真机验收报的）改了三件事：
 *   1. **一轮结束就自动收工**（后端 `sync_server::retire`）：成功 / 超时 / 手机断了都不再占着入口。
 *      所以"进行中"要按 **running**（waiting / connected / comparing / applying）判，不能再只认 waiting+connected
 *      —— 否则真同步跑起来的那几秒，界面会退回"开始同步"那一屏，看着像没事干（鬼状态）。
 *   2. **每个"还在进行"的状态都给一个显眼的「结束这次同步」按钮**：出码时、连上后、传的过程中都有，
 *      手机上卡死/关机时点一下就收工，**不用重启程序**（用户当时就是没地方点，只能重启）。
 *   3. 修掉过期文案：手机端那一半（M23）**已经做完了**，不再写"手机端在 M23，做完才能真同步"。
 *      手机那条路目前是**手输地址 + 6 位短码**（扫码留作以后，协议里本来就把它定为兜底）。
 *
 * ⚠️ 二维码是 `<svg>` 由后端用 `qrcode` crate 生成的（协议写死了不能用图片顶替，那样扫不出来）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { syncServerCancel, syncServerStart, syncServerStatus } from "../api";
import type { SyncServerStatus } from "../api";

function mmss(total: number): string {
  const t = Math.max(0, Math.floor(total));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}

function clockTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** 空状态（出错兜底用；`lastResult` 那几项不带也行，Rust 侧都有默认值） */
function blank(message: string): SyncServerStatus {
  return {
    phase: "error",
    address: "",
    remote: "",
    secondsLeft: 0,
    qrSvg: "",
    qrText: "",
    shortCode: "",
    startedAt: "",
    preSnapshot: "",
    lastSyncAt: "",
    message,
    log: [],
    lastResult: "",
    lastMessage: "",
    lastAt: "",
  };
}

export default function SyncPanel() {
  const [state, setState] = useState<SyncServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await syncServerStatus());
    } catch {
      /* 读不到就保持上一份，别让界面闪 */
    }
  }, []);

  // 挂载时读一次；在进行中的时候每秒问一次（倒计时/日志/步骤要动）
  useEffect(() => {
    void refresh();
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh]);

  const phase = state?.phase ?? "loading";
  // ⚠️ 「进行中」= 服务还活着（P1-2：只看 waiting/connected 会让"正在传"那几秒退回平时那一屏）
  const running =
    phase === "waiting" || phase === "connected" || phase === "comparing" || phase === "applying" || phase === "transferring";

  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (running) timer.current = window.setInterval(() => void refresh(), 1000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [running, refresh]);

  const onStart = async () => {
    setBusy(true);
    try {
      setState(await syncServerStart());
    } catch (error) {
      setState(blank(String(error)));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    setBusy(true);
    try {
      setState(await syncServerCancel());
    } finally {
      setBusy(false);
    }
  };

  const logBox = (
    <div
      data-sync-log
      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
    >
      {(state?.log ?? []).map((line, index) => (
        <p key={index}>{line}</p>
      ))}
    </div>
  );

  /** 「结束这次同步」：**任何进行中的状态都挂着它**（P1-2 的第 2 条） */
  const endButton = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-sync-cancel
        data-sync-end
        disabled={busy}
        onClick={() => void onCancel()}
        className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20"
      >
        {busy ? "正在结束…" : "结束这次同步"}
      </button>
      <span className="text-xs text-slate-400">
        手机上卡住了 / 关机了，点这里就能收工（服务关掉、码作废），<b>不用重启程序</b>。
      </span>
    </div>
  );

  return (
    <div data-sync-panel data-sync-phase={phase} className="flex flex-col gap-3">
      {/* ① 平时（没在同步）：上次同步时间 + 上一轮结果 + 开始按钮 */}
      {!running && (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {state?.lastSyncAt ? "上次同步：" + clockTime(state.lastSyncAt) : "还没同步过"}
          </p>
          {/* 🩹 P1-2：一轮结束就会话就摘掉了，所以"上一轮到底成没成"要在这儿交代清楚 */}
          {state?.lastResult === "done" && (
            <p
              data-sync-last-result="done"
              className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
            >
              上一次同步：<b>完成</b>
              {state.lastAt ? "（" + clockTime(state.lastAt) + "）" : ""}。手机上那份账单能看到这次补过来 / 传过去几条。
            </p>
          )}
          {state?.lastResult === "error" && (
            <p
              data-sync-last-result="error"
              className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200"
            >
              上一次同步没成：{state.lastMessage}　点下面的「开始同步」可以再来一次。
            </p>
          )}
          {state?.lastResult === "cancel" && (
            <p data-sync-last-result="cancel" className="text-xs text-slate-400">
              上一次同步：已取消（想同步再点「开始同步」）。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-sync-start
              disabled={busy}
              onClick={() => void onStart()}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "正在准备…" : "开始同步"}
            </button>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              手机和电脑要连<b>同一个 WiFi</b>；电脑开着才能同步，同步只在你们两个设备之间进行。
            </span>
          </div>
          {phase === "error" && state?.message && (
            <p
              data-sync-message
              className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200"
            >
              没能开始：{state.message}
            </p>
          )}
          {state?.preSnapshot && (
            <p className="text-xs text-slate-400">
              同步前快照：<span data-sync-snapshot>{state.preSnapshot}</span>
            </p>
          )}
        </>
      )}

      {/* ② 出二维码（等着手机来连） */}
      {phase === "waiting" && state && (
        <>
          <div className="flex flex-wrap items-start gap-4">
            <div
              data-sync-qr
              // ⚠️ 把二维码**内容**也挂成属性：验收脚本要靠它模拟"手机拿对令牌来连"。
              //    它本来就印在屏幕上那张码里（5 分钟后自动作废），挂属性不多泄露任何东西。
              data-sync-qr-text={state.qrText}
              className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700"
              // ⚠️ 这段 HTML 是后端 `qrcode` crate 生成的 SVG（不是图片、也不是用户内容）
              dangerouslySetInnerHTML={{ __html: state.qrSvg }}
            />
            <div className="flex flex-col gap-2 text-xs text-slate-600 dark:text-slate-300">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                手机扫这个码，或把下面<b>地址 + 6 位短码</b>手输进手机 · 还有{" "}
                <span data-sync-countdown className="tabular-nums">
                  {mmss(state.secondsLeft)}
                </span>
              </p>
              <p>1 · 手机连上跟电脑<b>同一个 WiFi</b></p>
              <p>2 · 手机版 →「更多 → 设置 → 同步电脑」</p>
              <p>3 · 把上面的<b>地址</b>和<b>6 位短码</b>填进去，点「开始同步」</p>
              <p className="text-slate-400">
                连不上？把下面这行地址输进手机也行：
                <span data-sync-address className="ml-1 font-mono">
                  {state.address}
                </span>
              </p>
              <p data-sync-shortcode-row className="text-slate-400">
                6 位短码（手机手输用，跟二维码等效）：
                <span
                  data-sync-shortcode
                  className="ml-1 font-mono text-base font-bold tracking-[0.2em] text-indigo-600 dark:text-indigo-300"
                >
                  {state.shortCode}
                </span>
              </p>
              <p className="text-slate-400">这个码/短码 5 分钟有效，只在你这台电脑上有效；一关掉就作废。</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            同步前快照已留：<span data-sync-snapshot>{state.preSnapshot}</span>
          </p>
          {logBox}
          {endButton}
        </>
      )}

      {/* ③ 手机连上了 / 正在比对 / 正在落地（这些都是一次真同步会走的路） */}
      {running && phase !== "waiting" && state && (
        <>
          <p className="text-sm">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> 已连上：
            <b data-sync-device>{state.remote}</b>
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
              {phase === "comparing" ? "正在比对两边的清单…" : phase === "applying" ? "正在落地…" : state.message}
            </span>
          </p>
          {logBox}
          <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            正在同步：两边都<b>先别改数据</b>；手机那边结束后会显示这次同步的账单。
          </p>
          {endButton}
        </>
      )}
    </div>
  );
}
