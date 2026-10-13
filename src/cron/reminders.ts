// Напоминания об отчёте. Запускается по расписанию (Railway cron), 19:30 МСК.
// Пятница и суббота — выходные, напоминаний нет.

import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { send } from "../lib/telegram.ts";
import { nowLocal, toDay } from "../lib/time.ts";

const TEXT =
  "🔔 До 20:00 МСК ждём ваш #отчет в рабочем чате. Если сегодня нет анкет, отправьте 0. Выключить напоминания: /reminders";

export async function runReminders(): Promise<{ delivered: number; candidates: number }> {
  const now = nowLocal();
  const day = toDay(now);
  const dow = now.getUTCDay();
  if (dow === 5 || dow === 6) {
    console.log("No reminders on Friday/Saturday");
    return { delivered: 0, candidates: 0 };
  }
  const candidates = await db`
    SELECT e.uid FROM employees e
    WHERE e.can_dm = TRUE AND e.reminders = TRUE
      AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.chat = ${config.groupId} AND r.uid = e.uid AND r.day = ${day})
      AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.uid = e.uid AND d.day = ${day})`;
  let delivered = 0;
  for (const c of candidates) {
    const result = (await send(Number(c.uid), TEXT)) as { ok: boolean };
    if (result.ok) {
      await db`INSERT INTO reminder_deliveries(uid, day) VALUES(${c.uid}, ${day}) ON CONFLICT DO NOTHING`;
      delivered++;
    }
  }
  console.log("reminders delivered", delivered, "of", candidates.length);
  return { delivered, candidates: candidates.length };
}

if (import.meta.main) {
  await runReminders();
  process.exit(0);
}
