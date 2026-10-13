// Даты, расчётные периоды, рабочие недели и месяцы.
// Все даты — строки YYYY-MM-DD по часовому поясу отчётности (Москва).

import { config } from "../config.ts";

export type Period = [start: string, end: string];
/** Дни выплат в месяце, по возрастанию. По умолчанию 5 и 20. */
export type PayoutDays = [number, number];
export const DEFAULT_PAYOUT_DAYS: PayoutDays = [5, 20];

/** «Сейчас» в часовом поясе отчётности, представленное как UTC-дата */
export function nowLocal(nowMs = Date.now()): Date {
  return new Date(nowMs + config.tzOffsetHours * 3600_000);
}

export function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function today(nowMs = Date.now()): string {
  return toDay(nowLocal(nowMs));
}

export function parseDay(day: string): Date {
  return new Date(day + "T00:00:00Z");
}

/** День отчёта по unix-времени сообщения Telegram */
export function dayOfMessage(unixSeconds: number): string {
  return toDay(new Date(unixSeconds * 1000 + config.tzOffsetHours * 3600_000));
}

export function addDays(day: string, n: number): string {
  const dt = parseDay(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toDay(dt);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86400_000);
}

/**
 * Расчётный период, в который попадает дата.
 * Для дней выплат [5, 20]: 5–19 (выплата 20-го) и 20–4 (выплата 5-го).
 */
export function periodOf(date: Date | string = nowLocal(), days: PayoutDays = DEFAULT_PAYOUT_DAYS): Period {
  const dt = typeof date === "string" ? parseDay(date) : date;
  const [p1, p2] = days;
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  if (d >= p1 && d < p2) return [iso(y, m, p1), iso(y, m, p2 - 1)];
  if (d >= p2) return [iso(y, m, p2), iso(y, m + 1, p1 - 1)];
  return [iso(y, m - 1, p2), iso(y, m, p1 - 1)];
}

/** Период, идущий за `steps` периодов до текущего (0 — текущий) */
export function periodBack(steps: number, from: Date | string = nowLocal(), days: PayoutDays = DEFAULT_PAYOUT_DAYS): Period {
  let [a, b] = periodOf(from, days);
  for (let i = 0; i < steps; i++) [a, b] = periodOf(addDays(a, -1), days);
  return [a, b];
}

/** День выплаты за период: следующий день после конца периода */
export function payoutDayOf(period: Period): string {
  return addDays(period[1], 1);
}

export interface WeekConfig {
  /** День начала рабочей недели: 0 — воскресенье … 6 — суббота */
  startDow: number;
  /** Сколько дней в рабочей неделе */
  days: number;
}
export const DEFAULT_WEEK: WeekConfig = { startDow: 0, days: 5 };

/** Рабочая неделя, начавшаяся в последний `startDow` на дату или раньше: [начало, конец] */
export function weekOf(day: string, w: WeekConfig = DEFAULT_WEEK): Period {
  const dow = parseDay(day).getUTCDay();
  const start = addDays(day, -((dow - w.startDow + 7) % 7));
  return [start, addDays(start, w.days - 1)];
}

/** Последняя полностью завершившаяся рабочая неделя на дату */
export function lastCompletedWeek(day: string, w: WeekConfig = DEFAULT_WEEK): Period {
  const cur = weekOf(day, w);
  if (day > cur[1]) return cur;
  return weekOf(addDays(cur[0], -1), w);
}

export function monthOf(day: string): Period {
  const dt = parseDay(day);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  return [iso(y, m, 1), iso(y, m + 1, 0)];
}

export function lastCompletedMonth(day: string): Period {
  return monthOf(addDays(monthOf(day)[0], -1));
}

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** «20 октября» */
export function humanDay(day: string): string {
  const dt = parseDay(day);
  return `${dt.getUTCDate()} ${MONTHS_GEN[dt.getUTCMonth()]}`;
}

/** «5–19 октября» или «20 октября – 4 ноября» */
export function humanRange([a, b]: Period): string {
  const da = parseDay(a);
  const db = parseDay(b);
  if (da.getUTCMonth() === db.getUTCMonth()) return `${da.getUTCDate()}–${db.getUTCDate()} ${MONTHS_GEN[db.getUTCMonth()]}`;
  return `${humanDay(a)} – ${humanDay(b)}`;
}
