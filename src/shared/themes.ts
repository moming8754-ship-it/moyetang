/**
 * 七套主题（M16-B）—— **做给别人用的**，用户自己继续用原来的深色模式。
 *
 * # 用户给的原话与铁律（2026-09-26）
 * 「**方案1，但是这个其实是做给别人的，我希望我自己的就保留现在我最喜欢的深色模式，
 *   不要说把深色模式给合并到这里面了**」
 * → 那 7 套是**可切换的主题**；**现有 浅色 / 深色 / 跟随系统 原样保留、仍是默认**，
 *   而且是**两套独立的东西**（下面这套变量只在选中 7 套之一时才生效，切回去就把变量清掉，
 *   渲染结果跟改之前**逐像素一致**）。
 *
 * # 怎么做到"不用逐页改类名"
 * Tailwind 4 的工具类引用的是 CSS 变量（`bg-white` → `background-color: var(--color-white)`）。
 * 所以这里不新增类名，而是**把那一批 `--color-*` 换成主题算出来的颜色** ——
 * 全应用的 `bg-white` / `text-slate-600` / `bg-indigo-600` 会**一起**变色，
 * 不会出现计划里警告的"半截颜色"（硬编码 `#4f46e5` 那种才需要单独清）。
 *
 * 每套主题只给两个输入（用户给的色号）：
 * - `accent` **主色** → 当强调色（原来的 indigo 一族：按钮、选中的导航项、链接…）；
 * - `tint` **副色** → 当背景/底色（原来的 white / slate-50/100 一族）。
 * 其余深浅档位由这里按混合算出来（见 `paletteOf`）。
 */

/** 七套主题的 id（存进 `config.json` 的 `theme` 字段） */
export type ThemeId = "qingci" | "mushan" | "shiliu" | "songzhen" | "wuyan" | "dousha" | "laohuang";

export interface ThemeDef {
  id: ThemeId;
  /** 名字（设置页上显示） */
  name: string;
  /** 主色：强调色 */
  accent: string;
  /** 副色：背景/底色 */
  tint: string;
  /** 一句话说明（给"做给别人用"的挑选体验） */
  desc: string;
}

/** 用户 2026-09-26 给的 7 套（顺序照他给的表） */
export const THEMES: ThemeDef[] = [
  { id: "qingci", name: "青瓷绿 × 月桂米", accent: "#3FA796", tint: "#E8D9B5", desc: "安静、耐看" },
  { id: "mushan", name: "暮山蓝 × 晚桃粉", accent: "#4A5F8C", tint: "#E8B4A2", desc: "偏书卷气" },
  { id: "shiliu", name: "石榴红 × 奶杏白", accent: "#B5485D", tint: "#F3E2D1", desc: "有点精神" },
  { id: "songzhen", name: "松针绿 × 琥珀金", accent: "#365B4C", tint: "#D9A441", desc: "稳重、偏深" },
  { id: "wuyan", name: "雾霭紫 × 燕麦白", accent: "#8877C7", tint: "#F0E7DB", desc: "软、轻" },
  { id: "dousha", name: "豆沙粉 × 墨青灰", accent: "#C88697", tint: "#31424D", desc: "副色偏深（对比最强）" },
  { id: "laohuang", name: "酪黄 × 远山青", accent: "#E7C86A", tint: "#5D7E7A", desc: "暖，底色是中绿" },
];

export function themeById(id: string): ThemeDef | null {
  return THEMES.find((one) => one.id === id) ?? null;
}

export function isThemeId(value: string): value is ThemeId {
  return THEMES.some((one) => one.id === value);
}

// ───────────────────────── 颜色小工具（纯函数，好测） ─────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((one) => one + one)
          .join("")
      : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const one = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${one(r)}${one(g)}${one(b)}`;
}

/** 按比例把 a 往 b 混（`amount` = 0 全是 a、1 全是 b） */
function mix(a: string, b: string, amount: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({
    r: x.r + (y.r - x.r) * amount,
    g: x.g + (y.g - x.g) * amount,
    b: x.b + (y.b - x.b) * amount,
  });
}

/** 相对亮度（用来判断底色深浅：决定文字该用深墨还是浅色） */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const WHITE = "#ffffff";
const INK = "#0f172a";

/**
 * 一套主题要覆盖的 `--color-*`。
 *
 * 只覆盖**界面里真正在用的那几族**（white / slate 灰阶 / indigo 强调色）——
 * 覆盖多了会牵动别的语义色（红=删除、绿=完成、琥珀=提醒，那些**不该**跟着主题变）。
 */
export function paletteOf(theme: ThemeDef): Record<string, string> {
  const { accent, tint } = theme;
  // 底色深浅差很多（月桂米 vs 墨青灰）：先判断这算"浅底"还是"深底"
  const darkBase = luminance(tint) < 0.55;
  /** 页面底：浅底主题用很淡的副色，深底主题直接用副色 */
  const surface = darkBase ? tint : mix(tint, WHITE, 0.55);
  /** 卡片面：比页面底再亮/再暗一档，拉开层次 */
  const card = darkBase ? mix(tint, WHITE, 0.12) : mix(tint, WHITE, 0.86);
  /** 正文墨色 */
  const ink = darkBase ? mix(WHITE, tint, 0.12) : mix(INK, accent, 0.22);

  return {
    // 背景一族（原来 white / slate-50/100/200/300）
    "--color-white": card,
    "--color-slate-50": surface,
    "--color-slate-100": darkBase ? mix(tint, WHITE, 0.18) : mix(tint, WHITE, 0.7),
    "--color-slate-200": darkBase ? mix(tint, WHITE, 0.26) : mix(tint, WHITE, 0.42),
    "--color-slate-300": darkBase ? mix(tint, WHITE, 0.36) : mix(tint, WHITE, 0.18),
    // 次级文字一族（原来 slate-400/500/600/700）
    "--color-slate-400": mix(ink, surface, 0.55),
    "--color-slate-500": mix(ink, surface, 0.4),
    "--color-slate-600": mix(ink, surface, 0.22),
    "--color-slate-700": mix(ink, surface, 0.12),
    "--color-slate-800": mix(ink, surface, 0.06),
    "--color-slate-900": ink,
    // 强调色一族（原来的 indigo，按钮 / 选中态 / 链接）
    "--color-indigo-50": mix(accent, card, 0.88),
    "--color-indigo-100": mix(accent, card, 0.8),
    "--color-indigo-300": mix(accent, card, 0.45),
    "--color-indigo-400": mix(accent, card, 0.25),
    "--color-indigo-500": accent,
    "--color-indigo-600": accent,
    "--color-indigo-700": mix(accent, INK, 0.18),
  };
}

/** 主题变量挂在这个属性上（切回内置主题时把属性去掉，见 `applyTheme`） */
export const THEME_ATTR = "data-theme";

/**
 * 一套主题会用到哪些变量名（**固定的名单**）。
 * `applyTheme` 切走时必须按这份名单把上一套留下的变量**逐个删掉** ——
 * 不删的话，切回「浅色 / 深色」还会残留上一套的颜色 ✗（那正是"半截颜色"的另一种形态）。
 */
export const THEME_VAR_NAMES: string[] = Object.keys(paletteOf(THEMES[0]));
