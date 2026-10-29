/**
 * 批注的**句子锚点**（M14-B）—— 纯函数，不碰 DOM、不写盘。
 *
 * # 为什么不能存行号
 * 正文是用户手写的，**改一行就全错位**（计划里专门点了这条）。所以一条批注存四样东西：
 * 原句快照 `quote` + 前 12 字 `prefix` + 后 12 字 `suffix` + 句子哈希 `hash`。
 *
 * # 三种结局（`resolveAnchor`）
 * 1. `exact`：哈希命中 → 原位显示（99% 的情况，没改过就直接中）；
 * 2. `fuzzy`：哈希不中但前后文还在 → 按"公共前缀 + 公共后缀"打分重新钉到新那句上；
 * 3. `orphan`：彻底找不到 → **批注不删**，界面上标「⚠ 原文已改（原话：…）」。
 *
 * 🔴 三种都**不许动正文一个字**（V1 铁律）。
 */

/** 一句话（批注锚定的粒度） */
export interface Sentence {
  /** 在正文里的行号（0 起） */
  line: number;
  /** 这句话的正文（已 trim） */
  text: string;
  /** 在整篇正文里的字符区间（给"光标在哪一句"用） */
  from: number;
  to: number;
}

/** 一条批注的锚点部分 */
export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  hash: string;
}

export type AnchorHit =
  | { kind: "exact"; line: number; sentence: Sentence }
  | { kind: "fuzzy"; line: number; sentence: Sentence; score: number }
  | { kind: "orphan"; line: -1; sentence: null };

/** 前后文各取多少字 */
export const CONTEXT_CHARS = 12;
/** 模糊匹配的及格线（公共前缀 + 公共后缀的合计字数） */
const FUZZY_MIN_SCORE = 8;

/** 句末标点（中英文都认；分号也算断句，念起来确实是一口气的结束） */
const SENTENCE_END = /[。！？!?；;]/;

/**
 * 把正文切成句子。
 *
 * 规则：**先按行，再按句末标点**；空行与纯空白不算句子。
 * ⚠️ 只读，不改任何字符；切出来的 `text` 是 `trim()` 过的，但 `from/to` 指向**原文里的真实区间**。
 */
export function splitSentences(content: string): Sentence[] {
  const out: Sentence[] = [];
  let lineStart = 0;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let cursor = 0;
    while (cursor < line.length) {
      let end = cursor;
      while (end < line.length && !SENTENCE_END.test(line[end])) end += 1;
      if (end < line.length) end += 1; // 把标点本身带进这一句
      const raw = line.slice(cursor, end);
      const text = raw.trim();
      if (text) {
        const lead = raw.length - raw.replace(/^\s+/, "").length;
        const trail = raw.length - raw.replace(/\s+$/, "").length;
        out.push({
          line: index,
          text,
          from: lineStart + cursor + lead,
          to: lineStart + cursor + raw.length - trail,
        });
      }
      cursor = end;
    }
    lineStart += line.length + 1; // +1 = 被 split 吃掉的那个换行
  }
  return out;
}

/** 哈希前先归一化：掐头去尾、内部空白折叠（"改了个空格"不该算改过） */
export function normalizeForHash(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * 句子哈希（FNV-1a 32 位，够用且稳定）。
 *
 * ⚠️ 只在**前端**算、只当字符串存给后端 —— 所以不需要跨语言一致（后端不重算）。
 */
export function sentenceHash(text: string): string {
  const input = normalizeForHash(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 从"第几行 + 这一句"造一个锚点（前后文按整篇正文取，跨行也算） */
export function makeAnchor(content: string, sentence: Sentence): Anchor {
  const before = content.slice(0, sentence.from).replace(/\s+$/, "");
  const after = content.slice(sentence.to).replace(/^\s+/, "");
  return {
    quote: sentence.text,
    prefix: before.slice(-CONTEXT_CHARS),
    suffix: after.slice(0, CONTEXT_CHARS),
    hash: sentenceHash(sentence.text),
  };
}

/** 光标在第 `offset` 个字符时，它落在哪一句上（找不到就给 null） */
export function sentenceAt(content: string, offset: number): Sentence | null {
  const all = splitSentences(content);
  const inside = all.find((one) => offset >= one.from && offset <= one.to);
  if (inside) return inside;
  // 光标停在句子之间（比如行尾）：退一步，取前面最近的那句
  let best: Sentence | null = null;
  for (const one of all) {
    if (one.to <= offset) best = one;
  }
  return best ?? all[0] ?? null;
}

/** 公共前缀 / 公共后缀的字数（模糊重定位的打分） */
function commonScore(a: string, b: string): number {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return head + tail;
}

/**
 * 拿一个锚点在**当前正文**里找位置：先哈希，再前后文，再认命。
 *
 * 🔴 全程只读 —— 绝不修改正文（正文是用户手写的）。
 */
export function resolveAnchor(content: string, anchor: Anchor): AnchorHit {
  const all = splitSentences(content);
  if (all.length === 0) return { kind: "orphan", line: -1, sentence: null };

  const exact = all.find((one) => sentenceHash(one.text) === anchor.hash);
  if (exact) return { kind: "exact", line: exact.line, sentence: exact };

  let best: Sentence | null = null;
  let bestScore = 0;
  for (const one of all) {
    const score = commonScore(one.text, anchor.quote);
    if (score > bestScore) {
      best = one;
      bestScore = score;
    }
  }
  if (best && bestScore >= FUZZY_MIN_SCORE) {
    return { kind: "fuzzy", line: best.line, sentence: best, score: bestScore };
  }
  return { kind: "orphan", line: -1, sentence: null };
}
