import { db } from "./client.ts";

/** JSON-значение для jsonb-колонки */
export const json = (v: unknown) => JSON.stringify(v ?? null);

/** Список строк для колонки TEXT[]: передаём литералом и приводим в запросе через ::text[] */
export const pgTextArray = (list: string[]) => "{" + list.map((s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}";

/** Запись в журнал действий админов */
export async function audit(actor: number | null, action: string, payload: unknown = {}) {
  await db`INSERT INTO audit_log(actor, action, payload) VALUES(${actor}, ${action}, ${json(payload)}::text::jsonb)`;
}
