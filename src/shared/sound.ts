/**
 * 提醒提示音（C 批，2026-10-02）。
 *
 * # 为什么是"现场合成"而不是放一个音频文件
 *
 * 用户脑图第 4 条要的是「更明显的闹钟声音，要可以自由设置音效」，他当时给的三个选项里选的是
 * **③「合成音 + 以后可以换」**：先做出"有声音而且够明显"，听腻了再说换文件的事。
 * 好处是实打实的：**零新依赖、零音频文件、不联网**（PRD 第一条红线），而且随时能加档位。
 *
 * # 三档的区别（都在听感上分得开，不是三个频率的近亲）
 *
 * | 档位 | 听感 | 怎么合成 |
 * |---|---|---|
 * | `ding` | 一声清脆的"叮" | 正弦 880Hz，快起快落 |
 * | `triple` | 三连叮（更像闹钟） | 三声 988/880/784Hz 递减 |
 * | `low` | 低沉的"呜——" | 三角波 220Hz 慢起慢落（不刺耳） |
 * | `none` | 静音 | 什么都不做 |
 *
 * ⚠️ **浏览器策略**：Web Audio 的 `AudioContext` 在"用户没交互过"的页面里可能是 `suspended`，
 * 那时 `resume()` 一下就好 —— 桌面端我们的页面必然有交互，但这条兜底留着不亏。
 * ⚠️ 每次响声都**新建一个 oscillator**（用完自己停），不复用，省得掐错节点导致"响一次就哑了"。
 */
import type { SoundKind } from "../features/types";

/** 一次响声的时长（秒）—— 太短听不见，太长吵人 */
const TONE_SECONDS = 0.18;

let context: AudioContext | null = null;

/** 拿一个 AudioContext（懒建；被策略挂起时试着唤醒） */
function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

/** 单声：频率 + 波形 + 时长 */
function tone(
  ctx: AudioContext,
  at: number,
  frequency: number,
  seconds: number,
  gainValue: number,
  type: OscillatorType = "sine",
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, at);
  // 快起（8ms）慢落：避免"啪"的爆音，也让它听着像铃声而不像蜂鸣
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(gainValue, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + seconds + 0.02);
}

/**
 * 响一次。
 *
 * @param kind    档位（`none` → 直接返回，什么都不做）
 * @param volume  0~100
 * @param times   响几声（1~5）；`triple` 这一档**自己**就是三连，所以按"组"重复
 */
export function playAlert(kind: SoundKind, volume: number, times = 1): void {
  if (kind === "none" || volume <= 0) return;
  const ctx = audioContext();
  if (!ctx) return;

  const level = Math.min(1, Math.max(0, volume / 100)) * 0.35; // 封顶 0.35：别把耳朵炸了
  const groups = Math.min(5, Math.max(1, Math.round(times)));
  // 一组内部的间隔（秒）
  const inner = kind === "triple" ? 0.22 : 0;
  // 组与组的间隔（秒）—— 比内间隔大一点，听得出"又响了一遍"
  const between = 0.9;

  for (let group = 0; group < groups; group += 1) {
    const base = ctx.currentTime + group * (between + inner * 2) + 0.02;
    if (kind === "ding") {
      tone(ctx, base, 880, TONE_SECONDS, level);
    } else if (kind === "triple") {
      tone(ctx, base, 988, TONE_SECONDS, level);
      tone(ctx, base + inner, 880, TONE_SECONDS, level);
      tone(ctx, base + inner * 2, 784, TONE_SECONDS, level);
    } else if (kind === "low") {
      // 三角波 + 长一点：低鸣，不刺耳（夜里提醒也不至于吓人）
      tone(ctx, base, 220, 0.42, level, "triangle");
    }
  }
}

/** 档位的中文名（设置页那排按钮用同一份，别两处各写一份） */
export const SOUND_LABEL: Record<SoundKind, string> = {
  ding: "叮",
  triple: "三连叮",
  low: "低鸣",
  none: "静音",
};

export const SOUND_KINDS: SoundKind[] = ["ding", "triple", "low", "none"];
