// Бонусы: автоматические («лучший за неделю/месяц» с порогом и делением при ничьей)
// и ручные (админ отмечает галочками, например «без 5 задержек»).

import { db } from "../db/client.ts";
import { config } from "../config.ts";
import { audit } from "../db/audit.ts";
import { today, lastCompletedWeek, lastCompletedMonth, weekOf, monthOf, addDays, parseDay, nowLocal, humanRange, type Period } from "../lib/time.ts";
import type { Role } from "../lib/report.ts";
import { getSettings } from "./settings.ts";
import { createAccrual, cancelAccrual } from "./accruals.ts";
import { notify } from "./notify.ts";

export type Metric = "calls" | "forms" | "docs" | "vvk" | "contracts";

export interface BonusRule {
  id: number;
  code: string | null;
  name: string;
  role: Role;
  kind: "top_metric" | "manual";
  metric: Metric | null;
  period: "week" | "month";
  amount: number;
  threshold: number;
  enabled: boolean;
  split_ties: boolean;
  sort: number;
}

export const METRICS: Record<Role, Metric[]> = {
  qualifier: ["forms", "calls"],
  recruiter: ["contracts", "docs", "vvk"],
};

export const METRIC_LABEL: Record<Metric, string> = {
  calls: "Недозвоны",
  forms: "Анкеты",
  docs: "Документы",
  vvk: "ВВК",
  contracts: "Контракты",
};

const rub = (n: number) => n.toLocaleString("ru-RU") + " ₽";

export async function listRules(): Promise<BonusRule[]> {
  return db`SELECT * FROM bonus_rules ORDER BY sort, id`;
}

export async function getRule(id: number): Promise<BonusRule | null> {
  const rows = await db`SELECT * FROM bonus_rules WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function saveRule(r: Partial<BonusRule> & { name: string; role: Role; kind: BonusRule["kind"]; period: BonusRule["period"]; amount: number }, actor: number): Promise<BonusRule> {
  if (!r.name.trim()) throw new Error("Укажите название бонуса");
  if (!(r.amount >= 0)) throw new Error("Сумма не может быть отрицательной");
  if (r.kind === "top_metric" && (!r.metric || !METRICS[r.role].includes(r.metric))) throw new Error("Выберите показатель для этой роли");
  let row;
  if (r.id) {
    [row] = await db`UPDATE bonus_rules SET name = ${r.name}, role = ${r.role}, kind = ${r.kind}, metric = ${r.metric ?? null},
      period = ${r.period}, amount = ${r.amount}, threshold = ${r.threshold ?? 0}, enabled = ${r.enabled ?? true},
      split_ties = ${r.split_ties ?? true}, updated_at = now(), updated_by = ${actor}
      WHERE id = ${r.id} RETURNING *`;
  } else {
    [row] = await db`INSERT INTO bonus_rules(name, role, kind, metric, period, amount, threshold, enabled, split_ties, sort, updated_by)
      VALUES(${r.name}, ${r.role}, ${r.kind}, ${r.metric ?? null}, ${r.period}, ${r.amount}, ${r.threshold ?? 0},
        ${r.enabled ?? true}, ${r.split_ties ?? true}, ${r.sort ?? 100}, ${actor}) RETURNING *`;
  }
  await audit(actor, "bonus_rule.save", row);
  return row;
}

/** SQL-выражение показателя отчёта (только из белого списка). У отчётов v1 анкеты лежат в колонке n. */
const METRIC_SQL: Record<Metric, string> = {
  forms: "COALESCE((r.metrics->>'forms')::int, CASE WHEN r.metrics = '{}'::jsonb THEN r.n ELSE 0 END)",
  calls: "COALESCE((r.metrics->>'calls')::int, 0)",
  docs: "COALESCE((r.metrics->>'docs')::int, 0)",
  vvk: "COALESCE((r.metrics->>'vvk')::int, 0)",
  contracts: "COALESCE((r.metrics->>'contracts')::int, 0)",
};

export interface MetricRow {
  uid: number;
  name: string;
  value: number;
}

/** Итоги по показателю за период среди действующих сотрудников роли (по умолчанию только подтверждённые отчёты) */
export async function metricTotals(role: Role, metric: Metric, period: Period, opts: { includePending?: boolean } = {}): Promise<MetricRow[]> {
  const expr = METRIC_SQL[metric];
  if (!expr) throw new Error("Неизвестный показатель");
  const rows = await db.unsafe(
    `SELECT e.uid, COALESCE(e.full_name, e.name) AS name,
       COALESCE(SUM(${expr}) FILTER (WHERE r.msg IS NOT NULL), 0)::int AS value
     FROM employees e
     LEFT JOIN reports r ON r.uid = e.uid AND r.chat = $1 AND r.role = $2
       AND r.day BETWEEN $3::date AND $4::date
       AND (r.status = 'approved' OR ($5::boolean AND r.status = 'pending'))
     WHERE e.status = 'active' AND e.role = $2
     GROUP BY e.uid, e.full_name, e.name
     ORDER BY value DESC, name`,
    [config.groupId, role, period[0], period[1], Boolean(opts.includePending)],
  );
  return rows.map((r: any) => ({ uid: Number(r.uid), name: r.name, value: r.value }));
}

/** Победители: максимум не ниже порога (и больше нуля). Ничья — все с максимумом. */
export function pickWinners(rows: MetricRow[], threshold: number): MetricRow[] {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (max <= 0 || max < threshold) return [];
  return rows.filter((r) => r.value === max);
}

/** Сумма каждому: при делении — поровну с округлением вниз до рубля */
export function shareOf(amount: number, winners: number, split: boolean): number {
  if (winners === 0) return 0;
  return split ? Math.floor(amount / winners) : amount;
}

export function periodKey(rule: Pick<BonusRule, "period">, period: Period): string {
  return rule.period === "week" ? period[0] : period[0].slice(0, 7);
}

export function periodFromKey(rule: Pick<BonusRule, "period">, key: string, week = { startDow: 0, days: 5 }): Period {
  return rule.period === "week" ? weekOf(key, week) : monthOf(key + "-01");
}

/** Подвести итоги автоматического бонуса за период (один раз) */
export async function evaluateRule(rule: BonusRule, period: Period): Promise<{ key: string; winners: { uid: number; name: string; value: number; amount: number }[]; skipped?: boolean }> {
  const key = periodKey(rule, period);
  const done = await db`SELECT winners FROM bonus_runs WHERE rule_id = ${rule.id} AND period_key = ${key}`;
  if (done.length) return { key, winners: done[0].winners, skipped: true };

  const rows = await metricTotals(rule.role, rule.metric!, period);
  const winners = pickWinners(rows, rule.threshold);
  const share = shareOf(rule.amount, winners.length, rule.split_ties);
  const result = [];
  for (const w of winners) {
    const acc = await createAccrual({
      uid: w.uid,
      kind: "bonus",
      amount: share,
      day: period[1],
      ruleId: rule.id,
      dedupeKey: `bonus:${rule.id}:${key}:${w.uid}`,
      comment: `${rule.name}, ${humanRange(period)}${winners.length > 1 ? `, поделён на ${winners.length}` : ""}`,
    });
    result.push({ ...w, amount: share });
    if (acc) {
      await notify(w.uid, {
        kind: "bonus",
        title: `Поздравляем! ${rule.name}: +${rub(share)}`,
        body: winners.length > 1 ? `Результат ${w.value} — делите первое место с коллегами` : `Ваш результат ${w.value} — лучший в команде`,
        amount: share,
      });
    }
  }
  await db`INSERT INTO bonus_runs(rule_id, period_key, winners) VALUES(${rule.id}, ${key}, ${JSON.stringify(result)}::text::jsonb)
    ON CONFLICT DO NOTHING`;
  return { key, winners: result };
}

/** Какие автоматические бонусы пора подвести на этот момент */
export async function runDueBonuses(nowMs = Date.now()): Promise<{ rule: string; key: string; winners: number }[]> {
  const s = await getSettings();
  const now = nowLocal(nowMs);
  const day = today(nowMs);
  const hour = now.getUTCHours();
  const out = [];
  for (const rule of await listRules()) {
    if (!rule.enabled || rule.kind !== "top_metric" || !rule.metric) continue;
    let period: Period;
    let resultsDay: string;
    if (rule.period === "week") {
      period = lastCompletedWeek(day, s.week);
      // первый день с нужным днём недели после окончания недели
      resultsDay = addDays(period[1], 1);
      while (parseDay(resultsDay).getUTCDay() !== s.week.resultsDow) resultsDay = addDays(resultsDay, 1);
    } else {
      period = lastCompletedMonth(day);
      resultsDay = addDays(period[1], 1);
    }
    if (period[1] < s.startDate) continue;
    if (day < resultsDay || (day === resultsDay && hour < s.week.resultsHour)) continue;
    // не подводим итоги старше двух периодов — только свежие
    if (day > addDays(resultsDay, rule.period === "week" ? 14 : 45)) continue;
    const r = await evaluateRule(rule, period);
    if (!r.skipped) out.push({ rule: rule.name, key: r.key, winners: r.winners.length });
  }
  return out;
}

/** Ручной бонус: кандидаты за период и кто уже отмечен */
export async function manualCandidates(rule: BonusRule, key: string) {
  const s = await getSettings();
  const period = periodFromKey(rule, key, s.week);
  const staff = await db`
    SELECT e.uid, COALESCE(e.full_name, e.name) AS name, e.photo_url,
      a.id AS accrual_id, a.amount AS awarded
    FROM employees e
    LEFT JOIN accruals a ON a.uid = e.uid AND a.cancelled_at IS NULL AND a.dedupe_key = ${"bonus:" + rule.id + ":" + key + ":"} || e.uid
    WHERE e.status = 'active' AND e.role = ${rule.role}
    ORDER BY name`;
  return { rule, key, period, staff: staff.map((r: any) => ({ ...r, uid: Number(r.uid), awarded: r.awarded ?? null })) };
}

/** Отметить/снять ручной бонус у сотрудника */
export async function setManualAward(rule: BonusRule, key: string, uid: number, award: boolean, actor: number, amount?: number) {
  const s = await getSettings();
  const period = periodFromKey(rule, key, s.week);
  const dedupe = `bonus:${rule.id}:${key}:${uid}`;
  if (award) {
    const sum = amount ?? rule.amount;
    const acc = await createAccrual({
      uid,
      kind: "bonus",
      amount: sum,
      day: period[1] < today() ? period[1] : today(),
      ruleId: rule.id,
      dedupeKey: dedupe,
      comment: `${rule.name}, ${humanRange(period)}`,
      createdBy: actor,
    });
    if (acc) {
      await audit(actor, "bonus.manual.award", { rule: rule.id, key, uid, amount: sum });
      await notify(uid, { kind: "bonus", title: `${rule.name}: +${rub(sum)}`, body: "Отличная работа на этой неделе!", amount: sum });
    }
    return acc;
  }
  const rows = await db`SELECT id FROM accruals WHERE dedupe_key = ${dedupe} AND cancelled_at IS NULL`;
  if (rows[0]) await cancelAccrual(rows[0].id, actor);
  return null;
}

/** Прогресс до порога автоматического бонуса текущего периода — для «осталось N до бонуса» */
export async function bonusProgress(uid: number, role: Role, day = today()) {
  const s = await getSettings();
  const out = [];
  for (const rule of await listRules()) {
    if (!rule.enabled || rule.kind !== "top_metric" || rule.role !== role || !rule.metric) continue;
    const period = rule.period === "week" ? weekOf(day, s.week) : monthOf(day);
    const rows = await metricTotals(role, rule.metric, period, { includePending: true });
    const me = rows.find((r) => r.uid === Number(uid))?.value ?? 0;
    const leader = rows[0]?.value ?? 0;
    out.push({
      ruleId: rule.id,
      name: rule.name,
      amount: rule.amount,
      metric: rule.metric,
      threshold: rule.threshold,
      period,
      value: me,
      leader,
      toThreshold: Math.max(0, rule.threshold - me),
      isLeader: me > 0 && me === leader,
    });
  }
  return out;
}
