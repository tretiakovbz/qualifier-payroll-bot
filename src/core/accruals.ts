// Журнал начислений и баланс.
// Источник правды для денег за отчёты — статус отчёта: подтверждён → есть начисление,
// снят/отклонён/изменён → начисление отменяется. Сверка идемпотентна и запускается
// сразу после подтверждения и по расписанию.

import { db } from "../db/client.ts";
import { config } from "../config.ts";
import { audit } from "../db/audit.ts";
import { periodOf, today, addDays, type Period } from "../lib/time.ts";
import { reportAmount, type ReportMetrics, type Role } from "../lib/report.ts";
import { getSettings } from "./settings.ts";
import { listDirections } from "./directions.ts";
import { notify } from "./notify.ts";
import { applyMultipliers } from "./promos.ts";

export type AccrualKind = "form" | "contract" | "salary" | "bonus" | "manual" | "promo";

export interface Accrual {
  id: number;
  uid: number;
  kind: AccrualKind;
  amount: number;
  period_start: string;
  day: string;
  dedupe_key: string | null;
  rule_id: number | null;
  comment: string | null;
  created_by: number | null;
  created_at: string;
  cancelled_at: string | null;
}

/** DATE из базы → YYYY-MM-DD */
export function dayStr(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  return (v as Date).toISOString().slice(0, 10);
}

const rub = (n: number) => n.toLocaleString("ru-RU") + " ₽";

export async function createAccrual(a: {
  uid: number;
  kind: AccrualKind;
  amount: number;
  day: string;
  dedupeKey?: string;
  ruleId?: number;
  report?: { chat: number; msg: number };
  comment?: string;
  createdBy?: number;
}): Promise<Accrual | null> {
  const s = await getSettings();
  const [periodStart] = periodOf(a.day, s.payoutDays);
  const rows = await db`
    INSERT INTO accruals(uid, kind, amount, period_start, day, dedupe_key, rule_id, report_chat, report_msg, comment, created_by)
    VALUES(${a.uid}, ${a.kind}, ${Math.round(a.amount)}, ${periodStart}, ${a.day}, ${a.dedupeKey ?? null},
      ${a.ruleId ?? null}, ${a.report?.chat ?? null}, ${a.report?.msg ?? null}, ${a.comment ?? null}, ${a.createdBy ?? null})
    ON CONFLICT (dedupe_key) WHERE cancelled_at IS NULL DO NOTHING
    RETURNING *`;
  return rows[0] ?? null;
}

export async function cancelAccrual(id: number, actor: number): Promise<Accrual | null> {
  const rows = await db`UPDATE accruals SET cancelled_at = now(), cancelled_by = ${actor}
    WHERE id = ${id} AND cancelled_at IS NULL RETURNING *`;
  if (rows[0]) await audit(actor, "accrual.cancel", { id, uid: rows[0].uid, amount: rows[0].amount });
  return rows[0] ?? null;
}

/** Метрики отчёта; у отчётов v1 метрик нет — берём число анкет из колонки n */
export function metricsOf(r: { metrics: ReportMetrics | null; n: number; role: string }): ReportMetrics {
  const m = r.metrics && Object.keys(r.metrics).length ? r.metrics : null;
  if (m) return m;
  return r.role === "recruiter" ? {} : { forms: r.n };
}

/** Сверить начисления по отчётам со статусами. Возвращает число созданных и отменённых. */
export async function reconcileReports(opts: { notifyRecentDays?: number } = {}): Promise<{ created: number; cancelled: number }> {
  const notifyDays = opts.notifyRecentDays ?? 3;
  const cancelled = await db`
    UPDATE accruals a SET cancelled_at = now()
    FROM reports r
    WHERE a.cancelled_at IS NULL AND a.report_chat = r.chat AND a.report_msg = r.msg
      AND (a.dedupe_key LIKE 'report:%' OR a.dedupe_key LIKE 'promo:%:report:%') AND r.status <> 'approved'
    RETURNING a.uid, a.amount, r.status`;

  const pending = await db`
    SELECT r.* FROM reports r
    WHERE r.chat = ${config.groupId} AND r.status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM accruals a
        WHERE a.dedupe_key = 'report:' || r.chat || ':' || r.msg AND a.cancelled_at IS NULL
      )
    ORDER BY r.day`;

  let created = 0;
  if (pending.length) {
    const s = await getSettings();
    const directions = await listDirections(true);
    const since = addDays(today(), -notifyDays);
    for (const r of pending) {
      const role = (r.role ?? "qualifier") as Role;
      const metrics = metricsOf(r);
      const amount = reportAmount(role, metrics, s.rates, directions);
      const day = dayStr(r.day);
      const acc = await createAccrual({
        uid: Number(r.uid),
        kind: role === "recruiter" ? "contract" : "form",
        amount,
        day,
        dedupeKey: `report:${r.chat}:${r.msg}`,
        report: { chat: Number(r.chat), msg: Number(r.msg) },
        comment: role === "recruiter" ? `контрактов: ${metrics.contracts ?? 0}` : `анкет: ${metrics.forms ?? 0}`,
      });
      if (!acc) continue;
      created++;
      // Акции-множители («анкета ×2 в пятницу») — отдельным начислением, снимается вместе с отчётом
      const extra = amount > 0 ? await applyMultipliers({ uid: Number(r.uid), role, day, base: amount, chat: Number(r.chat), msg: Number(r.msg) }) : 0;
      if (day >= since && amount > 0) {
        await notify(acc.uid, {
          kind: "approved",
          title: `Отчёт подтверждён: +${rub(amount + extra)}`,
          body: role === "recruiter" ? `Контракты засчитаны, сумма уже на балансе` : `Анкеты засчитаны, сумма уже на балансе`,
          amount,
        });
      }
    }
  }
  // Достижения пересчитываются у тех, кому что-то начислили
  if (created) {
    const { checkAchievements } = await import("./achievements.ts");
    const touched = new Map<number, Role>();
    for (const r of pending) touched.set(Number(r.uid), (r.role ?? "qualifier") as Role);
    for (const [uid, role] of touched) {
      const e = await db`SELECT status, role FROM employees WHERE uid = ${uid}`;
      if (e[0]?.status === "active" && e[0]?.role === role) await checkAchievements(uid, role).catch((err) => console.error("[achievements]", err));
    }
  }
  return { created, cancelled: cancelled.length };
}

/** Начислить оклад за текущий расчётный период действующим сотрудникам */
export async function ensureSalary(day = today()): Promise<number> {
  const s = await getSettings();
  const period = periodOf(day, s.payoutDays);
  if (period[1] < s.startDate) return 0;
  let count = 0;
  for (const role of ["qualifier", "recruiter"] as const) {
    const cfg = s.salary[role];
    if (!cfg.enabled || cfg.monthly <= 0) continue;
    // Оклад делится пополам между двумя выплатами месяца
    const amount = Math.round(cfg.monthly / 2);
    const staff = await db`SELECT uid FROM employees WHERE status = 'active' AND role = ${role}
      AND (approved_at IS NULL OR approved_at::date <= ${period[1]})`;
    for (const e of staff) {
      const acc = await createAccrual({
        uid: Number(e.uid),
        kind: "salary",
        amount,
        day: period[0] < s.startDate ? s.startDate : period[0],
        dedupeKey: `salary:${e.uid}:${period[0]}`,
        comment: "оклад, половина месяца",
      });
      if (acc) count++;
    }
  }
  return count;
}

/** Ручное начисление админом (разовый бонус или бонус из списка) */
export async function manualAccrual(a: {
  uid: number;
  amount: number;
  comment: string;
  ruleId?: number;
  actor: number;
  day?: string;
}): Promise<Accrual> {
  if (!Number.isFinite(a.amount) || a.amount === 0) throw new Error("Укажите сумму");
  const acc = await createAccrual({
    uid: a.uid,
    kind: a.ruleId ? "bonus" : "manual",
    amount: a.amount,
    day: a.day ?? today(),
    ruleId: a.ruleId,
    comment: a.comment,
    createdBy: a.actor,
  });
  await audit(a.actor, "accrual.manual", { uid: a.uid, amount: a.amount, comment: a.comment, ruleId: a.ruleId });
  await notify(a.uid, { kind: "bonus", title: `Начислен бонус: +${rub(a.amount)}`, body: a.comment, amount: a.amount });
  return acc!;
}

export interface Balance {
  period: Period;
  accrued: number;
  byKind: Record<string, number>;
  paid: number | null;
  balance: number;
}

export async function balanceOf(uid: number, period: Period): Promise<Balance> {
  const rows = await db`SELECT kind, COALESCE(SUM(amount), 0)::int AS sum FROM accruals
    WHERE uid = ${uid} AND period_start = ${period[0]} AND cancelled_at IS NULL GROUP BY kind`;
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = r.sum;
  const accrued = Object.values(byKind).reduce((s, n) => s + n, 0);
  const paidRows = await db`SELECT amount FROM payments WHERE uid = ${uid} AND period = ${period[0]}`;
  const paid = paidRows.length ? paidRows[0].amount : null;
  return { period, accrued, byKind, paid, balance: accrued - (paid ?? 0) };
}

export async function recentAccruals(uid: number, limit = 20): Promise<Accrual[]> {
  return db`SELECT * FROM accruals WHERE uid = ${uid} AND cancelled_at IS NULL AND amount <> 0
    ORDER BY day DESC, id DESC LIMIT ${limit}`;
}

/** Ведомость за период: все с начислениями */
export async function payroll(period: Period) {
  return db`
    SELECT e.uid, COALESCE(e.full_name, e.name) AS name, e.role,
      COALESCE(SUM(a.amount) FILTER (WHERE a.kind = 'salary'), 0)::int AS salary,
      COALESCE(SUM(a.amount) FILTER (WHERE a.kind IN ('form','contract')), 0)::int AS work,
      COALESCE(SUM(a.amount) FILTER (WHERE a.kind IN ('bonus','manual','promo')), 0)::int AS bonus,
      COALESCE(SUM(a.amount), 0)::int AS total,
      p.amount AS paid
    FROM accruals a
    JOIN employees e ON e.uid = a.uid
    LEFT JOIN payments p ON p.uid = a.uid AND p.period = ${period[0]}
    WHERE a.period_start = ${period[0]} AND a.cancelled_at IS NULL
    GROUP BY e.uid, e.full_name, e.name, e.role, p.amount
    ORDER BY e.role, total DESC`;
}

export async function markPaid(uid: number, period: Period, actor: number, amount?: number) {
  const b = await balanceOf(uid, period);
  const sum = amount ?? b.accrued;
  await db.begin(async (tx) => {
    await tx`INSERT INTO payments(uid, period, amount) VALUES(${uid}, ${period[0]}, ${sum})
      ON CONFLICT(uid, period) DO UPDATE SET amount = excluded.amount, paid_at = now()`;
    await tx`INSERT INTO payment_audit(uid, period, actor, amount) VALUES(${uid}, ${period[0]}, ${actor}, ${sum})
      ON CONFLICT(uid, period) DO UPDATE SET amount = excluded.amount, actor = excluded.actor, marked_at = now()`;
  });
  await audit(actor, "payout.mark", { uid, period: period[0], amount: sum });
  await notify(uid, { kind: "payout", title: `Выплата отмечена: ${rub(sum)}`, body: "Спасибо за работу!", amount: sum });
  return sum;
}
