/**
 * 倒计时的天数算法（2026-10-04 · V2 打磨「倒计时」批）。
 *
 * # 为什么单独一个文件
 * 这是**唯一一处**把「目标日 → 还有几天」算出来的地方：日程月视图、周视图、桌面挂件
 * 全都调它。散在三个组件里迟早出现"月视图说 41 天、挂件说 40 天"这种对不上的事
 * （项目里已经吃过一次"两个计时器各跑各的"的亏，见专注小窗那条注释）。
 *
 * # 两条规矩
 * 1. **按本地日历天算，不按 24 小时**：`date` 只有天，拿它跟"今天"的本地零点相减，
 *    再除以一天的毫秒数取整 —— 这样跨夏令时/跨时区都不会差一天。
 * 2. **不算时刻**：今天哪怕只剩 1 分钟，也是「就是今天」（`0`），不是「已过」。
 */

/** 把 `YYYY-MM-DD` 解析成本地零点；解析不出来返回 null（后端已经校验过，这里是兜底） */
export function localDayOf(date: string, now: Date = new Date()): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const value = new Date(year, month, day, 0, 0, 0, 0);
  // 防"2026-02-30"这种被 Date 自己滚成 3 月 2 日的假日子
  if (value.getFullYear() !== year || value.getMonth() !== month || value.getDate() !== day) {
    return null;
  }
  void now;
  return value;
}

/** 今天（本地）的零点 */
function todayStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 还有几天：`>0` 还没到 ｜ `0` 就是今天 ｜ `<0` 已经过了（绝对值 = 过了几天）。
 * 日期读不出来时返回 `null`（界面显示"日期不对"，别瞎算）。
 */
export function daysLeftOf(date: string, now: Date = new Date()): number | null {
  const target = localDayOf(date, now);
  if (!target) return null;
  return Math.round((target.getTime() - todayStart(now).getTime()) / DAY_MS);
}

/**
 * 给人看的那句话：
 * - `47` → `还有 47 天`
 * - `1` → `还有 1 天`
 * - `0` → `就是今天`
 * - `-3` → `已过 3 天`
 */
export function countdownText(days: number | null): string {
  if (days === null) return "日期不对";
  if (days === 0) return "就是今天";
  if (days > 0) return `还有 ${days} 天`;
  return `已过 ${Math.abs(days)} 天`;
}

/** 挂件/月视图上那种"数字 + 单位"的短写法：`47 天` / `今天` / `已过 3 天` */
export function countdownShort(days: number | null): string {
  if (days === null) return "？";
  if (days === 0) return "今天";
  if (days > 0) return `${days} 天`;
  return `已过 ${Math.abs(days)} 天`;
}

/** 按目标日从近到远排（同一天按标题稳定排；"已经过了的"排最后面） */
export function sortByDate<T extends { date: string; title: string }>(
  items: T[],
  now: Date = new Date(),
): T[] {
  return [...items].sort((a, b) => {
    const da = daysLeftOf(a.date, now);
    const db = daysLeftOf(b.date, now);
    // 过了的（<0）沉底，其余按天数升序
    const ra = da === null ? 99_999 : da < 0 ? 90_000 + Math.abs(da) : da;
    const rb = db === null ? 99_999 : db < 0 ? 90_000 + Math.abs(db) : db;
    if (ra !== rb) return ra - rb;
    return a.title.localeCompare(b.title);
  });
}
