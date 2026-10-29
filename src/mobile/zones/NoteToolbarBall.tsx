/**
 * 手机文本页的「悬浮球 + 竖排黑条」（P2-D，2026-10-06 用户返工定的形态）。
 *
 * # 为什么不是原来那根横条
 * P2-C 做的是一根横在键盘上方的条，用户真机看完说「效果不好，我希望换掉」，
 * 并且给了形态：**平时只有一颗小球**，点一下才从球的正下方长出一条**竖排黑条**；
 * 球按住可以拖，**松手吸附到最近的左右边**。稿子 `.spike\P2D4-设计稿-v5.html` 他过了目。
 *
 * # 这 14 颗按钮
 * 最上面三颗是这次新加的：**↶ 撤销 / ↷ 重做 / 🖼 导入图片**；
 * 后面 11 颗**顺序与来源与电脑版一字不差**（读 `features/notes/EditorToolbar.tsx` 的 `BUTTONS`，
 * 单一来源 —— 谁也别在这儿另抄一份）。⚠️ 2026-10-21（#2）加了 `||` 色块隐藏，13 → 14 颗。
 *
 * # 四条别改坏（都踩过）
 * ① 按钮 `onPointerDown` 里 `preventDefault()`：不这么做，点按钮会把编辑器的**选区抢走**，
 *    "选一段字再点 B"就变成"在光标处插占位符"（电脑版踩过同样的坑）。
 * ② 球自己的 `pointerdown` **不能** `preventDefault`（要拖），所以球上加了 `touch-action: none`，
 *    否则拖动会变成滚页面。
 * ③ 撤销/重做走 CodeMirror 自己的历史栈（`NoteEditorHandle.undo/redo`），
 *    **不另造一套**——造了就会跟 `Mod-Z` 和输入法的撤销打架。
 * ④ 「点外面收起」用 document 上的 `pointerdown` 监听：**判断目标在不在球/条里**，
 *    不然点编辑器想插字会先把条收掉（体验上像"点哪都没反应"）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toolbarButtons } from "../../features/notes/EditorToolbar";
import type { ToolbarAction } from "../../features/notes/format";
import { useData } from "../../store/data";

export interface BallPos {
  side: "left" | "right";
  y: number;
}

interface NoteToolbarBallProps {
  /** 光标现在处在什么格式里（高亮对应按钮） */
  active: ToolbarAction[];
  onAction: (action: ToolbarAction) => void;
  /** 撤销 / 重做（CodeMirror 的历史栈） */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 选了图之后（字节已经拿到）—— 上层负责写进 assets/ 并插进正文 */
  onPickImage: (file: File) => void;
  /** 拖完球把新位置报上去（上层写进 `config.json` 的 `mobileToolbarBall`） */
  onMove: (pos: BallPos) => void;
  /**
   * 球停在哪。⚠️ 允许缺省：万一后端还是旧构建（配置里没这一段），
   * 也不能让整页崩掉 —— 回落成设计稿的默认位（右侧、离顶 320）。
   */
  pos?: BallPos;
}

/** 配置里没写时用这个（与 Rust `MobileToolbarBall::default()` 一致） */
const DEFAULT_POS: BallPos = { side: "right", y: 120 };

/** 球的边长（稿子定的 44px） */
const BALL = 44;
/** 竖排条里每颗按钮的边长（稿子定的 34px） */
const BTN = 34;
/** 球离屏幕边的距离 */
const EDGE = 8;
/** 一次点击移动超过这么多像素才算"拖"（否则算点一下） */
const DRAG_THRESHOLD = 6;
/** 说明气泡留多久（手机没有悬停，点一下弹一句） */
const HINT_MS = 2600;

export default function NoteToolbarBall({
  active,
  onAction,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPickImage,
  onMove,
  pos = DEFAULT_POS,
}: NoteToolbarBallProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 手势进行中（防止一次拖拽的监听没收干净时被下一次点击叠加使用） */
  const gestureRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState("");
  const configuredActions = useData((state) => state.config.toolbarActions);
  const markdownButtons = toolbarButtons(configuredActions);
  /** 拖动过程中的临时位移（松手才落到 pos 上） */
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  /** 容器高度（用来夹住 y、判断条往上长还是往下长） */
  const [box, setBox] = useState({ w: 360, h: 720 });

  // 容器尺寸：球的位置要夹在可视范围里（键盘弹起 / 换机型 / 横竖屏都会变）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sync = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width > 0) setBox({ w: Math.round(rect.width), h: Math.round(rect.height) });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 点条外 / 点球 → 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const host = hostRef.current;
      if (host && event.target instanceof Node && host.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // 说明气泡过一会儿自己消失（别在屏幕上留一句一直挂着的话）
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(""), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  const maxY = Math.max(BOX_MIN, box.h - BALL - EDGE);
  const ballY = Math.max(EDGE, Math.min(pos.y, maxY));
  const ballX = pos.side === "right" ? box.w - BALL - EDGE : EDGE;

  /**
   * 竖排条有多高（13 颗 + 分隔线 + 间距 + 内边距）
   * 13×34 + 1 + 13×4(gap) + 12(padding) ≈ 507
   */
  const stripH = markdownButtons.length * BTN + 3 * BTN + (markdownButtons.length + 2) * 4 + 20;

  /**
   * 往哪边长得看**哪边空间大**，而且**高度要夹住**。
   *
   * 🔴 2026-10-06 真机/套件踩到的：原来只判断"下方放不下就往上去" ——
   *    球停在屏幕中段时，**哪个方向都放不下这 507px**，于是条被顶出屏幕上沿，
   *    最上面那颗「撤销」落到屏幕外面：看着在、点着没反应（m19 的 42n4 就是这么红的）。
   *    现在：选空间大的那边 + `maxHeight` 夹到可用高度（装不下时条内滚动），
   *    **整条永远在屏幕里**。
   */
  const spaceDown = box.h - (ballY + BALL + 8) - EDGE;
  const spaceUp = ballY - 8 - EDGE;
  const growUp = spaceUp > spaceDown;
  const stripMax = Math.max(BTN * 3, Math.min(stripH, growUp ? spaceUp : spaceDown));

  const tap = useCallback(
    (action: ToolbarAction, text: string) => {
      setHint(text);
      onAction(action);
    },
    [onAction],
  );

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    // 上一次手势还没收干净就忽略这次（否则会出现"点一下切换两次 = 净效果没收起"）
    if (gestureRef.current) return;
    event.preventDefault();
    gestureRef.current = true;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const target = event.currentTarget;
    // ⚠️ 监听挂 **window** 上，不挂在按钮上：
    //    挂按钮上就得依赖 `setPointerCapture` 一定成功 —— 实测（m19 42n8）有一次没成功，
    //    `pointerup` 没送到按钮 → 监听器**永远留着** → 下一次点击被切换两次（净效果=没收起）。
    //    window 上的监听不依赖捕获，松手一定收得到；收尾统一在 `finish()` 里做。
    let done = false;
    const finish = (up: PointerEvent | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("pointermove", onMoveEvent);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      try {
        target.releasePointerCapture(up?.pointerId ?? 0);
      } catch {
        // 没捕获成功过 → 释放会抛，忽略即可
      }
      gestureRef.current = false;
      setDrag(null);
      if (!moved || !up) {
        // 没怎么动 → 当成"点一下"：开关竖排条
        setOpen((was) => !was);
        return;
      }
      // 落到最近的一侧（用户要的就是"松手吸附到左右边"）
      const nextX = ballX + (up.clientX - startX);
      const nextY = ballY + (up.clientY - startY);
      onMove({
        side: nextX + BALL / 2 < box.w / 2 ? "left" : "right",
        y: Math.max(EDGE, Math.min(Math.round(nextY), maxY)),
      });
    };
    const onMoveEvent = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      moved = true;
      setDrag({ dx, dy });
    };
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败也能用（window 监听兜着）
    }
    window.addEventListener("pointermove", onMoveEvent);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 z-30"
      data-mnote-ball-layer
    >
      {/* 说明气泡：点哪颗弹哪句（手机没有悬停，这是"能教人"的那一手） */}
      {hint && (
        <div
          data-mnote-tb-hint
          style={{
            top: Math.max(EDGE, Math.min(ballY, maxY)),
            [pos.side === "right" ? "right" : "left"]: BALL + EDGE + 8,
          }}
          className="pointer-events-none absolute max-w-[190px] rounded-lg bg-slate-900/92 px-2 py-1 text-[11px] leading-snug text-white shadow-lg"
        >
          {hint}
        </div>
      )}

      {/* 竖排条：从球的正下方往下长；下方放不下就改成从球往上长 */}
      {open && (
        <div
          data-mnote-strip
          data-mnote-strip-up={growUp ? "1" : "0"}
          style={{
            [pos.side === "right" ? "right" : "left"]: EDGE,
            ...(growUp ? { bottom: box.h - ballY + 8 } : { top: ballY + BALL + 8 }),
            maxHeight: stripMax,
          }}
          className="pointer-events-auto absolute flex w-[44px] flex-col items-center gap-1 overflow-y-auto rounded-[22px] bg-slate-900/95 px-1.5 py-1.5 shadow-2xl ring-1 ring-white/10"
        >
          {/* ① 撤销 / ② 重做 / ③ 导入图片 —— 这次新加的三颗 */}
          <button
            type="button"
            data-mnote-tb="undo"
            data-mnote-tb-active={canUndo ? "1" : "0"}
            title="撤销上一步（手机没有 Ctrl+Z）"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setHint("撤销 —— 退回上一步改动");
              onUndo();
            }}
            className={BUTTON_CLASS + (canUndo ? "" : DISABLED_CLASS)}
          >
            ↶
          </button>
          <button
            type="button"
            data-mnote-tb="redo"
            data-mnote-tb-active={canRedo ? "1" : "0"}
            title="重做（撤销多了可以往回走）"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setHint("重做 —— 把刚撤销的那步再做一次");
              onRedo();
            }}
            className={BUTTON_CLASS + (canRedo ? "" : DISABLED_CLASS)}
          >
            ↷
          </button>
          <button
            type="button"
            data-mnote-tb="image"
            title="从相册 / 文件里选一张图，插到光标处"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setHint("导入图片 —— 选一张图插到光标处（会存进 assets/）");
              fileRef.current?.click();
            }}
            className={BUTTON_CLASS}
          >
            🖼
          </button>

          <span className="my-0.5 h-px w-6 shrink-0 bg-white/15" />

          {/* ④ 起：电脑版同源 Markdown 按钮；顺序和显隐由设置决定 */}
          {markdownButtons.map((button) => {
            const on = active.includes(button.action);
            return (
              <button
                key={button.action}
                type="button"
                data-mnote-tb={button.action}
                data-mnote-tb-active={on ? "1" : "0"}
                title={button.hint}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => tap(button.action, button.hint)}
                className={
                  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full font-mono text-[13px] leading-none transition-colors " +
                  (on
                    ? "bg-indigo-500 text-white"
                    : "text-slate-200 active:bg-white/15")
                }
              >
                {button.label}
              </button>
            );
          })}
        </div>
      )}

      {/* 球本身：平时屏幕上就它一个（不挡东西）；按住能拖，松手吸附左右边 */}
      <button
        type="button"
        data-mnote-ball
        data-mnote-ball-open={open ? "1" : "0"}
        data-mnote-ball-side={pos.side}
        data-mnote-ball-pos={`${Math.round(ballX + (drag?.dx ?? 0))},${Math.round(ballY + (drag?.dy ?? 0))}`}
        title="按住可以拖；点一下出工具条"
        aria-label="编辑工具条"
        onPointerDown={startDrag}
        style={{
          left: ballX + (drag?.dx ?? 0),
          top: ballY + (drag?.dy ?? 0),
          width: BALL,
          height: BALL,
          touchAction: "none",
        }}
        className="pointer-events-auto absolute flex items-center justify-center rounded-full bg-slate-900 text-[15px] font-semibold text-white shadow-xl ring-2 ring-indigo-400/70 active:scale-95"
      >
        A
      </button>

      {/* 系统选图：安卓 WebView 会直接调起相册/文件（不引新依赖） */}
      <input
        ref={fileRef}
        data-mnote-image-input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 清掉 value：不然同一张图选第二次不触发 change（真实踩过的坑）
          event.target.value = "";
          if (file) onPickImage(file);
        }}
      />
    </div>
  );
}

/** 球的最小 y（窗口再矮也得留出球的边距） */
const BOX_MIN = BALL + 24;

const BUTTON_CLASS =
  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-[15px] leading-none text-slate-200 transition-colors active:bg-white/15";
const DISABLED_CLASS = " opacity-35";
