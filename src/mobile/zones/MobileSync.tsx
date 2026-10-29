/**
 * 手机版 · 同步（M23 / v2.13.0；扫码入口是 P2-A，2026-10-06）
 *
 * 设计意图：手机和电脑连**同一个 WiFi**，电脑上「设置 → 同步 → 开始同步」会显示
 * **二维码**（里面是 `moye-sync://ip:端口/令牌`）、**地址**和 **6 位短码**。
 * 手机这边有**两条路**：
 * ① **扫一扫**（P2-A 新加，主路）：对着电脑屏幕扫一下就自动填好地址；
 * ② **手输地址 + 6 位短码**（老路，兜底）：**折在同一屏**里，相机不行时不用再找一层。
 *
 * 🔴 三条按用户设计稿的默认（`.spike\P2A-扫码同步-设计稿.html`）：
 * 扫到先「认一下再连」· **扫到不自动开始同步**（数据的事必须用户自己再点一次）· 手输折在第一屏。
 *
 * # 诚实边界（界面上一律写明，不吹）
 * - 同步**只在同一个 WiFi 下**能成；在外面用流量连不上。
 * - **冲突不替用户做选择**：引擎把两份都留（一份带「（冲突副本）」），这里如实列出来；
 *   「只留一份」的操作**这版没做**（要去对应的区自己删掉那一份）。
 * - 同步前**两边都会各留一份副本**（电脑侧与手机侧各自 `local_snapshot`），出问题能退回。
 * - 图片/附件**第一版不传**（协议里写死的）。
 *
 * # 验收抓手（别改名，`tools\m23` 依赖）
 * `data-msync` · `data-msync-scan` · `data-msync-manual-toggle` · `data-msync-addr`
 * `data-msync-code` · `data-msync-go` · `data-msync-bill` · `data-msync-error`
 * `data-msync-conflicts` · `data-msync-copy` · `data-msync-close` · `data-msync-scan-note`
 * （扫码浮层自己的抓手在 `ScanCode.tsx` 头部）
 */
import { useState } from "react";

import { syncClientNow } from "../../features/api";
import type { SyncOutcome } from "../../features/api";
import ScanCode from "./ScanCode";
import type { ScannedTarget } from "./scan";

export default function MobileSync({ onClose }: { onClose: () => void }) {
  const [addr, setAddr] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<SyncOutcome | null>(null);
  const [err, setErr] = useState("");
  /** 扫码浮层开着吗 */
  const [scanOpen, setScanOpen] = useState(false);
  /** 手输那块展开吗（设计稿定的默认：**折在第一屏**） */
  const [manualOpen, setManualOpen] = useState(false);
  /** 扫到并「连这台」之后，如实告诉用户填了什么（但**没有**自动开始同步） */
  const [scanNote, setScanNote] = useState("");

  const go = async () => {
    const target = addr.trim();
    if (!target || busy) return;
    setBusy(true);
    setErr("");
    setOut(null);
    try {
      const r = await syncClientNow(target, code.trim() || null);
      setOut(r);
      if (!r.ok) setErr(r.message || "这次没同步成");
    } catch (e) {
      // ⚠️ 这里要**分两种**（2026-10-06 被套件第 11 条逮住：把"电脑拒绝"说成了"连不上"，
      //    那会让人跑去查 WiFi，白费功夫）：
      //     ① 根本没连上（不同 WiFi / 电脑没点开始同步 / 码过期）→ 说"连不上" + 三条排查
      //     ② **连上了但电脑拒绝**（比如短码抄错 → 403）→ 原样说清"电脑拒了、为什么"
      const raw = String(e).replace(/^Error:\s*/, "");
      setErr(/电脑回了|电脑拒绝|\b(400|403|404|500)\b/.test(raw) ? raw : "连不上电脑：" + raw);
    } finally {
      setBusy(false);
    }
  };

  const takeScan = (target: ScannedTarget) => {
    // 整条 URL 直接进「电脑地址」——Rust 侧 `parse_manual` 认它，那时候不用再填短码
    setAddr(target.raw);
    setCode("");
    setManualOpen(true);
    setScanNote("扫到了 " + target.addr + "（还要按下面的「开始同步」才会连）");
    setScanOpen(false);
  };

  return (
    <div data-msync className="relative flex flex-col">
      <p className="px-1 pb-2 text-[13px] font-bold">同步电脑</p>

      <p className="px-1 pb-2 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
        手机和电脑连<b>同一个 WiFi</b>。电脑上「设置 → 同步 → 开始同步」会出个<b>二维码</b>，
        用下面第一个按钮<b>扫一下</b>就行；扫不了再用手输（地址 + 6 位短码）。
      </p>

      {/* 主路：扫一扫 */}
      <button
        type="button"
        data-msync-scan
        onClick={() => setScanOpen(true)}
        className="w-full rounded-xl bg-indigo-600 py-2.5 text-[13.5px] font-medium text-white"
      >
        扫二维码连电脑
      </button>

      {scanNote && (
        <p data-msync-scan-note className="mt-2 rounded-xl bg-emerald-50 px-3 py-2 text-[11.5px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
          {scanNote}
        </p>
      )}

      {/* 兜底：手输（**折在同一屏**，相机不行时不用再找一层） */}
      <button
        type="button"
        data-msync-manual-toggle
        onClick={() => setManualOpen((open) => !open)}
        className="mt-2 w-full rounded-xl border border-slate-200 py-2 text-[12.5px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
      >
        {manualOpen ? "收起手输 ▲" : "手输地址和短码 ▾"}
      </button>

      {manualOpen && (
        <div data-msync-manual className="mt-1">
          <label className="px-1 pt-1 text-[11.5px] text-slate-400">电脑地址</label>
          <input
            data-msync-addr
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="192.168.1.5:32123"
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />

          <label className="px-1 pt-2 text-[11.5px] text-slate-400">6 位短码（电脑上那六个数字）</label>
          <input
            data-msync-code
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[13px] tabular-nums outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
          />
          <p className="px-1 pt-1.5 text-[11px] text-slate-400">
            扫过码的话这一栏不用填（地址里已经带着令牌了）。
          </p>
        </div>
      )}

      <button
        type="button"
        data-msync-go
        disabled={busy || addr.trim().length === 0}
        onClick={() => void go()}
        className={
          "mt-3 w-full rounded-xl py-2 text-[13.5px] font-medium text-white " +
          (busy || addr.trim().length === 0 ? "bg-slate-300 dark:bg-slate-700" : "bg-indigo-600")
        }
      >
        {busy ? "正在同步…（两边先别改东西）" : "开始同步"}
      </button>

      {/* 账单 */}
      {out && out.ok && (
        <div data-msync-bill className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
          <p className="text-[12.5px] font-semibold text-emerald-800 dark:text-emerald-200">
            同步完成（对方：{out.device || "电脑"}）
          </p>
          <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
            {[
              { k: "补过来", v: out.bill.adopted },
              { k: "传过去", v: out.bill.sent },
              { k: "冲突", v: out.bill.conflicts },
              { k: "删掉", v: out.bill.deleted },
            ].map((one) => (
              <div key={one.k} className="rounded-lg bg-white/70 py-1.5 dark:bg-slate-900/50">
                <p className="text-[16px] font-bold tabular-nums">{one.v}</p>
                <p className="text-[10.5px] text-slate-500">{one.k}</p>
              </div>
            ))}
          </div>

          {/* M26：图片那一趟（只在真的动了图的时候才占地方） */}
          {out.bill.assetsAdopted + out.bill.assetsSent + out.bill.assetsDeferred > 0 && (
            <p data-msync-assets className="mt-2 rounded-lg bg-white/70 px-2 py-1.5 text-[11.5px] text-emerald-900 dark:bg-slate-900/50 dark:text-emerald-100">
              🖼 图片：补过来 <b>{out.bill.assetsAdopted}</b> 张 / 传过去 <b>{out.bill.assetsSent}</b> 张
              {out.bill.assetsDeferred > 0 && (
                <>　·　还有 <b>{out.bill.assetsDeferred}</b> 张下次接着传（一次不搬太多）</>
              )}
            </p>
          )}
          {out.bill.assetsClash.length > 0 && (
            <p data-msync-assets-clash className="mt-1 rounded-lg bg-white/70 px-2 py-1.5 text-[11.5px] text-amber-800 dark:bg-slate-900/50 dark:text-amber-200">
              ⚠️ 有 {out.bill.assetsClash.length} 张图两边同名但内容不一样 —— <b>两边都留着了，谁也没覆盖谁</b>
            </p>
          )}

          {out.message && <p className="mt-2 text-[11.5px] text-emerald-800/80 dark:text-emerald-200/80">{out.message}</p>}
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            同步前两边各留了一份副本；图片是<b>只增不删</b>——这边只多不少，绝不删你的图。
          </p>
        </div>
      )}

      {/* 冲突：两份都留着了，如实列出来 */}
      {out && out.ok && out.bill.conflicts > 0 && (
        <div data-msync-conflicts className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-[12.5px] font-semibold text-amber-800 dark:text-amber-200">
            有 {out.bill.conflicts} 条两边都改过 —— <b>两份都留着了，没丢内容</b>
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {out.bill.copies.map((one) => (
              <li key={one} data-msync-copy={one} className="text-[11.5px] text-amber-800/90 dark:text-amber-200/90">
                · {one}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            「只留一份」这版还没做：想去掉哪份，就去对应的区把带「（冲突副本）」的那条删掉。
          </p>
        </div>
      )}

      {/* 出错：给排查方向，不糊技术报错 */}
      {err && (
        <div data-msync-error className="mt-2 rounded-xl border border-rose-300 bg-rose-50 p-3 dark:border-rose-500/40 dark:bg-rose-500/10">
          <p className="text-[12.5px] font-semibold text-rose-800 dark:text-rose-200">{err}</p>
          <ul className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] text-rose-800/85 dark:text-rose-200/85">
            <li>· 手机和电脑是不是连的<b>同一个 WiFi</b>（手机别用流量）</li>
            <li>· 电脑上有没有点「开始同步」（那串码只有 5 分钟有效）</li>
            <li>· 地址和 6 位短码是不是抄错了</li>
          </ul>
        </div>
      )}

      <button
        type="button"
        data-msync-close
        onClick={onClose}
        className="mt-3 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
      >
        收起
      </button>

      {/* 扫一扫（浮层） */}
      {scanOpen && <ScanCode onClose={() => setScanOpen(false)} onPick={takeScan} />}
    </div>
  );
}
