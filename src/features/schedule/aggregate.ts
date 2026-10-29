/**
 * 日历 / 日程的**数据聚合**（M11-A）—— 全是纯函数：不碰文件、不碰 store、不碰界面。
 *
 * # 为什么坚持"算"而不是"存"
 * PRDv2 §3.1 核实过：`Todo.doneAt` / `createdAt` / `plannedAt` / `Info.createdAt` 都已经有了，
 * 所以「某天完成了哪些 / 设计了哪些 / 填写了哪些」**全部能实时算出来**。
 * 另存一份"当日快照"就等于同一个事实有两个来源，迟早对不上（V1 一路踩出来的教训）。
 * 真正需要落盘的只有**用户自己敲的字**（"为什么没跟进"、当天小结）→ `dailies/*.json`。
 *
 * # 🔴 时区（M9-9 踩过，这里再钉一遍）
 * 后端存的是 **UTC**（`nowIso()` 出来是 `…T10:30Z`），在 +08 时区里本地 18:30 会存成 10:30Z。
 * 所以**一律 `new Date(iso)` 还原成本地再取年月日**，绝不 `iso.slice(0, 10)` ——
 * 那样一到清晨 8 点前就会把"昨天"算成"今天"。
 */
import type { DailyNote, Info, Todo } from "../types";
import { pomodoroEffective } from "../types";

/** 一次番茄在某天日报里的一行（M13-B） */
export interface FocusEntry {
  todoId: string;
  title: string;
  at: string;
  /** 这次番茄计划 / 走完的秒数 */
  seconds: number;
  /** 有效专注秒数（作废 = 0，否则扣掉暂停那一段） */
  effectiveSeconds: number;
  /** 疑似离开累计秒数 */
  interruptedSeconds: number;
  /** 疑似离开发生了几次 */
  interruptedTimes: number;
  /** 锁屏 / 休眠自动暂停累计秒数 */
  pausedSeconds: number;
  /** 用户选了「作废」（记录照留，这是留痕的那一笔） */
  voided: boolean;
}

/** M13-B：一天的专注汇总 */
export interface FocusDaySummary {
  /** 这天开了几次番茄 —— **作废的也算**（用户 2026-09-26 定） */
  count: number;
  /** 有效专注总秒数 */
  effectiveSeconds: number;
  /** 疑似离开总秒数 */
  interruptedSeconds: number;
  /** 暂停总秒数 */
  pausedSeconds: number;
  /** 作废了几次 */
  voidedCount: number;
  /** 明细（最近的在前） */
  entries: FocusEntry[];
}

/** 一天的完整报告（自动那三类 + 未跟进 + 专注） */
export interface DayReport {
  date: string;
  /** 这天**完成**的（按 `doneAt` 算） */
  done: Todo[];
  /** 这天**安排**的（按 `plannedAt` 算；做完没做完都算"设计过"） */
  planned: Todo[];
  /** 这天**填写**进信息区的（按 `createdAt` 算） */
  infos: Info[];
  /** 这天**没跟进**的（规则见 `unfollowedOn`） */
  unfollowed: Todo[];
  /** 这天的专注（M13-B：番茄次数 / 有效时长 / 疑似离开 / 作废） */
  focus: FocusDaySummary;
}

/** 某个月里每一天的三个计数（月历格子上的小色块用它） */
export interface DayCount {
  done: number;
  planned: number;
  info: number;
  /** M13-B：这天有几次番茄"被打断过"（疑似离开）—— 格子上的小黄点用它 */
  trouble: number;
  /** M13-B：这天作废了几次 */
  voided: number;
}

/** 月历网格里的一格 */
export interface GridCell {
  /** `YYYY-MM-DD` */
  key: string;
  /** 日（几号） */
  day: number;
  /** 是不是这个月里的（前后补白用） */
  inMonth: boolean;
}

/** 本地日期键 `YYYY-MM-DD`。传 ISO 串或 Date 都行 */
export function dateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `HH:MM`（本地） */
export function hhmm(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

/**
 * 秒数 → 「1 小时 25 分」/「12 分 40 秒」这种给人看的话（日报与导出用）。
 * 0 秒给「0 秒」而不是空串 —— 日报上"疑似离开 0 秒"比什么都不写更清楚。
 */
export function durationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  return `${s} 秒`;
}

const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 星期几（本地），`2026-09-26` → `周六` */
export function weekdayLabel(key: string): string {
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  // getDay(): 0=周日 → 换成"周一打头"的下标
  return WEEK_LABELS[(date.getDay() + 6) % 7];
}

/** `2026-09` */
export function monthKey(year: number, month: number): string {
  return `${year}-${`${month}`.padStart(2, "0")}`;
}

/** `2026 年 9 月` */
export function monthLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

/**
 * 「未跟进」= 这条待办**该在那天做**（设了那天的时间，或那天到期），但**到现在还没完成**。
 *
 * ⚠️ 三档区别对待，不然会出现"今天下午的事，早上就催我"这种蠢事：
 * - **过去的日子**：只要还开着（`status === "open"`）就算没跟进；
 * - **今天**：只有**已经到点**（时间早于此刻）的才算，还没到点的算"还没到"；
 * - **未来的日子**：一律不算（未来的事谈不上"没跟进"）。
 */
export function unfollowedOn(date: string, todos: Todo[], now: Date = new Date()): Todo[] {
  const today = dateKey(now);
  if (!today || date > today) return [];
  const isToday = date === today;

  return todos.filter((todo) => {
    if (todo.status === "done") return false;
    const marks = [todo.plannedAt, todo.dueAt].filter(
      (one): one is string => !!one && dateKey(one) === date,
    );
    if (marks.length === 0) return false;
    if (!isToday) return true;
    return marks.some((one) => new Date(one).getTime() <= now.getTime());
  });
}

/** 某一天的完整报告（三类自动内容 + 未跟进 + 专注） */
export function dayReport(
  date: string,
  todos: Todo[],
  infos: Info[],
  now: Date = new Date(),
): DayReport {
  const byTime = (a: Todo, b: Todo) => {
    const left = new Date(a.plannedAt ?? a.doneAt ?? a.createdAt).getTime();
    const right = new Date(b.plannedAt ?? b.doneAt ?? b.createdAt).getTime();
    return left - right;
  };
  return {
    date,
    done: todos.filter((todo) => !!todo.doneAt && dateKey(todo.doneAt) === date).sort(byTime),
    planned: todos
      .filter((todo) => !!todo.plannedAt && dateKey(todo.plannedAt) === date)
      .sort(byTime),
    infos: infos
      .filter((info) => dateKey(info.createdAt) === date)
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    unfollowed: unfollowedOn(date, todos, now),
    focus: focusOn(date, todos),
  };
}

/**
 * M13-B：某一天的专注汇总。
 *
 * 🔴 用户 2026-09-26 定的两条：
 * ① **作废的那次也算一次番茄**（"这天我确实开过 3 个番茄"），只是标出来；
 * ② 有效时长里要把作废的与暂停掉的那段扣掉。
 */
export function focusOn(date: string, todos: Todo[]): FocusDaySummary {
  const entries: FocusEntry[] = [];
  todos.forEach((todo) => {
    (todo.pomodoros ?? []).forEach((one) => {
      if (dateKey(one.at) !== date) return;
      entries.push({
        todoId: todo.id,
        title: todo.title,
        at: one.at,
        seconds: Math.max(0, one.seconds || 0),
        effectiveSeconds: pomodoroEffective(one),
        interruptedSeconds: Math.max(0, one.interruptedSeconds ?? 0),
        interruptedTimes: Math.max(0, one.interruptedTimes ?? 0),
        pausedSeconds: Math.max(0, one.pausedSeconds ?? 0),
        voided: !!one.voided,
      });
    });
  });
  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return {
    count: entries.length,
    effectiveSeconds: entries.reduce((sum, one) => sum + one.effectiveSeconds, 0),
    interruptedSeconds: entries.reduce((sum, one) => sum + one.interruptedSeconds, 0),
    pausedSeconds: entries.reduce((sum, one) => sum + one.pausedSeconds, 0),
    voidedCount: entries.filter((one) => one.voided).length,
    entries,
  };
}

/** 某个月里每天的三个计数 */
export function monthCounts(
  year: number,
  month: number,
  todos: Todo[],
  infos: Info[],
): Record<string, DayCount> {
  const prefix = `${monthKey(year, month)}-`;
  const out: Record<string, DayCount> = {};
  const bump = (key: string, field: keyof DayCount) => {
    if (!key.startsWith(prefix)) return;
    const cell = out[key] ?? { done: 0, planned: 0, info: 0, trouble: 0, voided: 0 };
    cell[field] += 1;
    out[key] = cell;
  };
  todos.forEach((todo) => {
    if (todo.doneAt) bump(dateKey(todo.doneAt), "done");
    if (todo.plannedAt) bump(dateKey(todo.plannedAt), "planned");
    // M13-B：这一天有几次番茄被打断过 / 作废过（格子上的小黄点）
    (todo.pomodoros ?? []).forEach((one) => {
      const key = dateKey(one.at);
      if ((one.interruptedTimes ?? 0) > 0) bump(key, "trouble");
      if (one.voided) bump(key, "voided");
    });
  });
  infos.forEach((info) => bump(dateKey(info.createdAt), "info"));
  return out;
}

/**
 * 月历网格：**从周一起算**，前后补成整周（35 或 42 格）。
 * 补白格也返回（`inMonth: false`），界面上画成灰的 —— 这样点击"上个月的尾巴"还能顺手续到那个月。
 */
export function monthGrid(year: number, month: number): GridCell[] {
  const first = new Date(year, month - 1, 1);
  if (Number.isNaN(first.getTime())) return [];
  const offset = (first.getDay() + 6) % 7; // 周一 = 0
  const daysInMonth = new Date(year, month, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;

  const cells: GridCell[] = [];
  for (let index = 0; index < total; index += 1) {
    const date = new Date(year, month - 1, 1 - offset + index);
    cells.push({
      key: dateKey(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month - 1,
    });
  }
  return cells;
}

/**
 * 把一天的日报拼成纯文本（导出 txt 用）。
 * ⚠️ **用户写的字一个字都不许改**：`notes` 原样贴进去（只做缩进），
 * 这是 V1 就立下的规矩（"正文是用户手写的，程序不替他改字"）。
 */
export function reportToText(
  report: DayReport,
  notes: DailyNote[],
  sourceLabel: (todo: Todo) => string,
  now: Date = new Date(),
): string {
  const noteOf = (key: string) => notes.find((one) => one.key === key)?.text.trim() ?? "";
  const lines: string[] = [];
  const [year, month, day] = report.date.split("-");

  lines.push(`东方摩耶堂 · ${year} 年 ${Number(month)} 月 ${Number(day)} 日（${weekdayLabel(report.date)}）日报`);
  lines.push(`（导出时间：${dateKey(now)} ${hhmm(now.toISOString())}）`);
  lines.push("");

  lines.push(`【完成了 ${report.done.length} 件】`);
  if (report.done.length === 0) lines.push("（这天没有完成的待办）");
  report.done.forEach((todo) => {
    lines.push(`  ☑ ${todo.title}`);
    const when = todo.doneAt ? hhmm(todo.doneAt) : "";
    const extra = [when && `完成于 ${when}`, sourceLabel(todo)].filter(Boolean).join(" · ");
    if (extra) lines.push(`      ${extra}`);
  });
  lines.push("");

  lines.push(`【设计了 ${report.planned.length} 件】`);
  if (report.planned.length === 0) lines.push("（这天没有安排待办）");
  report.planned.forEach((todo) => {
    const when = todo.plannedAt ? hhmm(todo.plannedAt) : "";
    lines.push(`  ${todo.status === "done" ? "☑" : "☐"} ${todo.title}`);
    const extra = [when && `设定时间 ${when}`, sourceLabel(todo)].filter(Boolean).join(" · ");
    if (extra) lines.push(`      ${extra}`);
  });
  lines.push("");

  lines.push(`【填写了 ${report.infos.length} 条信息】`);
  if (report.infos.length === 0) lines.push("（这天没往信息区丢东西）");
  report.infos.forEach((info) => {
    const text = (info.text || "").trim() || "（图片信息）";
    lines.push(`  · ${text.replace(/\n/g, " ")}`);
    const extra = [hhmm(info.createdAt), info.categories.join(" / ")].filter(Boolean).join(" · ");
    if (extra) lines.push(`      ${extra}`);
  });
  lines.push("");

  lines.push(
    `【专注 ${report.focus.count} 个番茄 · 有效 ${durationText(report.focus.effectiveSeconds)}】`,
  );
  if (report.focus.count === 0) lines.push("（这天没开番茄钟）");
  if (report.focus.interruptedSeconds > 0 || report.focus.voidedCount > 0) {
    lines.push(
      `  其中疑似离开 ${durationText(report.focus.interruptedSeconds)} · 作废 ${report.focus.voidedCount} 次`,
    );
  }
  report.focus.entries.forEach((one) => {
    lines.push(`  ${one.voided ? "✗" : "🍅"} ${one.title}`);
    const extra = [
      hhmm(one.at),
      one.voided ? "作废（这几分钟不算专注）" : "计入",
      `有效 ${durationText(one.effectiveSeconds)}`,
      one.interruptedSeconds > 0
        ? `疑似离开 ${durationText(one.interruptedSeconds)}（${one.interruptedTimes} 次）`
        : "",
      one.pausedSeconds > 0 ? `暂停 ${durationText(one.pausedSeconds)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (extra) lines.push(`      ${extra}`);
  });
  lines.push("");

  lines.push(`【未跟进 ${report.unfollowed.length} 件】`);
  if (report.unfollowed.length === 0) lines.push("（这天该做的都做完了）");
  report.unfollowed.forEach((todo) => {
    const when = todo.plannedAt ? `设定时间 ${hhmm(todo.plannedAt)}` : "";
    const due = todo.dueAt ? `截止 ${hhmm(todo.dueAt)}` : "";
    lines.push(`  ☐ ${todo.title}`);
    const extra = [when, due, sourceLabel(todo)].filter(Boolean).join(" · ");
    if (extra) lines.push(`      ${extra}`);
    const why = noteOf(`todo:${todo.id}`);
    if (why) lines.push(`      为什么没跟进：${why}`);
  });
  lines.push("");

  const summary = noteOf("day");
  if (summary) {
    lines.push("【当天小结】");
    summary.split("\n").forEach((one) => lines.push(`  ${one}`));
    lines.push("");
  }
  lines.push("—— 这一行以上都是东方摩耶堂自动生成 + 你手写的说明。");
  return lines.join("\n");
}

// ───────────────────────── 周视图（M11-B） ─────────────────────────

/** 周视图里的一张卡（一条待办可能在"设定那天"和"截止那天"各出现一次，同一天就合成一张） */
export interface WeekItem {
  todo: Todo;
  /** 有**设定时间**、且就是这天（排在这一列的时间顺序里） */
  planned: boolean;
  /** 有**截止日期**、且就是这天 */
  due: boolean;
  /** 逾期（没完成 + 截止时间已经过了） */
  overdue: boolean;
  /** 排序用的时间戳：有设定时间的用它，只有截止的用截止时间 */
  at: number;
}

/** 周视图里的一列 = 一天 */
export interface WeekDay {
  /** `YYYY-MM-DD` */
  key: string;
  items: WeekItem[];
}

/** 日期加减天数（本地） */
export function shiftKey(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/** 某个日期所在那一周的**周一**（本地；设计稿定的是周一起头） */
export function weekStartKey(anchor: string): string {
  const date = new Date(`${anchor}T00:00:00`);
  if (Number.isNaN(date.getTime())) return anchor;
  const offset = (date.getDay() + 6) % 7; // 周一 = 0
  date.setDate(date.getDate() - offset);
  return dateKey(date);
}

/** `9 月 22 日 – 9 月 28 日` */
export function weekLabel(startKey: string): string {
  const end = shiftKey(startKey, 6);
  const [, m1, d1] = startKey.split("-");
  const [, m2, d2] = end.split("-");
  return `${Number(m1)} 月 ${Number(d1)} 日 – ${Number(m2)} 月 ${Number(d2)} 日`;
}

/** 某天的某个时刻（本地）→ ISO 串。用来给"在那天加一件事"兜个默认时间 */
export function dayAt(key: string, hour = 9, minute = 0): string {
  const date = new Date(`${key}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

/**
 * 某一周（周一起算）的七日看板。
 *
 * 规则（照设计稿屏幕 2）：
 * - 一条待办出现在它**设定时间**那天；如果还有**截止日期**，也在截止那天露一次脸（同一天合成一张）；
 * - **有设定时间的排前面**（按时刻），只有截止日期的**排在当天最后**；
 * - 只读聚合，不写任何东西。
 */
export function weekBoard(anchor: string, todos: Todo[], now: Date = new Date()): WeekDay[] {
  const start = weekStartKey(anchor);
  const days: WeekDay[] = [];
  const index = new Map<string, number>();
  for (let step = 0; step < 7; step += 1) {
    const key = shiftKey(start, step);
    index.set(key, days.length);
    days.push({ key, items: [] });
  }

  todos.forEach((todo) => {
    if (!todo.plannedAt && !todo.dueAt) return;
    const plannedKey = todo.plannedAt ? dateKey(todo.plannedAt) : "";
    const dueKey = todo.dueAt ? dateKey(todo.dueAt) : "";
    [plannedKey, dueKey].forEach((key) => {
      const at = index.get(key);
      if (at === undefined) return; // 不在这一周里
      const day = days[at];
      let item = day.items.find((one) => one.todo.id === todo.id);
      if (!item) {
        item = { todo, planned: false, due: false, overdue: false, at: 0 };
        day.items.push(item);
      }
      if (key === plannedKey) item.planned = true;
      if (key === dueKey) item.due = true;
    });
  });

  const nowMs = now.getTime();
  days.forEach((day) => {
    day.items.forEach((item) => {
      const plannedMs = item.todo.plannedAt ? new Date(item.todo.plannedAt).getTime() : 0;
      const dueMs = item.todo.dueAt ? new Date(item.todo.dueAt).getTime() : 0;
      item.at = item.planned ? plannedMs : dueMs;
      item.overdue = item.todo.status !== "done" && dueMs > 0 && dueMs < nowMs;
    });
    day.items.sort((a, b) => {
      // 有设定时间的排前面；只有截止日期的排当天最后
      if (a.planned !== b.planned) return a.planned ? -1 : 1;
      return a.at - b.at;
    });
  });
  return days;
}
