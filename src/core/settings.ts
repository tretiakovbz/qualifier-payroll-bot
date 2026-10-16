// Настройки системы: хранятся в базе, общие для всех админов.
// Изменение у одного админа сразу видно другому (кэш живёт 15 секунд).

import { db } from "../db/client.ts";
import { audit, json } from "../db/audit.ts";
import type { PayoutDays, WeekConfig } from "../lib/time.ts";
import { cid } from "./tenant.ts";

export interface Settings {
  rates: { perForm: number; contractBase: number };
  salary: {
    qualifier: { enabled: boolean; monthly: number };
    recruiter: { enabled: boolean; monthly: number };
  };
  payoutDays: PayoutDays;
  week: WeekConfig & { resultsDow: number; resultsHour: number };
  reminders: { hour: number; minute: number; days: number[] };
  /** Публиковать итоги недели и месяца в рабочем чате одним сообщением */
  announceInChat: boolean;
  /** С какой даты начислять оклад и автоматические бонусы (не трогаем историю v1) */
  startDate: string;
  /** Свои фразы бота в ответ на отчёт; пусто — встроенные */
  phrases: { normal: string[]; zero: string[] } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  rates: { perForm: 500, contractBase: 80000 },
  salary: {
    qualifier: { enabled: true, monthly: 20000 },
    recruiter: { enabled: false, monthly: 30000 },
  },
  payoutDays: [5, 20],
  week: { startDow: 0, days: 5, resultsDow: 0, resultsHour: 10 },
  reminders: { hour: 19, minute: 30, days: [0, 1, 2, 3, 4] },
  announceInChat: true,
  startDate: "2026-10-14",
  phrases: null,
};

/** Кэш настроек по компаниям */
const cache = new Map<number, { value: Settings; at: number }>();
const TTL = 15_000;

function merge<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object" || base === null) return patch as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = k in (base as any) ? merge((base as any)[k], patch[k]) : patch[k];
  }
  return out;
}

const keyOf = (id: number) => "company:" + id;

export async function getSettings(): Promise<Settings> {
  const id = cid();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const rows = await db`SELECT value FROM settings WHERE key = ${keyOf(id)}`;
  const raw = rows[0]?.value;
  const value = merge(DEFAULT_SETTINGS, typeof raw === "string" ? JSON.parse(raw) : raw ?? {});
  cache.set(id, { value, at: Date.now() });
  return value;
}

export function validateSettings(s: Settings): string | null {
  const [a, b] = s.payoutDays;
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b <= 28 && a < b)) return "Дни выплат: два числа от 1 до 28 по возрастанию";
  if (s.rates.perForm < 0 || s.rates.contractBase < 0) return "Ставки не могут быть отрицательными";
  if (s.week.days < 1 || s.week.days > 7) return "В рабочей неделе от 1 до 7 дней";
  if (s.week.startDow < 0 || s.week.startDow > 6) return "День начала недели: 0–6";
  return null;
}

export async function updateSettings(patch: Partial<Settings>, actor: number): Promise<Settings> {
  const current = await getSettings();
  const next = merge(current, patch);
  const err = validateSettings(next);
  if (err) throw new SettingsError(err);
  await db`INSERT INTO settings(key, value, updated_by) VALUES(${keyOf(cid())}, ${json(next)}::text::jsonb, ${actor})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
  await audit(actor, "settings.update", patch);
  cache.set(cid(), { value: next, at: Date.now() });
  return next;
}

export class SettingsError extends Error {}

export function resetSettingsCache() {
  cache.clear();
}
