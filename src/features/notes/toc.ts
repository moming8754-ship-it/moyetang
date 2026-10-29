/**
 * 目录语法 `toc第二章`（M14-A）—— 认知区右侧「目录」页签的数据来源。
 *
 * # 规则（用户 2026-09-26 拍板，与 V1 `-[]文字` 同一家族）
 * 1. **只认行首**（行首**可以有空格的**，跟 `-[]` 一样：`trimStart()` 之后再认）；
 * 2. **只认小写 `toc`** —— `TOC第二章` / `Toc第二章` 一律当普通文字（用户明确选的）；
 * 3. `toc` 后面**允许一个空格**：`toc 第二章` 也认；
 * 4. **必须带文字**：光写一个 `toc` 不算条目；
 * 5. 🔴 **防误吃**：`toc` 后面**紧跟英文字母或数字**就不算条目 ——
 *    这条是专门用来挡住 `tocontinue` / `toc2` 这种"看着像 toc 其实是普通词"的正文；
 * 6. ⭐ **行尾标点自动剥掉**（2026-10-02 用户反馈加的）：`toc 第二章，` 目录里就是「第二章」——
 *    他原话是"我之前的文件里就是 `toc 第二章，`，结果被整个吃进去了"。
 *    ⚠️ **只剥行尾**：`toc 第二章，分组密码` 中间那个逗号**不动**（那是他有心写的）。
 *
 * # 为什么全在前端
 * 目录是**纯视图**（从正文内容算出来的），后端没有任何消费者 —— 写一份 Rust 解析器就是死代码
 * （项目规矩：没用的壳子直接删）。`-[]` 之所以两边各有一份，是因为它要生成待办、后端真在用。
 *
 * ⚠️ 这份规则表跟设计稿 `.spike\M14-认知区增强设计稿.html` 里那张用例表**必须一致**；
 *    改动前先看那张表。
 */

/** 一条目录条目 */
export interface TocEntry {
  /** 在正文里的行号（0 起） */
  line: number;
  /** 条目文字（已 trim，原样保留大小写） */
  text: string;
}

/** 认的前缀：**只有小写**（用户定的） */
const PREFIX = "toc";

/** 行首允许的空格/制表符（跟 `-[]` 的 `trimStart()` 一致） */
function trimStart(line: string): string {
  return line.replace(/^[ \t\u3000]+/, "");
}

/** 一个字符是不是"英文字母或数字"（那道防误吃的闸就认这个） */
function isAsciiAlnum(ch: string): boolean {
  return /[0-9A-Za-z]/.test(ch);
}

/**
 * 行尾要剥掉的标点（2026-10-02 用户反馈）。
 *
 * 为什么是"剥"而不是"报错"：他是**手写**正文的人，写 `toc 第二章，` 是天经地义的标点习惯，
 * 程序该迁就他，而不是让他为了目录去改标点（V1 铁律：程序别替他改字 —— 这里也只是**读的时候忽略**，
 * 正文一个字都不动）。
 *
 * 收的是一般中文/英文标点；`！？` 也在内（`toc 结论！` → 「结论」）；
 * ⚠️ **引号与括号不进这个表**：`toc 论「摩耶」` 剥掉右引号会把人家有意写的括号弄残，
 * 得不偿失（宁可多留一个标点，也别吃掉正文）。
 */
const TRAILING_PUNCT = /[，。；：、,.．;:!！?？…~～—－\-·]+$/;

/** 反复剥行尾标点（`第2章。，` 这种叠两个的也一次剥干净） */
function stripTrailingPunct(text: string): string {
  let out = text;
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out.replace(TRAILING_PUNCT, "").trimEnd();
  }
  return out;
}

/**
 * 这一行是不是目录条目？是就给出条目文字，不是就给 `null`。
 *
 * 规则见文件头。**纯函数**，没有副作用、不碰 DOM。
 */
export function tocTextOf(line: string): string | null {
  const trimmed = trimStart(line);
  if (!trimmed.startsWith(PREFIX)) return null;
  let rest = trimmed.slice(PREFIX.length);
  // `toc` 后面允许恰好一个空格（多个也行 —— 人容易多敲，别为这个卡人）
  rest = rest.replace(/^[ \t\u3000]+/, "");
  if (!rest) return null; // 光写个 toc：不算（必须带文字）
  // 🔴 那道闸：紧跟英文字母/数字 → 不是条目（tocontinue / toc2 / tocChapter）
  if (isAsciiAlnum(rest[0])) return null;
  const text = stripTrailingPunct(rest.trim());
  return text ? text : null;
}

/**
 * 扫一遍正文，按出现顺序给出所有目录条目。
 *
 * ⚠️ **不修改正文一个字**（V1 铁律）：这里只读。
 */
export function scanToc(content: string): TocEntry[] {
  const found: TocEntry[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const text = tocTextOf(line);
    if (text) found.push({ line: index, text });
  });
  return found;
}

/**
 * 预览模式下这一行要不要画成标题？要就给出标题文字，不要就给 `null`。
 *
 * 跟 `scanToc` 同一套规则 —— 编辑模式里 `toc第二章` **原样显示**（不改用户正文），
 * 只有预览模式才画成一行标题（看着清爽）。
 */
export function tocHeadingOf(line: string): string | null {
  return tocTextOf(line);
}
