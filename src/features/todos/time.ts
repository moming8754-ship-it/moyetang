/**
 * 执行区的时间小工具（M5）。
 *
 * 全是**本地时间**的换算：`todos.json` 里存 ISO（带时区），
 * 而 `<input type="datetime-local">` 只认 `YYYY-MM-DDTHH:mm` 这种
 * **不带时区的本地时间**，两边必须转一道，否则会差好几个小时。
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO → `datetime-local` 输入框要的值（本地时间，`YYYY-MM-DDTHH:mm`） */
export function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `datetime-local` 输入框的值（本地时间）→ ISO；空值返回 `null`（表示清掉） */
export function fromLocalInput(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** 某天 00:00 的时间戳（用来判"是不是同一天"） */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 这个 ISO 是不是"今天" */
export function isToday(iso?: string, now: Date = new Date()): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return startOfDay(date) === startOfDay(now);
}

/** 只要时分 `HH:mm`（今日时间轴上显示用） */
export function hhmm(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 同日待办排序用的分钟数（0~1439）；时间坏了排到最后 */
export function minutesOfDay(iso: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Number.MAX_SAFE_INTEGER;
  return date.getHours() * 60 + date.getMinutes();
}

/** 秒 → `mm:ss`（番茄钟倒计时用；超过一小时给 `h:mm:ss`） */
export function clockText(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 秒数 → 一句人话的"专注了多久"（M9-3）。
 *
 * 番茄钟记录的 `seconds` 是秒，直接显示成 `4500 秒` 没人看得懂。
 * 规则：不足 1 分钟给秒、不足 1 小时给分、超过就给"X 小时 Y 分"（整点省略分钟）。
 */
export function focusText(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe < 60) return `${safe} 秒`;
  const minutes = Math.floor(safe / 60);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** 这条记录是不是"今天"的（按本地时间算；坏时间戳算不是） */
export function isTodayStamp(iso?: string, now: Date = new Date()): boolean {
  return isToday(iso, now);
}

/**
 * 一个 ISO 时间属于哪个月，给人看的写法：`2026 年 9 月`（M9-4 归档分组用）。
 * 时间坏了就归到 `更早` —— 至少不会因为一条脏数据让整组消失。
 */
export function monthLabel(iso?: string): string {
  if (!iso) return "更早";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "更早";
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

/** 四象限的中文名（界面上到处要用） */
export const QUADRANT_LABEL: Record<string, string> = {
  q1: "重要且紧急",
  q2: "不重要但紧急",
  q3: "重要但不急",
  q4: "都不",
};

/** 四象限顺序（2×2 排布：上排 q1 q2，下排 q3 q4） */
export const QUADRANT_ORDER = ["q1", "q2", "q3", "q4"] as const;

// ─────────────────── 截止日期（M9-1）───────────────────

/** 这个截止时间是不是**已经过了**（空值/坏值都算没过） */
export function isOverdue(dueAt?: string | null, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < now.getTime();
}

/**
 * 截止日期显示成一句人话：`今天 18:00` / `明天 09:00` / `09-25 18:00` / `逾期 2 天`。
 *
 * 为什么不用 `formatStamp`：截止日期最要紧的信息是"还有多久 / 过了多久"，
 * 让人一眼看出"来不来得及"，而不是一串时间戳。
 */
export function dueText(dueAt?: string | null, now: Date = new Date()): string {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return "";
  const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (date.getTime() < now.getTime()) {
    // 逾期：按"差多久"给粒度（不到一天说小时，超过说天）
    const minutesLate = Math.floor((now.getTime() - date.getTime()) / 60000);
    if (minutesLate < 60) return `逾期 ${Math.max(1, minutesLate)} 分钟`;
    const hoursLate = Math.floor(minutesLate / 60);
    if (hoursLate < 24) return `逾期 ${hoursLate} 小时`;
    return `逾期 ${Math.floor(hoursLate / 24)} 天`;
  }
  if (dayDiff === 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `明天 ${clock}`;
  if (dayDiff === 2) return `后天 ${clock}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
