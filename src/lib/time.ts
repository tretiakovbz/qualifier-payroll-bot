// Даты и расчётные периоды. Все даты — строки YYYY-MM-DD по московскому времени.

import { config } from "../config.ts";

export type Period = [start: string, end: string];

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

/** День отчёта по unix-времени сообщения Telegram */
export function dayOfMessage(unixSeconds: number): string {
  return toDay(new Date(unixSeconds * 1000 + config.tzOffsetHours * 3600_000));
}

/**
 * Расчётный период, в который попадает дата:
 * 5–19 число (выплата 20-го) или 20–4 число (выплата 5-го).
 */
export function periodOf(date: Date = nowLocal()): Period {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (d >= 5 && d <= 19) return [iso(y, m, 5), iso(y, m, 19)];
  if (d >= 20) return [iso(y, m, 20), iso(y, m + 1, 4)];
  return [iso(y, m - 1, 20), iso(y, m, 4)];
}

/** Период, идущий за `steps` периодов до текущего (0 — текущий) */
export function periodBack(steps: number, from: Date = nowLocal()): Period {
  let [a, b] = periodOf(from);
  for (let i = 0; i < steps; i++) {
    const dt = new Date(a + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - 1);
    [a, b] = periodOf(dt);
  }
  return [a, b];
}

export function addDays(day: string, n: number): string {
  const dt = new Date(day + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return toDay(dt);
}
