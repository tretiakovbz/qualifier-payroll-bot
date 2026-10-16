// Оклад: сколько положено сотруднику за расчётный период.
//  • Размер в месяц — общий для роли (настройки) или свой у сотрудника.
//  • За период начисляется половина месячного оклада (две выплаты в месяц).
//  • Если первый рабочий день внутри периода — сумма пропорциональна рабочим дням недели из настроек.
//  • Админ может вписать сумму за любой период вручную — она главнее расчёта.
// Начисление оклада за период одно; при изменении старое отменяется и создаётся новое (история видна).

import { db } from "../db/client.ts";
import { audit } from "../db/audit.ts";
import { addDays, humanDay, parseDay, periodOf, periodBack, payoutDayOf, humanRange, today, type Period, type WeekConfig } from "../lib/time.ts";
import type { Role } from "../lib/report.ts";
import { getSettings, type Settings } from "./settings.ts";
import { createAccrual, dayStr } from "./accruals.ts";

/** Рабочий ли день по настройкам недели (например, вс–чт) */
export function isWorkDay(day: string, w: WeekConfig): boolean {
  const dow = parseDay(day).getUTCDay();
  return (dow - w.startDow + 7) % 7 < w.days;
}

/** Сколько рабочих дней в отрезке [from, to] включительно */
export function workDaysIn(from: string, to: string, w: WeekConfig): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkDay(d, w)) n++;
  return n;
}

export interface SalaryCalc {
  /** Половина месячного оклада — полный период */
  full: number;
  /** Сумма с учётом первого рабочего дня */
  amount: number;
  /** Неполный период: отработано рабочих дней из всего рабочих дней периода */
  prorated: { from: string; worked: number; total: number } | null;
  /** Человек начал работать после окончания периода */
  notStarted: boolean;
}

/** Расчёт оклада за период без базы — чистая функция */
export function calcSalary(monthly: number, period: Period, week: WeekConfig, workStart: string | null): SalaryCalc {
  const full = Math.max(0, Math.round(monthly / 2));
  if (workStart && workStart > period[1]) return { full, amount: 0, prorated: null, notStarted: true };
  if (workStart && workStart > period[0]) {
    const total = workDaysIn(period[0], period[1], week);
    const worked = workDaysIn(workStart, period[1], week);
    const amount = total > 0 ? Math.round((full * worked) / total) : 0;
    return { full, amount, prorated: { from: workStart, worked, total }, notStarted: false };
  }
  return { full, amount: full, prorated: null, notStarted: false };
}

export interface SalaryPlan {
  period: Period;
  /** Месячный оклад, по которому считается */
  monthly: number;
  calc: SalaryCalc;
  override: { amount: number; comment: string | null } | null;
  /** Итог к начислению */
  amount: number;
  comment: string;
  /** Период не участвует: до старта системы, человек не в команде и т. п. */
  skip: boolean;
}

type EmployeeRow = { uid: number; role: Role | null; status: string; salary_monthly: number | null; work_start: unknown; approved_at: unknown };

async function employee(uid: number): Promise<EmployeeRow | null> {
  const rows = await db`SELECT uid, role, status, salary_monthly, work_start, approved_at FROM employees WHERE uid = ${uid}`;
  return (rows[0] as EmployeeRow) ?? null;
}

export function monthlyOf(e: Pick<EmployeeRow, "role" | "salary_monthly">, s: Settings): number {
  if (e.salary_monthly !== null && e.salary_monthly !== undefined) return Number(e.salary_monthly);
  if (!e.role) return 0;
  const cfg = s.salary[e.role];
  return cfg.enabled ? cfg.monthly : 0;
}

export function workStartOf(e: Pick<EmployeeRow, "work_start">): string | null {
  return e.work_start ? dayStr(e.work_start) : null;
}

export async function planSalary(uid: number, period: Period, s?: Settings, e?: EmployeeRow | null): Promise<SalaryPlan> {
  s = s ?? (await getSettings());
  e = e === undefined ? await employee(uid) : e;
  const ov = await db`SELECT amount, comment FROM salary_overrides WHERE uid = ${uid} AND period_start = ${period[0]}`;
  const override = ov[0] ? { amount: Number(ov[0].amount), comment: ov[0].comment ?? null } : null;
  const monthly = e ? monthlyOf(e, s) : 0;
  const start = e ? workStartOf(e) : null;
  const calc = calcSalary(monthly, period, s.week, start);
  // Одобрен после окончания периода — оклад за него не положен (как и раньше)
  const approvedAfter = e?.approved_at ? new Date(e.approved_at as string).toISOString().slice(0, 10) > period[1] && !start : false;
  const skip = !e || e.status !== "active" || !e.role || period[1] < s.startDate || approvedAfter;

  if (override) {
    return { period, monthly, calc, override, amount: override.amount, comment: override.comment || "оклад за период", skip: !e || period[1] < s.startDate };
  }
  const comment = calc.prorated
    ? `оклад с ${humanDay(calc.prorated.from)}: ${calc.prorated.worked} из ${calc.prorated.total} раб. дней`
    : "оклад, половина месяца";
  return { period, monthly, calc, override: null, amount: skip ? 0 : calc.amount, comment, skip };
}

/**
 * Привести начисление оклада за период к расчёту. Возвращает, что сделано.
 * Пропущенные периоды (до старта, не в команде) не трогаем, если только нет ручной суммы.
 */
export async function syncSalary(uid: number, period: Period, s?: Settings): Promise<"created" | "updated" | "cancelled" | "same" | "skipped"> {
  s = s ?? (await getSettings());
  const plan = await planSalary(uid, period, s);
  if (plan.skip) return "skipped";
  const key = `salary:${uid}:${period[0]}`;
  const cur = (await db`SELECT id, amount, comment FROM accruals WHERE dedupe_key = ${key} AND cancelled_at IS NULL`)[0];
  if (cur && Number(cur.amount) === plan.amount && cur.comment === plan.comment) return "same";
  if (!cur && plan.amount <= 0) return "same";
  if (cur) await db`UPDATE accruals SET cancelled_at = now() WHERE id = ${cur.id}`;
  if (plan.amount <= 0) return "cancelled";
  const start = plan.calc.prorated?.from;
  let day = period[0] < s.startDate ? s.startDate : period[0];
  if (start && start > day) day = start;
  await createAccrual({ uid, kind: "salary", amount: plan.amount, day, dedupeKey: key, comment: plan.comment });
  return cur ? "updated" : "created";
}

/** Начислить/обновить оклад за текущий расчётный период всем действующим сотрудникам */
export async function ensureSalary(day = today()): Promise<number> {
  const s = await getSettings();
  const period = periodOf(day, s.payoutDays);
  if (period[1] < s.startDate) return 0;
  const staff = await db`SELECT uid FROM employees WHERE status = 'active' AND role IS NOT NULL`;
  let count = 0;
  for (const e of staff) {
    const r = await syncSalary(Number(e.uid), period, s);
    if (r === "created" || r === "updated") count++;
  }
  return count;
}

/** Периоды для экрана оклада: следующий, текущий и несколько прошлых */
export function salaryPeriods(s: Settings, back = 4, day = today()): Period[] {
  const cur = periodOf(day, s.payoutDays);
  const next = periodOf(addDays(cur[1], 1), s.payoutDays);
  const list: Period[] = [next, cur];
  for (let i = 1; i <= back; i++) list.push(periodBack(i, day, s.payoutDays));
  return list.filter((p) => p[1] >= s.startDate);
}

export async function salaryOverview(uid: number) {
  const s = await getSettings();
  const e = await employee(uid);
  if (!e) return null;
  const cur = periodOf(today(), s.payoutDays);
  const periods = [];
  for (const p of salaryPeriods(s)) {
    const plan = await planSalary(uid, p, s, e);
    const acc = (await db`SELECT COALESCE(SUM(amount), 0)::int AS sum FROM accruals
      WHERE uid = ${uid} AND kind = 'salary' AND period_start = ${p[0]} AND cancelled_at IS NULL`)[0];
    const paid = (await db`SELECT amount FROM payments WHERE uid = ${uid} AND period = ${p[0]}`)[0];
    periods.push({
      period: p, label: humanRange(p), payoutDay: payoutDayOf(p),
      when: p[0] > cur[0] ? "next" : p[0] === cur[0] ? "current" : "past",
      auto: plan.calc.amount, full: plan.calc.full, prorated: plan.calc.prorated, notStarted: plan.calc.notStarted,
      override: plan.override, amount: plan.skip && !plan.override ? 0 : plan.amount, comment: plan.comment,
      accrued: acc.sum, paid: paid ? Number(paid.amount) : null,
    });
  }
  const role = e.role as Role | null;
  return {
    uid, role, status: e.status,
    monthly: monthlyOf(e, s),
    individual: e.salary_monthly !== null && e.salary_monthly !== undefined ? Number(e.salary_monthly) : null,
    roleMonthly: role ? s.salary[role].monthly : 0,
    roleEnabled: role ? s.salary[role].enabled : false,
    workStart: workStartOf(e),
    week: s.week,
    periods,
  };
}

export class SalaryError extends Error {}

/** Пересчитать затронутые периоды: текущий и прошлые невыплаченные */
async function resync(uid: number, s: Settings) {
  for (const p of salaryPeriods(s)) {
    if (p[0] > periodOf(today(), s.payoutDays)[0]) continue; // будущий начислится в свой срок
    const paid = await db`SELECT 1 FROM payments WHERE uid = ${uid} AND period = ${p[0]}`;
    if (paid.length) continue;
    await syncSalary(uid, p, s);
  }
}

/** Свой месячный оклад (null — как у роли) и первый рабочий день (null — не учитывать) */
export async function setSalaryProfile(uid: number, patch: { monthly?: number | null; workStart?: string | null }, actor: number) {
  const s = await getSettings();
  if (patch.monthly !== undefined && patch.monthly !== null) {
    if (!Number.isFinite(patch.monthly) || patch.monthly < 0 || patch.monthly > 10_000_000) throw new SalaryError("Оклад — число от 0 до 10 000 000");
    patch.monthly = Math.round(patch.monthly);
  }
  if (patch.workStart !== undefined && patch.workStart !== null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.workStart)) throw new SalaryError("Дата в формате ГГГГ-ММ-ДД");
  if (patch.monthly !== undefined) await db`UPDATE employees SET salary_monthly = ${patch.monthly} WHERE uid = ${uid}`;
  if (patch.workStart !== undefined) await db`UPDATE employees SET work_start = ${patch.workStart} WHERE uid = ${uid}`;
  await audit(actor, "salary.profile", { uid, ...patch });
  await resync(uid, s);
  return salaryOverview(uid);
}

/** Ручная сумма оклада за период (null — вернуть расчёт) */
export async function setSalaryOverride(uid: number, periodStart: string, amount: number | null, comment: string | null, actor: number) {
  const s = await getSettings();
  const period = periodOf(periodStart, s.payoutDays);
  if (period[0] !== periodStart) throw new SalaryError("Неверный период");
  if (amount === null) {
    await db`DELETE FROM salary_overrides WHERE uid = ${uid} AND period_start = ${period[0]}`;
  } else {
    if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) throw new SalaryError("Сумма — число от 0 до 10 000 000");
    const c = (comment ?? "").trim().slice(0, 120) || null;
    await db`INSERT INTO salary_overrides(uid, period_start, amount, comment, set_by) VALUES(${uid}, ${period[0]}, ${Math.round(amount)}, ${c}, ${actor})
      ON CONFLICT(uid, period_start) DO UPDATE SET amount = excluded.amount, comment = excluded.comment, set_by = excluded.set_by, set_at = now()`;
  }
  await audit(actor, "salary.override", { uid, period: period[0], amount, comment });
  // Будущий период начислится сам, когда наступит; текущий и прошлые — сразу
  if (period[0] <= periodOf(today(), s.payoutDays)[0]) await syncSalary(uid, period, s);
  return salaryOverview(uid);
}
