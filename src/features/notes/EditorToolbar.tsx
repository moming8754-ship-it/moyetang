/**
 * 编辑辅助栏（M3-3）—— 用户不记 Markdown 语法，所以这排按钮是主力。
 *
 * 10 个按钮按 PRD 的顺序：`B` / `I` / `H1` / `H2` / `•` / `1.` / `☐`（插 `-[]`）/ `</>` / `🔗` / `toc`
 * （`toc` 是 2026-10-02 用户反馈加的 —— "目录这个语法我不在乎，但要有快捷键按钮"）
 *
 * 两个手感细节：
 * - `onMouseDown` 里 `preventDefault()`：不这么做，点按钮会把编辑器里的**选区抢走**，
 *   结果"选中文字再点 B"变成"在光标处插占位符"（花笺当年也是这么处理的）；
 * - 鼠标移到按钮上时，右边用小字显示它会插什么语法 —— 顺手把 Markdown 教给用户。
 */
import { useEffect, useState } from "react";
import { useData } from "../../store/data";
import type { ToolbarAction } from "./format";

interface EditorToolbarProps {
  onAction: (action: ToolbarAction) => void;
  disabled?: boolean;
}

/** 一颗按钮的元数据 */
export interface ToolbarButton {
  action: ToolbarAction;
  label: string;
  hint: string;
}

/**
 * 🔴 **11 个按钮＋顺序的唯一来源**（手机文本页的「悬浮球 + 竖排条」`mobile/zones/NoteToolbarBall.tsx` 也读这份）。
 * 用户 2026-10-06 点名：「工具栏里面那些小按钮还是和电脑版一样」——
 * 所以手机那边**不许**再抄一份、也不许自行加/减按钮
 * （撤销/重做/附件/标签那套是 Obsidian 的，不是本软件的）。
 * ⚠️ 2026-10-21（#2）：加了 `||` 色块隐藏（跟 B / I 同一套包裹规则）—— 手机竖排条因此 13 → 14 颗，
 *    `m19` 的 42h / 42i 已同步改。
 */
export const BUTTONS: ToolbarButton[] = [
  { action: "bold", label: "B", hint: "粗体 —— 选中文字会变成 **这样**" },
  { action: "italic", label: "I", hint: "斜体 —— 选中文字会变成 *这样*" },
  { action: "h1", label: "H1", hint: "大标题 —— 行首加 #（再点一次取消）" },
  { action: "h2", label: "H2", hint: "小标题 —— 行首加 ##（再点一次取消）" },
  { action: "bullet", label: "•", hint: "项目符号 —— 行首加 - （再点一次取消）" },
  { action: "ordered", label: "1.", hint: "编号列表 —— 每行按 1. 2. 3. 排（再点一次取消）" },
  { action: "marker", label: "☐", hint: "待办 —— 行首插 -[]，执行区会自动出现这条待办" },
  { action: "code", label: "</>", hint: "代码 —— 选中文字包成 `这样`（多行会包成代码块）" },
  {
    action: "spoiler",
    label: "||",
    hint: "色块隐藏 —— 选中文字会包成 ||这样||，预览里点一下才显示（再点遮回去）",
  },
  {
    action: "strike",
    label: "S",
    hint: "中划线 —— 选中文字会包成 ~~这样~~（预览里显示为划掉；再点一次取消）",
  },
  { action: "link", label: "🔗", hint: "链接 —— 插成 [文字](网址)，网址那两个字会被选中，直接粘贴就行" },
  {
    action: "toc",
    label: "toc",
    hint: "目录 —— 行首插 toc 后直接打标题；选中文字再点就包成 toc那一行（认知区右侧「目录」页签会出现它）",
  },
];

/** 按配置过滤、去重；损坏 / 空配置回落到完整默认栏。 */
export function toolbarButtons(actions?: readonly string[]): ToolbarButton[] {
  if (!actions || actions.length === 0) return BUTTONS;
  const byAction = new Map<string, ToolbarButton>(BUTTONS.map((button) => [button.action, button]));
  const seen = new Set<string>();
  const picked: ToolbarButton[] = [];
  for (const action of actions) {
    if (seen.has(action)) continue;
    const button = byAction.get(action);
    if (!button) continue;
    seen.add(action);
    picked.push(button);
  }
  return picked.length > 0 ? picked : BUTTONS;
}

export default function EditorToolbar({ onAction, disabled }: EditorToolbarProps) {
  const configured = useData((state) => state.config.toolbarActions);
  const buttons = toolbarButtons(configured);
  const [hint, setHint] = useState<string>(buttons[0].hint);

  useEffect(() => {
    if (!buttons.some((button) => button.hint === hint)) setHint(buttons[0].hint);
  }, [buttons, hint]);

  return (
    <div className="flex items-center gap-1 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-1">
        {buttons.map((button) => (
          <button
            key={button.action}
            type="button"
            data-tb-action={button.action}
            disabled={disabled}
            title={button.hint}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setHint(button.hint)}
            onFocus={() => setHint(button.hint)}
            onClick={() => onAction(button.action)}
            className="min-w-9 rounded-lg border border-transparent px-2.5 py-1.5 font-mono text-xs text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            {button.label}
          </button>
        ))}
      </div>
      {/* 🔴 提示条**必须有固定宽度**（2026-10-04 修的 bug）：
          原来是 `max-w-[46%]`（宽度跟着文字长短变），于是**鼠标在按钮上移动时整排按钮会重排** ——
          提示一变宽，左边那排就被挤到换行，`toc` 实测从 (502,307) 跳到 (590,307)。
          用户的原话感受是"顺着按钮往右移，还没点到它就滑开了"，很容易点到旁边那颗。
          固定成 `w-[260px]`（窄窗口时由 `max-w-[46%]` 兜住）之后宽度与文字无关 → 不再重排。
          ⚠️ **别改回"跟着文字走"的写法** —— `tools\v2a` 那条"真鼠标点 toc"的验收就是盯这个的。 */}
      <span className="ml-auto hidden w-[260px] max-w-[46%] shrink-0 truncate text-right text-[11px] text-slate-400 sm:block">
        {hint}
      </span>
    </div>
  );
}
