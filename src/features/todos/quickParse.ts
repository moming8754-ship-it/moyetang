/**
 * 执行区「加一条」输入框的**快捷语法**（M9-9）。
 *
 * 用户想要的是一行写清一件事：
 * ```
 * 买牛奶 !明天
 * 交作业 !周五
 * 打电话给妈妈 !18:30
 * 体检 !9-25
 * 看那部电影 !今晚
 * ```
 *
 * # 为什么只做 `!`（时间）这一种
 * 我原本给用户列的是 `买牛奶 !today #生活 *重要` 三种前缀，但 **`#标签` 要等"标签/项目"那一项**
 * （他排的顺序里是第 7 项，这次没做）—— 现在支持 `#` 会变成一个"存不进去"的语法糖。
 * 所以这一版**只做时间**：`!` 后面跟一个时间说法，解析成"设定时间"（plannedAt，进今日时间轴）。
 * 等标签做了再加 `#`。
 *
 * # 解析放在前端
 * 纯函数、没有副作用，输入框里能**实时**告诉用户"识别到了什么"——
 * 这才是快捷语法的意义（不然打错了都不知道）。落盘时只把 `title` + `plannedAt` 发下去。
 */
import { fromLocalInput } from "./time";

export interface QuickParseResult {
  /** 去掉时间说法之后的标题（没识别到就是原文 trim） */
  title: string;
  /** 解析出来的"设定时间"（ISO）；没识别到是 null */
  plannedAt: string | null;
  /** 给人看的提示，比如 `明天 09:00`；没识别到是空串 */
  hint: string;
  /** 识别到的那个 token 原文（用于界面上高亮/调试） */
  token: string;
  /**
   * 解析出来的**分组名**（D 批，2026-10-04）：`买牛奶 #生活` → `生活`。
   *
   * ⚠️ 原来这里明确不认 `#`（那时候没有"标签/项目"，认了也存不进去）——
   * D 批把待办分组做出来了，`#` 才有落点。**最多 24 字**（跟后端 `set_group` 一个规矩）。
   * 没写 `#` → `null`（保持未分组）。
   */
  group: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 那一天几点（默认上午 9 点：一天的事从这儿开始排，比较像人话） */
const DEFAULT_HOUR = 9;

function atHour(base: Date, hour: number, minute = 0): Date {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  return date;
}

function addDays(base: Date, days: number): Date {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

/** 周几的中文 → 0~6（周日=0，和 Date.getDay 一致） */
const WEEKDAYS: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

/** 解析 `!` 后面的那一段；返回 null 表示"看不懂"（那就当普通文字，别乱猜） */
function parseToken(raw: string, now: Date): Date | null {
  const text = raw.trim();
  if (!text) return null;

  // ① 今天 / 明天 / 后天 / 今晚
  if (text === "今天" || text === "今日") return atHour(now, DEFAULT_HOUR);
  if (text === "明天" || text === "明日") return atHour(addDays(now, 1), DEFAULT_HOUR);
  if (text === "后天") return atHour(addDays(now, 2), DEFAULT_HOUR);
  if (text === "今晚" || text === "今天晚上") return atHour(now, 20);
  if (text === "明晚") return atHour(addDays(now, 1), 20);
  if (text === "早上" || text === "上午") return atHour(now, 9);
  if (text === "中午") return atHour(now, 12);
  if (text === "下午") return atHour(now, 14);
  if (text === "晚上") return atHour(now, 20);

  // ② 时分：18:30 / 18：30 / 18点30 / 18点
  const clock = text.match(/^(\d{1,2})\s*[:：点]\s*(\d{1,2})?分?$/);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    if (hour <= 23 && minute <= 59) {
      const target = atHour(now, hour, minute);
      // 已经过了就顺延到明天 —— "!18:30" 说出口时心里想的是"下一个 18:30"
      return target.getTime() > now.getTime() ? target : atHour(addDays(now, 1), hour, minute);
    }
    return null;
  }

  // ③ 月-日：9-25 / 09-25 / 9月25日 / 9/25
  const monthDay = text.match(/^(\d{1,2})\s*[-\/月]\s*(\d{1,2})\s*[日号]?$/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const thisYear = new Date(now.getFullYear(), month - 1, day, DEFAULT_HOUR, 0, 0, 0);
      // 已经过去的日子 → 当成明年（"9-25" 在 10 月说出口，多半指明年）
      return thisYear.getTime() >= atHour(now, 0).getTime()
        ? thisYear
        : new Date(now.getFullYear() + 1, month - 1, day, DEFAULT_HOUR, 0, 0, 0);
    }
    return null;
  }

  // ④ 周几：周五 / 星期五 / 周5
  const weekday = text.match(/^(?:周|星期|礼拜)([日天一二三四五六1-6])$/);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]] ?? Number(weekday[1]);
    if (target === undefined || Number.isNaN(target)) return null;
    const today = now.getDay();
    let delta = (target - today + 7) % 7;
    // 今天就是那天 → 看时间过没过（"周五"在周五下午说，指的是下周五）
    if (delta === 0) {
      const sameDay = atHour(now, DEFAULT_HOUR);
      delta = sameDay.getTime() > now.getTime() ? 0 : 7;
    }
    return atHour(addDays(now, delta), DEFAULT_HOUR);
  }

  return null;
}

/**
 * 解析一整行输入。
 *
 * 规则（**只认一个 `!` 和一个 `#`**，多的当普通文字）：
 * - 找到第一个 `!`，取它后面到"下一个空格"为止的那一段当时间说法；
 * - 找到第一个 `#`，取它后面到"下一个空格"为止的那一段当**分组名**（D 批新增）；
 * - 看得懂 → 从标题里去掉它；看不懂 → **原样保留**（别把用户打的字吃掉）；
 * - 没写 → 原样返回，对应的字段是 null。
 */
export function parseQuickInput(input: string, now: Date = new Date()): QuickParseResult {
  const text = input.trim();
  const bare: QuickParseResult = { title: text, plannedAt: null, hint: "", token: "", group: null };
  if (!text) return bare;

  // ── 先摘 `#分组`（D 批）：先把它从整行里拿掉，后面的 `!` 就在剩下的文字上找 ──
  let working = text;
  let group: string | null = null;
  const hash = working.indexOf("#");
  if (hash >= 0) {
    const afterHash = working.slice(hash + 1);
    const stopAt = afterHash.search(/\s/);
    const name = (stopAt < 0 ? afterHash : afterHash.slice(0, stopAt)).trim();
    if (name) {
      const stripped = (
        working.slice(0, hash) + " " + (stopAt < 0 ? "" : afterHash.slice(stopAt))
      ).trim();
      // 标题被 `#` 吃空了（整行只有 `#生活`）→ 这不是"给待办加分组"，整行当普通文字
      if (stripped) {
        group = name.slice(0, 24);
        working = stripped;
      }
    }
  }
  if (!working) return bare;

  const bang = working.indexOf("!");
  if (bang < 0) {
    // 只认出了分组，没时间说法
    return group ? { ...bare, title: working, group } : bare;
  }

  // `!` 后面到空格（或行尾）为止
  const rest = working.slice(bang + 1);
  const stop = rest.search(/\s/);
  const token = stop < 0 ? rest : rest.slice(0, stop);
  if (!token) return group ? { ...bare, title: working, group } : bare;

  const when = parseToken(token, now);
  if (!when) return group ? { ...bare, title: working, group } : bare;

  const title = (working.slice(0, bang) + " " + (stop < 0 ? "" : rest.slice(stop))).trim();
  // 标题被 `!` 吃空了就别认（比如整行只有 "!明天"）—— 那种输入宁可当普通待办
  if (!title) return bare;

  const isToday =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  const tomorrow = addDays(now, 1);
  const isTomorrow =
    when.getFullYear() === tomorrow.getFullYear() &&
    when.getMonth() === tomorrow.getMonth() &&
    when.getDate() === tomorrow.getDate();
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const hint = isToday
    ? `今天 ${clock}`
    : isTomorrow
      ? `明天 ${clock}`
      : `${when.getMonth() + 1} 月 ${when.getDate()} 日 ${clock}`;

  return {
    title,
    plannedAt: fromLocalInput(
      `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(
        when.getHours(),
      )}:${pad(when.getMinutes())}`,
    ),
    hint,
    token: `!${token}`,
    group,
  };
}
