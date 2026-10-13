// Фоновые задачи: сверка начислений, оклад, итоги бонусов, напоминания.
// Каждая задача идемпотентна — повторный запуск ничего не задвоит.

import { db } from "../db/client.ts";
import { config } from "../config.ts";
import { nowLocal, today } from "../lib/time.ts";
import { reconcileReports, ensureSalary } from "./accruals.ts";
import { runDueBonuses } from "./bonuses.ts";
import { getSettings } from "./settings.ts";
import { dm } from "./notify.ts";

const REMINDER_TEXT = "🔔 Ждём ваш #отчет в рабочем чате до 20:00 МСК. Если сегодня без результатов — отправьте нули. Напоминания настраиваются в профиле.";

let running = false;
let lastHeavy = 0;

export async function tick(nowMs = Date.now()) {
  if (running) return;
  running = true;
  try {
    // Тяжёлые задачи — раз в 5 минут
    if (nowMs - lastHeavy >= 5 * 60_000) {
      lastHeavy = nowMs;
      const rec = await reconcileReports();
      const salary = await ensureSalary(today(nowMs));
      const bonuses = await runDueBonuses(nowMs);
      if (rec.created || rec.cancelled || salary || bonuses.length) {
        console.log("[scheduler]", JSON.stringify({ rec, salary, bonuses }));
      }
    }
    await sendReminders(nowMs);
  } catch (e) {
    console.error("[scheduler]", e);
  } finally {
    running = false;
  }
}

/** Напоминание об отчёте тем, кто ещё не отчитался. Время — из профиля или общее из настроек. */
export async function sendReminders(nowMs = Date.now(), force = false): Promise<number> {
  // На тестовом сервисе не трогаем журнал доставок: им пользуется рабочий бот v1
  if (!config.liveMode && !force) return 0;
  const s = await getSettings();
  const now = nowLocal(nowMs);
  const day = today(nowMs);
  if (!s.reminders.days.includes(now.getUTCDay())) return 0;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const defaultTime = `${String(s.reminders.hour).padStart(2, "0")}:${String(s.reminders.minute).padStart(2, "0")}`;

  const candidates = await db`
    SELECT e.uid, COALESCE(e.prefs->>'reminderTime', ${defaultTime}) AS at
    FROM employees e
    WHERE e.status = 'active' AND e.role IS NOT NULL AND e.can_dm = TRUE AND e.reminders = TRUE
      AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.chat = ${config.groupId} AND r.uid = e.uid AND r.day = ${day})
      AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.uid = e.uid AND d.day = ${day})`;
  let sent = 0;
  for (const c of candidates) {
    const [h, m] = String(c.at).split(":").map(Number);
    const due = (h ?? 19) * 60 + (m ?? 30);
    // окно 30 минут после назначенного времени, чтобы не будить в полночь после простоя
    if (minutes < due || minutes > due + 30) continue;
    // помечаем доставку до отправки: при сбое лучше пропустить одно напоминание, чем прислать два
    const mark = await db`INSERT INTO reminder_deliveries(uid, day) VALUES(${c.uid}, ${day}) ON CONFLICT DO NOTHING RETURNING uid`;
    if (!mark.length) continue;
    if (await dm(Number(c.uid), REMINDER_TEXT, "reminder")) sent++;
  }
  return sent;
}

export function startScheduler() {
  if (!config.schedulerEnabled || !config.databaseUrl) return;
  setTimeout(() => tick(), 5_000);
  setInterval(() => tick(), 60_000);
  console.log(`[scheduler] started, live mode: ${config.liveMode ? "ON" : "off (сообщения не отправляются)"}`);
}
