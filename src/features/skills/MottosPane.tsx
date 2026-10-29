/**
 * 格言与原则（M12-C）—— 技能区的第三块。
 *
 * # 这块的设计要点（都是用户点名要的）
 * - **简洁、一眼看懂**：只有两个字段（那句话 + 谁说的），点句子**就地改**，不跳页、不开侧栏；
 * - **今天这一句**：顶上聚一句，**按本地日期挑**（同一天固定不变、跨天才换，不是每次刷新都跳）；
 * - **随便翻一句**：按钮翻一条旧的出来看看（和奖状区那个彩蛋一个意思）；
 * - 🔴 **没有置顶** —— 用户 2026-09-26 明确说"去掉置顶功能"（格言不该排序），顺序就只有一条：新写的在最前。
 *
 * # 不会踩的两个坑（V1 攒下来的）
 * - 编辑框**非受控 + `key` 带 id**：正在打的字永远不会被程序回填搅乱；
 * - 额外听一次 `data-changed`：**导入备份是整体换数据**，不重拉就会显示旧的那几句。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri, mottoCreate, mottoDelete, mottoList, mottoSet } from "../api";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import type { Motto, MottoKind } from "../types";
import {
  attribution,
  countBy,
  filterMottos,
  KIND_LABEL,
  ordered,
  randomMotto,
  todayMotto,
} from "./mottos";
import type { MottoFilter } from "./mottos";

export default function MottosPane() {
  const toast = useUi((s) => s.toast);
  const askConfirm = useUi((s) => s.askConfirm);
  const config = useData((s) => s.config);
  const saveConfig = useData((s) => s.saveConfig);

  /**
   * M13-C：把这一句**挂到专注小窗**上（用户点了「留一整天」，所以写进 config：
   * `focus.mottoPickDate` = 今天，`focus.mottoPickId` = 这一条；第二天自动回到"今天这一句"）。
   */
  const pinToFocus = useCallback(
    async (id: string) => {
      const now = new Date();
      const today = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
      await saveConfig(
        { focus: { ...config.focus, mottoPickDate: today, mottoPickId: id } },
        "已挂到专注小窗（今天都显示这一句）",
      );
    },
    [config.focus, saveConfig],
  );

  const [items, setItems] = useState<Motto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<MottoFilter>("all");
  /** 新写的那句算"格言"还是"原则"（默认原则 —— 他主要是在给自己定规矩） */
  const [addKind, setAddKind] = useState<MottoKind>("rule");
  const [addText, setAddText] = useState("");
  /** 正在就地编辑哪一条 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<MottoKind>("rule");
  /** 聚光灯：null = "今天这一句"；点了"随便翻一句"就临时换成翻到的那条 */
  const [spotId, setSpotId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void mottoList()
      .then((list) => {
        if (alive) {
          setItems(list);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setLoaded(true);
          toast(`读格言失败：${String(error)}`, "error");
        }
      });
    return () => {
      alive = false;
    };
  }, [toast, reload]);

  // 导入备份会把数据整体换掉 → 跟着重拉（同奖状区那条）
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen("data-changed", () => setReload((n) => n + 1))
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch((error: unknown) => {
        console.error("[东方摩耶堂] 格言区监听 data-changed 失败", error);
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const replace = useCallback((updated: Motto) => {
    setItems((prev) => prev.map((one) => (one.id === updated.id ? updated : one)));
  }, []);

  const shown = useMemo(() => filterMottos(ordered(items), filter), [items, filter]);
  const today = useMemo(() => todayMotto(items), [items]);
  const spot = spotId ? (items.find((one) => one.id === spotId) ?? today) : today;

  // ── 加一句 ──
  const addOne = async () => {
    const text = addText.trim();
    if (!text) return;
    try {
      const created = await mottoCreate(text, addKind);
      setItems((prev) => [...prev, created]);
      setAddText("");
    } catch (error) {
      toast(`写进去失败：${String(error)}`, "error");
    }
  };

  // ── 就地编辑 ──
  const fieldRef = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  const startEdit = (motto: Motto) => {
    setEditingId(motto.id);
    setEditKind(motto.kind);
  };

  const saveEdit = async (motto: Motto) => {
    const text = (fieldRef.current[`text:${motto.id}`]?.value ?? "").trim();
    const from = fieldRef.current[`from:${motto.id}`]?.value ?? "";
    if (!text) {
      toast("总得写一句吧 —— 已经退回原来的", "error");
      setEditingId(null);
      return;
    }
    try {
      replace(await mottoSet(motto.id, { text, from, kind: editKind }));
      setEditingId(null);
    } catch (error) {
      toast(`改不动：${String(error)}`, "error");
    }
  };

  const removeOne = (motto: Motto) => {
    askConfirm({
      title: "删掉这一句？",
      message: `"${motto.text}"会被删掉。删之前会自动留档到 backups/。`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            await mottoDelete(motto.id);
            setItems((prev) => prev.filter((one) => one.id !== motto.id));
            setSpotId((prev) => (prev === motto.id ? null : prev));
            toast("删掉了（留了档）", "success");
          } catch (error) {
            toast(`删除失败：${String(error)}`, "error");
          }
        })();
      },
    });
  };

  return (
    <div className="flex min-h-full flex-col gap-4">
      {/* ① 今天这一句（聚光） */}
      {spot && (
        <div
          data-motto-spotlight={spot.id}
          className="rounded-2xl border border-indigo-300 p-5 dark:border-indigo-500/50"
          style={{ background: "linear-gradient(135deg, rgba(99,102,241,.14), rgba(99,102,241,.04))" }}
        >
          <div className="mb-1.5 flex items-center gap-2 text-[11px] text-indigo-600 dark:text-indigo-300">
            <span data-motto-spot-label>{spotId ? "随便翻到的这一句" : "今天这一句 · 每天换一次"}</span>
            <button
              type="button"
              data-motto-random
              onClick={() => {
                const hit = randomMotto(items, spot?.id);
                if (hit) setSpotId(hit.id);
              }}
              className="ml-auto rounded-lg border border-indigo-300 px-2 py-0.5 text-[11px] text-indigo-600 hover:bg-indigo-50 dark:border-indigo-500/60 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
            >
              随便翻一句
            </button>
            {spotId && (
              <button
                type="button"
                data-motto-back-today
                onClick={() => setSpotId(null)}
                className="rounded-lg px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                回到今天这一句
              </button>
            )}
          </div>
          <p data-motto-spot-text className="text-[17px] leading-relaxed">
            {spot.text}
          </p>
          <p data-motto-spot-attr className="mt-2 text-[11.5px] text-slate-500 dark:text-slate-400">
            {attribution(spot)}
          </p>
        </div>
      )}

      {/* ② 筛选 + 写一句 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(["all", "motto", "rule"] as MottoFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              data-motto-filter={key}
              onClick={() => setFilter(key)}
              className={`rounded-lg px-2.5 py-1 text-xs ${
                filter === key
                  ? "bg-indigo-600 text-white"
                  : "border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {key === "all" ? `全部 ${items.length}` : `${KIND_LABEL[key]} ${countBy(items, key)}`}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          {(["rule", "motto"] as MottoKind[]).map((key) => (
            <button
              key={key}
              type="button"
              data-motto-add-kind={key}
              onClick={() => setAddKind(key)}
              className={`rounded-lg border px-2 py-1 text-[11px] ${
                addKind === key
                  ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:border-indigo-500/60 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400"
              }`}
            >
              {KIND_LABEL[key]}
            </button>
          ))}
        </div>

        <input
          data-motto-add-input
          value={addText}
          placeholder="写一句…（回车就存）"
          onChange={(event) => setAddText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void addOne();
            }
          }}
          className="min-w-[240px] flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
        />
        <span data-motto-count={items.length} className="text-[11.5px] text-slate-400">
          共 {items.length} 条
        </span>
      </div>

      {/* ③ 卡片墙 */}
      {loaded && items.length === 0 && (
        <div
          data-motto-empty
          className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400 dark:border-slate-700"
        >
          <b className="mb-2 block text-slate-500 dark:text-slate-300">还没有 —— 写一句你信的话</b>
          别人的话点「格言」，自己定下的规矩点「原则」。写上去就行了，随时能改。
        </div>
      )}

      <div data-motto-wall className="grid grid-cols-2 gap-3">
        {shown.map((motto) =>
          editingId === motto.id ? (
            <div
              key={motto.id}
              data-motto-editing={motto.id}
              className="rounded-2xl border border-indigo-400 bg-slate-50 p-3.5 dark:border-indigo-500 dark:bg-slate-900"
            >
              <textarea
                key={`${motto.id}#text`}
                data-motto-edit-text={motto.id}
                ref={(el) => {
                  fieldRef.current[`text:${motto.id}`] = el;
                }}
                defaultValue={motto.text}
                rows={3}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void saveEdit(motto);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEditingId(null);
                  }
                }}
                className="w-full resize-y rounded-lg border border-indigo-300 bg-white px-2.5 py-2 text-sm leading-relaxed outline-none dark:border-indigo-500 dark:bg-slate-800 dark:text-slate-100"
              />
              <input
                key={`${motto.id}#from`}
                data-motto-edit-from={motto.id}
                ref={(el) => {
                  fieldRef.current[`from:${motto.id}`] = el;
                }}
                defaultValue={motto.from}
                placeholder="谁说的 / 出处（可以空着）"
                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {(["rule", "motto"] as MottoKind[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    data-motto-edit-kind={key}
                    onClick={() => setEditKind(key)}
                    className={`rounded-lg border px-2 py-0.5 text-[11px] ${
                      editKind === key
                        ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:border-indigo-500/60 dark:bg-indigo-500/10 dark:text-indigo-300"
                        : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400"
                    }`}
                  >
                    {KIND_LABEL[key]}
                  </button>
                ))}
                <button
                  type="button"
                  data-motto-save={motto.id}
                  onClick={() => void saveEdit(motto)}
                  className="rounded-lg bg-indigo-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700"
                >
                  保存
                </button>
                <button
                  type="button"
                  data-motto-cancel={motto.id}
                  onClick={() => setEditingId(null)}
                  className="rounded-lg border border-slate-200 px-2.5 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
                >
                  取消
                </button>
                <button
                  type="button"
                  data-motto-del={motto.id}
                  onClick={() => removeOne(motto)}
                  className="ml-auto rounded-lg border border-rose-200 px-2.5 py-0.5 text-[11px] text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
                >
                  删除
                </button>
              </div>
              <p className="mt-1.5 text-[10.5px] text-slate-400">
                回车保存 · Shift+回车换行 · Esc 取消
              </p>
            </div>
          ) : (
            <div
              key={motto.id}
              data-motto-card={motto.id}
              data-motto-text={motto.text}
              data-motto-kind={motto.kind}
              className={`group rounded-2xl border bg-white p-3.5 transition-shadow hover:shadow-md dark:bg-slate-900 ${
                spot?.id === motto.id
                  ? "border-indigo-300 dark:border-indigo-500/50"
                  : "border-slate-200 dark:border-slate-800"
              }`}
            >
              <button
                type="button"
                data-motto-open={motto.id}
                title="点一下改这一句"
                onClick={() => startEdit(motto)}
                className="block w-full text-left text-[14.5px] leading-relaxed"
              >
                {motto.text}
              </button>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                <span
                  data-motto-badge={motto.kind}
                  className={`rounded px-1.5 py-0.5 ${
                    motto.kind === "motto"
                      ? "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
                      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                  }`}
                >
                  {KIND_LABEL[motto.kind]}
                </span>
                <span className="truncate">{attribution(motto)}</span>
                {/* M13-C：把这一句挂到专注小窗上（写进 config，留一整天） */}
                <button
                  type="button"
                  data-motto-to-focus={motto.id}
                  title="挂到专注小窗（今天都显示这一句）"
                  onClick={() => void pinToFocus(motto.id)}
                  className="ml-auto shrink-0 rounded px-1 text-slate-300 opacity-0 transition-opacity hover:bg-indigo-50 hover:text-indigo-500 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-indigo-500/10"
                >
                  📌
                </button>
                <button
                  type="button"
                  data-motto-del={motto.id}
                  title="删掉这一句"
                  onClick={() => removeOne(motto)}
                  className="shrink-0 rounded px-1 text-slate-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-rose-500/10"
                >
                  ✕
                </button>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
