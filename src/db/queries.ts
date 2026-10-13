// Запросы к базе, общие для бота, API и крона.

import { db } from "./client.ts";
import { config } from "../config.ts";

export interface RankRow {
  uid: number;
  name: string;
  approved: number;
  pending: number;
}

export async function ranking(from: string, to: string): Promise<RankRow[]> {
  return db`
    SELECT uid, MAX(name) AS name,
      COALESCE(SUM(n) FILTER (WHERE status = 'approved'), 0)::int AS approved,
      COALESCE(SUM(n) FILTER (WHERE status = 'pending'), 0)::int AS pending
    FROM reports
    WHERE chat = ${config.groupId} AND day BETWEEN ${from} AND ${to}
    GROUP BY uid
    ORDER BY approved DESC, name`;
}

export async function approvedCount(uid: number, from: string, to: string): Promise<number> {
  const rows = await db`
    SELECT COALESCE(SUM(n), 0)::int AS n FROM reports
    WHERE chat = ${config.groupId} AND uid = ${uid} AND status = 'approved'
      AND day BETWEEN ${from} AND ${to}`;
  return rows[0].n;
}

export async function teamApprovedCount(from: string, to: string): Promise<number> {
  const rows = await db`
    SELECT COALESCE(SUM(n), 0)::int AS n FROM reports
    WHERE chat = ${config.groupId} AND status = 'approved' AND day BETWEEN ${from} AND ${to}`;
  return rows[0].n;
}

export async function upsertReport(r: { msg: number; uid: number; name: string; n: number; day: string }) {
  await db`
    INSERT INTO reports(chat, msg, uid, name, n, day, status)
    VALUES(${config.groupId}, ${r.msg}, ${r.uid}, ${r.name}, ${r.n}, ${r.day}, 'pending')
    ON CONFLICT(chat, msg) DO UPDATE SET n = excluded.n, name = excluded.name, status = 'pending'`;
}

export async function setReportStatus(msg: number, status: "approved" | "rejected" | "pending") {
  await db`UPDATE reports SET status = ${status} WHERE chat = ${config.groupId} AND msg = ${msg}`;
}

export async function touchEmployee(uid: number, name: string, canDm = false) {
  if (canDm) {
    await db`INSERT INTO employees(uid, name, can_dm) VALUES(${uid}, ${name}, TRUE)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, can_dm = TRUE`;
  } else {
    await db`INSERT INTO employees(uid, name) VALUES(${uid}, ${name})
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name`;
  }
}

/** Следующий индекс фразы-ответа для сотрудника (по кругу) */
export async function nextReplyIndex(uid: number, total: number): Promise<number> {
  const rows = await db`
    UPDATE employees SET reply_idx = (reply_idx + 1) % ${total}
    WHERE uid = ${uid} RETURNING reply_idx`;
  return rows[0]?.reply_idx ?? 0;
}

export async function getReminders(uid: number): Promise<boolean> {
  const rows = await db`SELECT reminders FROM employees WHERE uid = ${uid}`;
  return rows[0]?.reminders ?? true;
}

export async function setReminders(uid: number, name: string, enabled: boolean) {
  await db`INSERT INTO employees(uid, name, reminders) VALUES(${uid}, ${name}, ${enabled})
    ON CONFLICT(uid) DO UPDATE SET reminders = excluded.reminders`;
}

export async function toggleReminders(uid: number, name: string): Promise<boolean> {
  const rows = await db`
    INSERT INTO employees(uid, name, can_dm) VALUES(${uid}, ${name}, TRUE)
    ON CONFLICT(uid) DO UPDATE SET reminders = NOT employees.reminders, can_dm = TRUE
    RETURNING reminders`;
  return rows[0].reminders;
}

export async function markPaid(uid: number, period: string, amount: number, actor: number) {
  await db.begin(async (tx) => {
    await tx`INSERT INTO payments(uid, period, amount) VALUES(${uid}, ${period}, ${amount})
      ON CONFLICT(uid, period) DO UPDATE SET amount = excluded.amount, paid_at = now()`;
    await tx`INSERT INTO payment_audit(uid, period, actor, amount) VALUES(${uid}, ${period}, ${actor}, ${amount})
      ON CONFLICT(uid, period) DO UPDATE SET amount = excluded.amount, actor = excluded.actor, marked_at = now()`;
  });
}

export async function paidAmount(uid: number, period: string): Promise<number | null> {
  const rows = await db`SELECT amount FROM payments WHERE uid = ${uid} AND period = ${period}`;
  return rows.length ? rows[0].amount : null;
}
