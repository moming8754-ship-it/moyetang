/**
 * 奖状墙（M12-A）—— 技能区的第一块真功能。
 *
 * # 这块是干什么的
 * 把自己挣来的东西挂起来：**一面墙 + 右边一格详情**。点哪张改哪张，不跳页。
 * 用户对这块的原话："**允许你自由制造，核心是界面简洁轻松上手、给自己情绪价值**"——
 * 所以：**没图也能建**（标题首字当"牌面"）、按年份分段（积累感看得见）、📌 置顶最前。
 *
 * # 图片从哪来（三条路，都走现成的件）
 * 1. **从资源管理器拖进来** → `useFileDrop`（⚠️ Tauri 接管了原生拖放，页面里的 `onDrop` 收不到真手拖）；
 * 2. **截图后 Ctrl+V** → `imageFromClipboard` + `asset_write_image`（后端按文件头魔数认格式）；
 * 3. 换图 = 再来一次上面任意一条（旧图**不删**，`assets/` 里留着）。
 *
 * # 两条不会踩的坑（都是 V1 攒下来的）
 * - 输入框**非受控 + `key` 带 id**：换一张才重挂载，**正在打的字永远不会被程序回填搅乱**；
 * - 拖放/粘贴的回调放 ref 里取最新的那份，**不在事件里读 state**（读到的会是旧闭包）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import ImageViewer from "../../components/ImageViewer";
import {
  assetImport,
  assetWriteImage,
  awardCreate,
  awardDelete,
  awardList,
  awardSet,
  inTauri,
} from "../api";
import { AssetImage } from "../../components/AssetImage";
import { missingImageText, useAssetImage } from "../asset";
import { useFileDrop } from "../useFileDrop";
import { fileToBase64, imageFromClipboard } from "../../shared/imageFile";
import { useUi } from "../../store/ui";
import type { Award } from "../types";
import { awardSections, faceChar, faceGradient, latestAward, yearOf } from "./awards";

type TextField = "title" | "issuer" | "date" | "note";
const TEXT_FIELDS: { name: TextField; label: string; placeholder: string }[] = [
  { name: "title", label: "标题", placeholder: "蓝桥杯省赛三等奖" },
  { name: "issuer", label: "谁给的", placeholder: "自己发的也行" },
  { name: "date", label: "什么时候", placeholder: "2026-08-14 或 2026 年 6 月（随便写）" },
  { name: "note", label: "写给自己的一句话（可以空着）", placeholder: "第一次进省赛，差一点点进国赛。" },
];

/** 卡片上半部分：有图显示图，没图就用标题首字做一块"牌面" */
function CardFace({ award }: { award: Award }) {
  const { url, failed } = useAssetImage(award.assetPath);
  /** 图在磁盘上不在（手机版常态：图片不参与同步）→ 回落到牌面，别画破图 */
  const [broken, setBroken] = useState(false);
  const missing = failed || broken;
  if (award.assetPath && url && !missing) {
    return (
      <div className="h-[108px] w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
        <img
          src={url}
          alt={award.title}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      </div>
    );
  }
  return (
    <div
      className="flex h-[108px] w-full items-center justify-center"
      style={{ background: faceGradient(award.title) }}
    >
      {award.assetPath ? (
        <span className="px-3 text-center text-[11px] leading-tight text-white/75">
          {missing ? missingImageText(award.assetPath) : "图片加载中…"}
        </span>
      ) : (
        <span className="text-3xl font-bold text-white/85">{faceChar(award.title)}</span>
      )}
    </div>
  );
}

export default function AwardsPane() {
  const toast = useUi((s) => s.toast);
  const askConfirm = useUi((s) => s.askConfirm);

  const [items, setItems] = useState<Award[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 外部把数据整个换掉了（导入备份）→ +1 触发重拉 */
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [dropping, setDropping] = useState(false);
  /** 点开看大图（`assets/` 相对路径） */
  const [viewing, setViewing] = useState<string | null>(null);

  const picked = useMemo(
    () => items.find((one) => one.id === pickedId) ?? null,
    [items, pickedId],
  );
  const sections = useMemo(() => awardSections(items), [items]);
  const latest = useMemo(() => latestAward(items), [items]);

  // 首次进来拉一遍
  useEffect(() => {
    let alive = true;
    void awardList()
      .then((list) => {
        if (alive) {
          setItems(list);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setLoaded(true);
          toast(`读奖状失败：${String(error)}`, "error");
        }
      });
    return () => {
      alive = false;
    };
  }, [toast, reload]);

  /**
   * 别的地方把数据整个换掉了（**导入备份**就是这么干的），这里得跟着重拉一遍。
   *
   * ⚠️ 奖状自己的写操作**不广播** `data-changed`（命令直接返回新对象、就地更新就够了），
   * 所以这条监听是给"外部整体替换数据"用的 —— 不监听的话，导入完备份回到技能区
   * 还会显示**旧的一墙奖状**，看着像导入失败了。
   */
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
        console.error("[东方摩耶堂] 技能区监听 data-changed 失败", error);
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  /** 就地更新一条（后端返回权威对象，不让界面自己猜） */
  const replace = useCallback((updated: Award) => {
    setItems((prev) => prev.map((one) => (one.id === updated.id ? updated : one)));
  }, []);

  const applyPatch = useCallback(
    async (
      id: string,
      patch: Partial<Pick<Award, "title" | "issuer" | "date" | "note" | "assetPath" | "pinned">>,
    ) => {
      try {
        replace(await awardSet(id, patch));
      } catch (error) {
        toast(`保存失败：${String(error)}`, "error");
      }
    },
    [replace, toast],
  );

  // ── 图片：拖进来 / 粘贴 / 换一张 ──
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!pickedId) {
        toast("先点一张奖状，再把图片拖进来", "error");
        return;
      }
      try {
        const rel = await assetImport(paths[0]);
        await applyPatch(pickedId, { assetPath: rel });
        toast("图片换好了", "success");
      } catch (error) {
        toast(`导入图片失败：${String(error)}`, "error");
      }
    },
    [applyPatch, pickedId, toast],
  );

  useFileDrop({
    onImages: (paths) => void importPaths(paths),
    onDragStateChange: setDropping,
  });

  // ⚠️ 粘贴与拖放一样：回调放 ref，事件里读到的永远是最新那份（别读 state 的旧闭包）
  const pasteRef = useRef<(file: File) => void>(() => undefined);
  pasteRef.current = (file: File) => {
    void (async () => {
      try {
        const base64 = await fileToBase64(file);
        const rel = await assetWriteImage(base64);
        await applyPatch(pickedId ?? "", { assetPath: rel });
      } catch (error) {
        toast(`粘贴图片失败：${String(error)}`, "error");
      }
    })();
  };
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = imageFromClipboard(event);
      if (!file) return; // 是文字就放过、走系统默认粘贴，不抢
      event.preventDefault();
      pasteRef.current(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // ── 新增 / 删除 / 置顶 / 随便看一张 ──
  const addOne = async () => {
    const title = newTitle.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    try {
      const created = await awardCreate(title);
      setItems((prev) => [...prev, created]);
      setPickedId(created.id);
      setNewTitle("");
      setAdding(false);
    } catch (error) {
      toast(`新建失败：${String(error)}`, "error");
    }
  };

  const removeOne = (award: Award) => {
    askConfirm({
      title: "删掉这张奖状？",
      message: `《${award.title}》会被删掉。删之前会自动留档到 backups/；图片文件留着不删。`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            await awardDelete(award.id);
            setItems((prev) => prev.filter((one) => one.id !== award.id));
            setPickedId((prev) => (prev === award.id ? null : prev));
            toast("已删掉（留了档）", "success");
          } catch (error) {
            toast(`删除失败：${String(error)}`, "error");
          }
        })();
      },
    });
  };

  const randomOne = () => {
    if (items.length === 0) return;
    const hit = items[Math.floor(Math.random() * items.length)];
    setPickedId(hit.id);
    document
      .querySelector(`[data-award-card="${hit.id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // ── 详情面板里的四格（非受控 + 提交时才写盘） ──
  const fieldRef = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});

  const commitField = async (award: Award, name: TextField) => {
    const value = fieldRef.current[name]?.value ?? "";
    const stored: Record<TextField, string> = {
      title: award.title,
      issuer: award.issuer,
      date: award.date,
      note: award.note,
    };
    if (name === "title" && !value.trim()) {
      // 空标题不收：把输入框退回原名，并说一声（别静默丢掉用户刚打的字）
      const el = fieldRef.current[name];
      if (el) el.value = award.title;
      toast("标题不能空着 —— 已经退回原来的名字", "error");
      return;
    }
    if (value === stored[name]) return; // 没改就不写盘
    await applyPatch(award.id, { [name]: value });
  };

  const saveAll = async (award: Award) => {
    const read = (name: TextField) => fieldRef.current[name]?.value ?? "";
    const title = read("title").trim();
    if (!title) {
      toast("标题不能空着", "error");
      return;
    }
    await applyPatch(award.id, {
      title,
      issuer: read("issuer"),
      date: read("date"),
      note: read("note"),
    });
    toast("存好了", "success");
  };

  return (
    <div className="flex min-h-full gap-6">
      {/* ① 左：奖状墙 */}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span data-award-count={items.length} className="text-xs text-slate-500 dark:text-slate-400">
            你已经攒了 <b className="text-slate-700 dark:text-slate-200">{items.length} 张</b>
            {latest && (
              <>
                ，最近一张是 {yearOf(latest.date) ? `${latest.date} ` : ""}
                《{latest.title}》
              </>
            )}
          </span>
          <span className="ml-auto" />
          {items.length > 0 && (
            <button
              type="button"
              data-award-random
              title="随机翻出一张旧奖状看看"
              onClick={randomOne}
              className="rounded-lg border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-400"
            >
              随便看一张
            </button>
          )}
          {adding ? (
            <input
              autoFocus
              data-award-add-input
              value={newTitle}
              placeholder="写个标题，回车就建（图以后再补）"
              onChange={(event) => setNewTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void addOne();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setNewTitle("");
                  setAdding(false);
                }
              }}
              onBlur={() => void addOne()}
              className="w-64 rounded-lg border border-indigo-300 bg-white px-2 py-1 text-xs outline-none dark:border-indigo-500 dark:bg-slate-800 dark:text-slate-100"
            />
          ) : (
            <button
              type="button"
              data-award-add
              onClick={() => {
                setNewTitle("");
                setAdding(true);
              }}
              className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
            >
              ＋ 添加一张
            </button>
          )}
        </div>

        {loaded && items.length === 0 && (
          <div
            data-award-empty
            className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400 dark:border-slate-700"
          >
            <b className="mb-2 block text-slate-500 dark:text-slate-300">
              还没有奖状 —— 把自己挣来的东西贴上来
            </b>
            考过的证、拿过的名次、坚持下来的记录，都算。<br />
            什么都没准备也没关系：先写个标题，图片以后补。
          </div>
        )}

        <div
          data-award-wall
          className={`space-y-1 ${dropping ? "rounded-2xl ring-2 ring-emerald-400" : ""}`}
        >
          {sections.map((section) => (
            <div key={section.label}>
              <div data-award-section={section.label} className="mb-2 mt-4 flex items-center gap-3">
                <span className="font-mono text-[11px] text-slate-400">{section.label}</span>
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {section.items.map((award) => (
                  <button
                    key={award.id}
                    type="button"
                    data-award-card={award.id}
                    data-award-title={award.title}
                    data-award-pinned={award.pinned ? "1" : "0"}
                    data-award-has-image={award.assetPath ? "1" : "0"}
                    onClick={() => setPickedId(award.id)}
                    className={`overflow-hidden rounded-2xl border bg-white text-left transition-shadow hover:shadow-md dark:bg-slate-900 ${
                      pickedId === award.id
                        ? "border-indigo-400 ring-1 ring-indigo-300 dark:border-indigo-500"
                        : "border-slate-200 dark:border-slate-800"
                    }`}
                  >
                    <div className="relative">
                      <CardFace award={award} />
                      {award.pinned && (
                        <span className="absolute right-2 top-1.5 text-sm" title="置顶">
                          📌
                        </span>
                      )}
                    </div>
                    <div className="px-3 py-2.5">
                      <div className="line-clamp-2 text-[13px] font-semibold leading-snug">
                        {award.title}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        {[award.issuer, award.date].filter(Boolean).join(" · ") || "还没写谁给的"}
                      </div>
                      {award.note && (
                        <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                          {award.note}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
                {/* 每年最后一张后面放一个"再添一张"的虚线卡，顺手 */}
                {section === sections[sections.length - 1] && (
                  <button
                    type="button"
                    data-award-add-card
                    onClick={() => {
                      setNewTitle("");
                      setAdding(true);
                    }}
                    className="flex min-h-[168px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 text-xs text-slate-400 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700"
                  >
                    <span className="text-2xl leading-none">＋</span>
                    <span className="mt-2">再添一张</span>
                    <span className="mt-1 text-[10.5px] text-slate-400">图片拖进来，或者 Ctrl+V 粘贴</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ② 右：这一张的详情 */}
      <aside className="w-[320px] shrink-0">
        {picked ? (
          <div
            data-award-panel={picked.id}
            className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <h3 className="mb-3 text-sm font-semibold">这一张</h3>

            {picked.assetPath ? (
              <button
                type="button"
                data-award-image
                title="点一下看大图"
                onClick={() => setViewing(picked.assetPath ?? null)}
                className="mb-3 block h-[150px] w-full overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800"
              >
                <FacePreview award={picked} />
              </button>
            ) : (
              <div className="mb-3 flex h-[110px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 text-[11px] text-slate-400 dark:border-slate-700">
                <span>还没有图片</span>
                <span className="mt-1">把图片拖进来，或者截图后 Ctrl+V</span>
              </div>
            )}

            <div className="space-y-2.5">
              {TEXT_FIELDS.map((field) =>
                field.name === "note" ? (
                  <label key={field.name} className="block">
                    <span className="mb-1 block text-[11px] text-slate-400">{field.label}</span>
                    <textarea
                      key={`${picked.id}#${field.name}`}
                      data-award-field={field.name}
                      ref={(el) => {
                        fieldRef.current[field.name] = el;
                      }}
                      defaultValue={picked.note}
                      rows={2}
                      placeholder={field.placeholder}
                      onBlur={() => void commitField(picked, field.name)}
                      className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
                    />
                  </label>
                ) : (
                  <label key={field.name} className="block">
                    <span className="mb-1 block text-[11px] text-slate-400">{field.label}</span>
                    <input
                      key={`${picked.id}#${field.name}`}
                      data-award-field={field.name}
                      ref={(el) => {
                        fieldRef.current[field.name] = el;
                      }}
                      defaultValue={
                        field.name === "title"
                          ? picked.title
                          : field.name === "issuer"
                            ? picked.issuer
                            : picked.date
                      }
                      placeholder={field.placeholder}
                      onBlur={() => void commitField(picked, field.name)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitField(picked, field.name);
                        }
                      }}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-slate-800"
                    />
                  </label>
                ),
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-award-pin
                onClick={() => void applyPatch(picked.id, { pinned: !picked.pinned })}
                className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                  picked.pinned
                    ? "border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-300"
                    : "border-slate-200 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                📌 {picked.pinned ? "已置顶" : "置顶"}
              </button>
              <button
                type="button"
                data-award-replace
                title="也可以直接把新图拖进窗口，或者 Ctrl+V 粘贴"
                onClick={() => toast("把图片拖进窗口，或者截图后 Ctrl+V —— 两种都行", "info")}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                🖼 换图片
              </button>
              {picked.assetPath && (
                <button
                  type="button"
                  data-award-clear-image
                  title="只解除引用，assets/ 里的原图不删"
                  onClick={() => void applyPatch(picked.id, { assetPath: "" })}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  去掉图
                </button>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-award-save
                onClick={() => void saveAll(picked)}
                className="flex-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
              >
                保存
              </button>
              <button
                type="button"
                data-award-delete
                onClick={() => removeOne(picked)}
                className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
              >
                删除
              </button>
            </div>

            <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-400 dark:border-slate-800">
              改动<b>边打字边自动存</b>（失焦或回车就写盘），「保存」按钮留着让你安心。<br />
              删除会先问一句，而且删之前自动留档。
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400 dark:border-slate-700">
            点左边任意一张奖状，这里就是它的详情。
            <br />
            <span className="mt-2 block">还没有的话，先点右上角「＋ 添加一张」。</span>
          </div>
        )}
      </aside>

      {viewing && <ImageViewer relPath={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** 详情面板里的大图（单独一个组件：hook 只能在组件里用） */
function FacePreview({ award }: { award: Award }) {
  return (
    <AssetImage
      relPath={award.assetPath}
      alt={award.title}
      className="h-full w-full object-cover"
      fallbackClassName="flex h-full w-full items-center justify-center px-3 text-center text-[11px] leading-tight text-slate-400"
    />
  );
}
