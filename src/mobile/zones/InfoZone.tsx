/**
 * 手机版 · 信息区（M19.2 / v2.3.0）
 *
 * 照设计稿 `.spike\M18C-info-cognition.html`（用户已过目通过）：
 *   ① 列表：搜索一行 + 横滑筛选（全部 / 待联动 / 已联动 / 分类）
 *   ② 每条：文字 + 状态标签 + 分类 + 图片缩略图（点开看大图）
 *   ③ 抬手就记：点「＋」从底下弹出输入条 + 从相册选图；
 *      🔴 点「记下」才保存（电脑版是回车即存；手机键盘的回车是换行）
 *
 * ⚠️ 逻辑全部复用电脑版：`updateInfo` / `deleteInfo` / `linkToNote` / `linkToTodo` / `archiveOne`、
 *    `assetImport`（把外部图片复制进 assets/）、`CategoryPicker`、`ImageViewer`、`AssetImage`。
 * ⚠️ 视觉跟电脑版 D 批一致：**一个面板 + 条目间细线**（线分层），不是每条一个圆角框。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import CategoryPicker from "../../components/CategoryPicker";
import ImageViewer from "../../components/ImageViewer";
import { inTauri } from "../../features/api";
import { AssetImage } from "../../components/AssetImage";
import { CATEGORY_GROUPS, categoryGroupOf, categoryLeafOf } from "../../features/types";
import type { Info, InfoStatus, Link } from "../../features/types";
import { formatStamp } from "../../shared/daytime";
import { fileToBase64 } from "../../shared/imageFile";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { isMobileEnv } from "../platform";
import { registerBackLayer } from "../back";

const STATUS_TABS: { key: "all" | InfoStatus; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待联动" },
  { key: "linked", label: "已联动" },
];

/** 一条信息的缩略图（点开看大图） */
function Thumb({ relPath, onOpen }: { relPath: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="点击看大图"
      className="h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-1 ring-slate-200 dark:ring-slate-700"
    >
      <AssetImage
        relPath={relPath}
        compact
        loading={
          <span className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
            图片
          </span>
        }
        imgProps={{ draggable: false, className: "h-full w-full object-cover" }}
      />
    </button>
  );
}

export default function InfoZone() {
  const infos = useData((s) => s.infos);
  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：`const config = useData((s) => s.config);` 原来在这儿
  //    —— 只给「收进档案库」那颗读 `archive.enabled` 用，那颗去掉后就不需要了。
  const refresh = useData((s) => s.refresh);
  const updateInfo = useData((s) => s.updateInfo);
  const deleteInfo = useData((s) => s.deleteInfo);
  const linkToNote = useData((s) => s.linkToNote);
  const linkToTodo = useData((s) => s.linkToTodo);
  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：`archiveOne` 原来在这儿
  //    （⋮ 里那颗「收进档案库」用的）—— 那颗按用户要求去掉了，这个也不用了。

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | InfoStatus>("all");
  const [group, setGroup] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);

  const [menuFor, setMenuFor] = useState<Info | null>(null);
  const [confirmDel, setConfirmDel] = useState<Info | null>(null);
  const [catFor, setCatFor] = useState<Info | null>(null);
  const [viewImg, setViewImg] = useState<string | null>(null);

  const [quickOpen, setQuickOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  /** 手机选图用的隐藏 input（`plugin-dialog` 在安卓上不工作，见 `pickImage`） */
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const toast = useUi((s) => s.toast);

  // P0-2：返回手势先关浮层
  const backSheetOpen = !!(menuFor || confirmDel);
  useEffect(() => {
    if (!backSheetOpen) return;
    return registerBackLayer(() => {
      setMenuFor(null);
      setConfirmDel(null);
      return true;
    });
  }, [backSheetOpen]);

  // ⚠️ 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：这里原来还有一行
  //    `const archiveEnabled = config.archive.enabled;`（⋮ 里那颗「收进档案库」的开关）
  //    —— 那颗按用户要求去掉了，这一行也去掉了。

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return infos
      .filter((info) => {
        if (status !== "all" && info.status !== status) return false;
        if (group && !info.categories.some((one) => categoryGroupOf(one) === group)) return false;
        if (!q) return true;
        return info.text.toLowerCase().includes(q) || info.categories.some((one) => one.toLowerCase().includes(q));
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [infos, query, status, group]);

  /**
   * 从相册/文件里选一张图 → 写进 `assets/` → 建成一条图片信息。
   *
   * 🔴 2026-10-07 修的真 bug（用户报「手机版信息区无法导入图片，点了没反应」）：
   *    原来走的是 `@tauri-apps/plugin-dialog` 的 `open()` —— **这个插件在安卓上用不了**
   *    （桌面能弹文件框，手机上点下去什么都不会发生，连报错都没有，最难查的那种）。
   *    现在改成 `<input type="file" accept="image/*">`：安卓 WebView 会**直接调起系统相册/文件**，
   *    拿到的 `File` 走 `fileToBase64` → `asset_write_image`（和树页挂图、悬浮球导入图片**同一条路**）。
   *    电脑版那条路留着（桌面用系统文件框更顺手）—— 两边都试过再决定要不要统一。
   */
  const pickImage = async () => {
    if (!inTauri()) return;
    if (!isMobileEnv()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({
          multiple: false,
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
        });
        if (typeof picked !== "string") return;
        const { assetImport, infoCreate } = await import("../../features/api");
        const rel = await assetImport(picked);
        await infoCreate(draft.trim(), "image", [], rel);
        await refresh();
        setDraft("");
        setQuickOpen(false);
      } catch (error) {
        console.warn("选图失败", error);
        toast("选图失败：" + String(error), "error");
      }
      return;
    }
    // 手机：交给隐藏的 file input（系统相册）
    imageInputRef.current?.click();
  };

  /** 手机上真的选了图之后走这里 */
  const importPickedFile = async (file: File) => {
    try {
      const base64 = await fileToBase64(file);
      const { assetWriteImage, infoCreate } = await import("../../features/api");
      const rel = await assetWriteImage(base64);
      await infoCreate(draft.trim(), "image", [], rel);
      await refresh();
      setDraft("");
      setQuickOpen(false);
      toast("图片存进来了（在 assets/ 里）");
    } catch (error) {
      toast("导入图片失败：" + String(error), "error");
    }
  };

  /** 保存（**只有点这个才写盘**） */
  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    try {
      const { infoCreate } = await import("../../features/api");
      await infoCreate(text);
      await refresh();
      setDraft("");
      setQuickOpen(false);
    } finally {
      setSaving(false);
    }
  };

  /** 电脑版点链接 chip 会跳过去定位；手机版跨区定位等后续区做完再补，这里先留痕 */
  const doJump = (link: Link) => console.info("跳转", link);

  return (
    <div data-mobile-zone="info" className="relative flex h-full flex-col">
      {/* 搜索 + 横滑筛选 */}
      <div className="shrink-0 px-3 pt-3">
        <input
          data-minfo-search
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索信息文字…"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
        />
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-minfo-status={tab.key}
              data-minfo-status-active={status === tab.key ? "1" : "0"}
              onClick={() => setStatus(tab.key)}
              className={
                "shrink-0 rounded-full border px-3 py-1 text-[11px] " +
                (status === tab.key
                  ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                  : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
              }
            >
              {tab.label}
            </button>
          ))}
          <button
            type="button"
            data-minfo-group
            onClick={() => setGroupOpen((v) => !v)}
            className={
              "shrink-0 rounded-full border px-3 py-1 text-[11px] " +
              (group
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400")
            }
          >
            {group || "所有分类"} ▾
          </button>
        </div>
        {groupOpen && (
          <div
            data-minfo-group-list
            className="mt-1 flex flex-wrap gap-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700"
          >
            <button
              type="button"
              data-minfo-group-pick=""
              onClick={() => {
                setGroup("");
                setGroupOpen(false);
              }}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] dark:bg-slate-800"
            >
              所有分类
            </button>
            {CATEGORY_GROUPS.map((one) => (
              <button
                key={one}
                type="button"
                data-minfo-group-pick={one}
                onClick={() => {
                  setGroup(one);
                  setGroupOpen(false);
                }}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] dark:bg-slate-800"
              >
                {one}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 列表：线分层 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-20 pt-2">
        {infos.length === 0 && (
          <p
            data-minfo-empty
            className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-[13px] text-slate-400 dark:border-slate-700"
          >
            还没有信息。想到什么就先丢进来。
          </p>
        )}
        {infos.length > 0 && filtered.length === 0 && (
          <p
            data-minfo-nomatch
            className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-[13px] text-slate-400 dark:border-slate-700"
          >
            当前筛选下没有信息。
          </p>
        )}
        {filtered.length > 0 && (
          <ul
            data-minfo-list
            data-minfo-count={filtered.length}
            className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
          >
            {filtered.map((info) => (
              <li key={info.id} data-minfo-item={info.id} className="p-3">
                <div className="flex items-start gap-3">
                  {info.assetPath && <Thumb relPath={info.assetPath} onOpen={() => setViewImg(info.assetPath!)} />}
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                      {info.text || (info.assetPath ? "" : "（无文字）")}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
                      <span>{formatStamp(info.createdAt)}</span>
                      <span
                        className={
                          info.status === "linked"
                            ? "rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : "rounded-full bg-amber-50 px-2 py-0.5 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                        }
                      >
                        {info.status === "linked" ? "已联动" : "待联动"}
                      </span>
                      {info.categories.map((category) => (
                        <span key={category} className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                          {categoryGroupOf(category)}·{categoryLeafOf(category)}
                        </span>
                      ))}
                      {info.links.map((link) => (
                        <button
                          key={`${link.targetKind}-${link.targetId}`}
                          type="button"
                          onClick={() => doJump(link)}
                          className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
                        >
                          → {link.targetKind === "note" ? "认知区" : "待办"}《{link.titleSnapshot}》
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-minfo-menu={info.id}
                    aria-label="这一条的操作"
                    onClick={() => setMenuFor(info)}
                    className="shrink-0 px-1.5 text-slate-400"
                  >
                    ⋮
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 「＋」抬手就记 */}
      <button
        type="button"
        data-minfo-fab
        aria-label="记一条信息"
        onClick={() => setQuickOpen(true)}
        className="absolute bottom-4 right-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg active:bg-indigo-700"
      >
        <svg
          viewBox="0 0 24 24"
          style={{ width: 22, height: 22 }}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {/* 快速记录 */}
      {quickOpen && (
        <div
          data-minfo-quick
          className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40"
          onClick={() => setQuickOpen(false)}
        >
          <div
            className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-1 pb-2 text-sm font-bold">记一条信息</p>
            <textarea
              data-minfo-quick-input
              autoFocus
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="随手记一条…"
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                data-minfo-quick-save
                disabled={saving || draft.trim().length === 0}
                onClick={() => void save()}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50"
              >
                {saving ? "保存中…" : "记下"}
              </button>
              <button
                type="button"
                data-minfo-quick-pick
                onClick={() => void pickImage()}
                className="rounded-xl border border-slate-200 px-3 py-2 text-[13px] text-slate-600 dark:border-slate-700 dark:text-slate-300"
              >
                从相册选图
              </button>
              {/* 手机真的用系统相册：安卓 WebView 认得 file input（`plugin-dialog` 在那边不可用）。
                  ⚠️ 选完必须把 value 清掉，否则同一张图选第二次不触发 change。 */}
              <input
                ref={imageInputRef}
                data-minfo-image-input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importPickedFile(file);
                }}
              />
            </div>
            <p className="mt-2 px-1 text-[10.5px] leading-relaxed text-slate-400">
              手机键盘的回车是换行，所以这里点「记下」才保存（电脑版是回车即存）。
            </p>
            <button
              type="button"
              data-minfo-quick-close
              onClick={() => setQuickOpen(false)}
              className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              收起
            </button>
          </div>
        </div>
      )}

      {/* 单条操作菜单 */}
      {menuFor && (
        <div
          data-minfo-menu-sheet
          className="absolute inset-0 z-30 flex flex-col justify-end bg-slate-900/40"
          onClick={() => setMenuFor(null)}
        >
          <div
            className="rounded-t-2xl border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-1 pb-2 text-[13px] font-bold">这一条</p>
            <div className="flex flex-col">
              <button
                type="button"
                data-minfo-menu-action="category"
                onClick={() => {
                  setCatFor(menuFor);
                  setMenuFor(null);
                }}
                className="py-2.5 text-left text-[13px]"
              >
                分类（{menuFor.categories.length}）
              </button>
              <button
                type="button"
                data-minfo-menu-action="note"
                onClick={() => {
                  void linkToNote(menuFor.id);
                  setMenuFor(null);
                }}
                className="border-t border-slate-100 py-2.5 text-left text-[13px] text-indigo-600 dark:border-slate-800 dark:text-indigo-300"
              >
                联动到认知区
              </button>
              <button
                type="button"
                data-minfo-menu-action="todo"
                onClick={() => {
                  void linkToTodo(menuFor.id);
                  setMenuFor(null);
                }}
                className="border-t border-slate-100 py-2.5 text-left text-[13px] text-emerald-600 dark:border-slate-800 dark:text-emerald-300"
              >
                建为待办
              </button>
              {/* 🔴 2026-10-11（v2.21.1 · 用户反馈第 2c 条）：手机信息区的「收进档案库」
                  **按用户要求去掉了**（跟电脑版 `InfoPage.tsx` 同一处）。要收东西进档案，
                  去认知区列表那一行点 ⋮ —— 那里有「收进档案库」。 */}
              <button
                type="button"
                data-minfo-menu-action="delete"
                onClick={() => {
                  setConfirmDel(menuFor);
                  setMenuFor(null);
                }}
                className="border-t border-slate-100 py-2.5 text-left text-[13px] text-rose-600 dark:border-slate-800 dark:text-rose-400"
              >
                删除…
              </button>
            </div>
            <button
              type="button"
              data-minfo-menu-close
              onClick={() => setMenuFor(null)}
              className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              收起
            </button>
          </div>
        </div>
      )}

      {/* 删除二次确认 */}
      {confirmDel && (
        <div
          data-minfo-confirm
          className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-6"
          onClick={() => setConfirmDel(null)}
        >
          <div className="w-full rounded-2xl bg-white p-4 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] leading-relaxed">删掉这条信息？删之前会自动留一份档。</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-minfo-confirm-del
                onClick={() => {
                  const one = confirmDel;
                  setConfirmDel(null);
                  void deleteInfo(one.id);
                }}
                className="flex-1 rounded-xl bg-rose-600 py-2 text-[13px] font-medium text-white"
              >
                删除
              </button>
              <button
                type="button"
                data-minfo-confirm-cancel
                onClick={() => setConfirmDel(null)}
                className="flex-1 rounded-xl bg-slate-100 py-2 text-[13px] dark:bg-slate-800"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 分类选择器（复用电脑版组件） */}
      {catFor && (
        <CategoryPicker
          value={catFor.categories}
          onCancel={() => setCatFor(null)}
          onSave={(values) => {
            const one = catFor;
            setCatFor(null);
            void updateInfo({ ...one, categories: values }, "分类已更新");
          }}
        />
      )}

      {/* 看图（复用电脑版） */}
      <ImageViewer relPath={viewImg} onClose={() => setViewImg(null)} />
    </div>
  );
}
