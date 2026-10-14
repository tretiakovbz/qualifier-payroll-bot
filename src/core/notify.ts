// Уведомления: лента в Mini App (со звуком) и личные сообщения в боте.
// Личные сообщения уходят только в боевом режиме и только если сотрудник их не выключил.

import { db } from "../db/client.ts";
import { config } from "../config.ts";
import { send } from "../lib/telegram.ts";
import { getEmployee, type Prefs } from "./employees.ts";

export type NotifyKind = "approved" | "rejected" | "bonus" | "payout" | "promo" | "reminder" | "registration" | "achievement" | "system";

/** Какие виды можно выключить в настройках профиля */
const PREF_KEY: Partial<Record<NotifyKind, keyof NonNullable<Prefs["notify"]>>> = {
  approved: "approved",
  rejected: "approved",
  bonus: "bonus",
  payout: "payout",
  promo: "promo",
  reminder: "reminder",
};

export const sentLog: { uid: number; text: string }[] = [];

export async function notify(
  uid: number,
  n: { kind: NotifyKind; title: string; body?: string; amount?: number },
  opts: { dm?: boolean } = { dm: true },
) {
  uid = Number(uid); // BIGINT из базы может прийти строкой
  if (n.kind !== "reminder") {
    await db`INSERT INTO notifications(uid, kind, title, body, amount)
      VALUES(${uid}, ${n.kind}, ${n.title}, ${n.body ?? null}, ${n.amount ?? null})`;
  }
  if (opts.dm === false) return;
  await dm(uid, n.body ? `${n.title}\n${n.body}` : n.title, n.kind);
}

export async function dm(uid: number, text: string, kind: NotifyKind = "system", extra: Record<string, unknown> = {}) {
  uid = Number(uid);
  const e = await getEmployee(uid);
  if (!e || !e.can_dm) return false;
  const key = PREF_KEY[kind];
  if (key && e.prefs?.notify?.[key] === false) return false;
  if (!config.liveMode) {
    sentLog.push({ uid, text });
    return false;
  }
  try {
    const r = (await send(uid, text, extra)) as { ok: boolean };
    return r.ok;
  } catch (err) {
    console.error("[dm]", uid, err);
    return false;
  }
}

export async function listNotifications(uid: number, limit = 30) {
  return db`SELECT id, kind, title, body, amount, created_at, read_at FROM notifications
    WHERE uid = ${uid} ORDER BY created_at DESC LIMIT ${limit}`;
}

export async function markRead(uid: number) {
  await db`UPDATE notifications SET read_at = now() WHERE uid = ${uid} AND read_at IS NULL`;
}
