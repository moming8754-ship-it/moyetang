/**
 * 手机版 · 技能区（M19.6 / v2.7.0）
 *
 * 照设计稿 `.spike\M18D-rest-zones.html`（技能区那一格）：
 *   两个页签「奖状 / 格言」+ 列表（线分层）+ 「＋」新建 + 每条能删（二次确认）。
 *   技能树已于 2026-10-27 由用户明确永久不做，入口和占位页一起删除。
 *
 * ⚠️ 复用的是电脑版同一批后端命令：`awardList` / `awardCreate` / `awardDelete`、
 *    `mottoList` / `mottoCreate` / `mottoDelete`（这两个区在电脑版里也是**页面自己拉数据**，
 *    不走全局 store —— 手机上照同一个做法）。
 */
import { useEffect, useState } from "react";

import { AssetImage } from "../../components/AssetImage";
import { awardCreate, awardDelete, awardList, mottoCreate, mottoDelete, mottoList } from "../../features/api";
import type { Award, Motto, MottoKind } from "../../features/types";
import { useUi } from "../../store/ui";
import { registerBackLayer } from "../back";

type TabKey = "award" | "motto";

const TABS: { key: TabKey; label: string; ready: boolean }[] = [
  { key: "award", label: "奖状", ready: true },
  { key: "motto", label: "格言", ready: true },
];

const MOTTO_KINDS: { key: MottoKind; label: string }[] = [
  { key: "motto", label: "别人的话" },
  { key: "rule", label: "自己的原则" },
];

export default function SkillZone() {
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<TabKey>("award");
  const [awards, setAwards] = useState<Award[]>([]);
  const [mottos, setMottos] = useState<Motto[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [kind, setKind] = useState<MottoKind>("motto");
  const [delAward, setDelAward] = useState<Award | null>(null);
  const [delMotto, setDelMotto] = useState<Motto | null>(null);
  /**
   * 反馈·1022 #4：点开一张奖状 → **整页详情**（大图 + 全文 + 谁给的/日期/寄语）。
   * 卡片上只留两行摘要，长寄语在详情页里完整看（用户：「寄语没显示完全」）。
   */
  const [openAward, setOpenAward] = useState<Award | null>(null);

  const load = async () => {
    try {
      const [a, m] = await Promise.all([awardList(), mottoList()]);
      setAwards(a);
      setMottos(m);
    } catch {
      setAwards([]);
      setMottos([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // 反馈·1022 #4：详情页接住安卓返回键 —— 先关详情，别直接退应用
  useEffect(() => {
    if (!openAward) return;
    return registerBackLayer(() => {
      setOpenAward(null);
      return true;
    });
  }, [openAward]);

  // ── 奖状详情（整页）：大图 + 标题 + 谁给的/日期 + **完整寄语** ──
  if (openAward) {
    return (
      <div
        data-mobile-zone="skill"
        data-mskill-award-detail={openAward.id}
        className="relative flex h-full flex-col"
      >
        <header className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
          <button
            type="button"
            data-mskill-award-back
            onClick={() => setOpenAward(null)}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 dark:border-slate-700 dark:text-slate-300"
          >
            ‹ 返回
          </button>
          <span className="text-[12px] text-slate-400">奖状详情</span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-1">
          {openAward.assetPath ? (
            <div
              data-mskill-award-detail-img={openAward.id}
              className="overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"
            >
              <AssetImage
                relPath={openAward.assetPath}
                loading={
                  <span className="flex h-40 w-full items-center justify-center text-[11px] text-slate-400">
                    图在加载…
                  </span>
                }
                imgProps={{ draggable: false, className: "w-full object-contain" }}
              />
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center rounded-2xl border border-dashed border-slate-300 text-[11.5px] text-slate-400 dark:border-slate-700">
              这张奖状没有配图
            </div>
          )}

          <h2 className="mt-3 flex items-start gap-1.5 text-[17px] font-semibold leading-snug">
            {openAward.pinned && <span className="text-amber-500">★</span>}
            <span className="min-w-0 break-words">{openAward.title}</span>
          </h2>
          <p className="mt-1 text-[11.5px] text-slate-400">
            {[openAward.issuer, openAward.date].filter(Boolean).join(" · ") ||
              "（还没填谁给的 / 什么时候）"}
          </p>

          {openAward.note ? (
            <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <p className="mb-1 text-[11px] text-slate-400">写给自己的一句话</p>
              <p
                data-mskill-award-detail-note={openAward.id}
                className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-700 dark:text-slate-200"
              >
                {openAward.note}
              </p>
            </div>
          ) : (
            <p className="mt-3 border-t border-slate-100 pt-3 text-[12px] text-slate-400 dark:border-slate-800">
              这张奖状没写寄语
            </p>
          )}
        </div>
      </div>
    );
  }

  const save = async () => {
    const text = draft.trim();
    if (!text) {
      toast("先写点什么吧", "error");
      return;
    }
    if (tab === "award") {
      const one = await awardCreate(text);
      // 顺手把"谁给的"写进去（一个字都不传就只建标题，跟电脑版一样）
      if (one && draftFrom.trim()) {
        const { awardSet } = await import("../../features/api");
        await awardSet(one.id, { issuer: draftFrom.trim() });
      }
    } else {
      const one = await mottoCreate(text, kind);
      if (one && draftFrom.trim()) {
        const { mottoSet } = await import("../../features/api");
        await mottoSet(one.id, { from: draftFrom.trim() });
      }
    }
    setDraft("");
    setDraftFrom("");
    setAddOpen(false);
    await load();
    toast("加好了", "success");
  };

  return (
    <div data-mobile-zone="skill" className="relative flex h-full flex-col">
      {/* 页签 */}
      <div className="flex shrink-0 gap-1.5 px-3 pt-3">
        {TABS.map((one) => (
          <button
            key={one.key}
            type="button"
            data-mskill-tab={one.key}
            data-mskill-tab-ready={one.ready ? "1" : "0"}
            data-mskill-tab-active={tab === one.key ? "1" : "0"}
            onClick={() => setTab(one.key)}
            className={
              "rounded-full border px-3 py-1 text-[11.5px] " +
              (tab === one.key
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400") +
              (one.ready ? "" : " opacity-40")
            }
          >
            {one.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-20 pt-2">
        {tab === "award" && (
          <>
            <p className="px-1 py-1.5 text-[11px] text-slate-400">奖状 · {awards.length} 张</p>
            <ul data-mskill-award-list className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {awards.map((one) => (
                /*
                 * 🔴 2026-10-20（用户反馈 #9）：「**同步后，电脑上自己奖状上的各种信息都无法展现**」。
                 * 真因不是同步、也不是丢数据 —— 是**这张手机卡片只渲染了 标题/谁给的/日期**，
                 * 源码里根本没读 `assetPath` 和 `note`（电脑版卡片上那两样都有）。
                 * 现在补齐：**缩略图**（没图给一个灰底占位，跟电脑版一个意思）+ **写给自己的一句话**。
                 */
                <li key={one.id} data-mskill-award={one.id} className="flex items-start gap-2.5 px-3 py-3">
                  {/* 反馈·1022 #4：整张卡片可点 → 进详情页（「删」那颗留在外面，不跟它抢点击） */}
                  <button
                    type="button"
                    data-mskill-award-open={one.id}
                    onClick={() => setOpenAward(one)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                  >
                  {one.assetPath ? (
                    <div
                      data-mskill-award-img={one.id}
                      className="h-12 w-12 shrink-0 overflow-hidden rounded-lg ring-1 ring-slate-200 dark:ring-slate-700"
                    >
                      <AssetImage
                        relPath={one.assetPath}
                        compact
                        loading={
                          <span className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">图</span>
                        }
                        imgProps={{ draggable: false, className: "h-full w-full object-cover" }}
                      />
                    </div>
                  ) : (
                    <div
                      data-mskill-award-nophoto={one.id}
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[10px] text-slate-400 dark:bg-slate-800"
                    >
                      无图
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">
                      {one.pinned && <span className="mr-1 text-amber-500">★</span>}
                      {one.title}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-slate-400">
                      {[one.issuer, one.date].filter(Boolean).join(" · ") || "（还没填谁给的 / 什么时候）"}
                    </p>
                    {one.note && (
                      <p
                        data-mskill-award-note={one.id}
                        className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400"
                      >
                        {one.note}
                      </p>
                    )}
                  </div>
                  </button>
                  <button
                    type="button"
                    data-mskill-award-del={one.id}
                    onClick={() => setDelAward(one)}
                    className="shrink-0 text-[11px] text-rose-600 dark:text-rose-400"
                  >
                    删
                  </button>
                </li>
              ))}
              {awards.length === 0 && <li className="px-3 py-6 text-center text-[12.5px] text-slate-400">还没有奖状</li>}
            </ul>
          </>
        )}

        {tab === "motto" && (
          <>
            <p className="px-1 py-1.5 text-[11px] text-slate-400">格言 · {mottos.length} 条</p>
            <ul data-mskill-motto-list className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {mottos.map((one) => (
                <li key={one.id} data-mskill-motto={one.id} className="flex items-start gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-relaxed">{one.text}</p>
                    <p className="mt-0.5 text-[10.5px] text-slate-400">
                      {one.kind === "rule" ? "自己的原则" : "别人的话"}
                      {one.from ? " · " + one.from : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-mskill-motto-del={one.id}
                    onClick={() => setDelMotto(one)}
                    className="shrink-0 text-[11px] text-rose-600 dark:text-rose-400"
                  >
                    删
                  </button>
                </li>
              ))}
              {mottos.length === 0 && <li className="px-3 py-6 text-center text-[12.5px] text-slate-400">还没有格言</li>}
            </ul>
          </>
        )}
      </div>

      {/* 「＋」新建 */}
      <button
        type="button"
        data-mskill-fab
        aria-label="新建"
        onClick={() => setAddOpen(true)}
        className="absolute bottom-4 right-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg active:bg-indigo-700"
      >
        <svg viewBox="0 0 24 24" style={{ width: 22, height: 22 }} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {/* 新建面板 */}
      {addOpen && (
        <div data-mskill-add-sheet className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40" onClick={() => setAddOpen(false)}>
          <div className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="px-1 pb-2 text-sm font-bold">{tab === "award" ? "新建奖状" : "新建格言"}</p>
            <textarea
              data-mskill-add-input
              autoFocus
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={tab === "award" ? "比如：校级三好学生" : "那句话本身…"}
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
            />
            <input
              data-mskill-add-from
              value={draftFrom}
              onChange={(event) => setDraftFrom(event.target.value)}
              placeholder={tab === "award" ? "谁给的（可留空）" : "谁说的 / 出处（可留空）"}
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-[12.5px] dark:border-slate-700 dark:bg-slate-800"
            />
            {tab === "motto" && (
              <div className="mt-2 flex gap-1.5">
                {MOTTO_KINDS.map((one) => (
                  <button
                    key={one.key}
                    type="button"
                    data-mskill-add-kind={one.key}
                    onClick={() => setKind(one.key)}
                    className={
                      "rounded-full border px-2.5 py-1 text-[11.5px] " +
                      (kind === one.key ? "border-indigo-400 text-indigo-600 dark:text-indigo-300" : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
                    }
                  >
                    {one.label}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <button type="button" data-mskill-add-save onClick={() => void save()} className="rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white">
                加上
              </button>
              <button type="button" data-mskill-add-close onClick={() => setAddOpen(false)} className="rounded-xl border border-slate-200 px-3 py-2 text-[13px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
                收起
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认 */}
      {(delAward || delMotto) && (
        <div data-mskill-confirm className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6" onClick={() => { setDelAward(null); setDelMotto(null); }}>
          <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] leading-relaxed">
              删掉{delAward ? "奖状「" + delAward.title + "」" : "格言「" + (delMotto?.text ?? "").slice(0, 20) + "」"}？删之前会自动留一份档。
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-mskill-confirm-del
                onClick={() => {
                  const a = delAward;
                  const m = delMotto;
                  setDelAward(null);
                  setDelMotto(null);
                  void (a ? awardDelete(a.id) : m ? mottoDelete(m.id) : Promise.resolve(false)).then(() => load());
                }}
                className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white"
              >
                删除
              </button>
              <button
                type="button"
                data-mskill-confirm-cancel
                onClick={() => {
                  setDelAward(null);
                  setDelMotto(null);
                }}
                className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
