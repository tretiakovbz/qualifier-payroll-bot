// Достижения и личные рекорды. Считаются по подтверждённым отчётам и начислениям.
// Полученное достижение запоминается навсегда и один раз приходит праздничным уведомлением в приложении.

import { db } from "../db/client.ts";
import { config } from "../config.ts";
import { today, addDays, weekOf, monthOf, humanRange, humanDay, type WeekConfig } from "../lib/time.ts";
import type { Role } from "../lib/report.ts";
import { getSettings } from "./settings.ts";
import { notify } from "./notify.ts";

export interface Stats {
  reports: number;
  forms: number;
  calls: number;
  contracts: number;
  docs: number;
  vvk: number;
  bestDayForms: number;
  bestWeekForms: number;
  bestMonthContracts: number;
  streak: number;
  bestStreak: number;
  bonuses: number;
  topWins: number;
}

export type Tier = "bronze" | "silver" | "gold";

export interface AchievementDef {
  code: string;
  role: Role | "all";
  title: string;
  desc: string;
  icon: string;
  tier: Tier;
  target: number;
  value: (s: Stats) => number;
}

export const DEFS: AchievementDef[] = [
  { code: "first_report", role: "all", title: "Первый отчёт", desc: "Сдать первый отчёт", icon: "doc", tier: "bronze", target: 1, value: (s) => s.reports },
  { code: "streak_5", role: "all", title: "Неделя без пропусков", desc: "5 рабочих дней подряд с отчётом", icon: "flame", tier: "bronze", target: 5, value: (s) => s.bestStreak },
  { code: "streak_20", role: "all", title: "Месяц без пропусков", desc: "20 рабочих дней подряд с отчётом", icon: "flame", tier: "gold", target: 20, value: (s) => s.bestStreak },
  { code: "first_bonus", role: "all", title: "Первый бонус", desc: "Получить любой бонус или приз по акции", icon: "gift", tier: "bronze", target: 1, value: (s) => s.bonuses },
  { code: "champion", role: "all", title: "Лучший в команде", desc: "Выиграть бонус за первое место", icon: "trophy", tier: "silver", target: 1, value: (s) => s.topWins },
  { code: "champion_3", role: "all", title: "Трижды лучший", desc: "Выиграть первое место три раза", icon: "trophy", tier: "gold", target: 3, value: (s) => s.topWins },

  { code: "forms_100", role: "qualifier", title: "Сотня анкет", desc: "100 подтверждённых анкет", icon: "medal", tier: "bronze", target: 100, value: (s) => s.forms },
  { code: "forms_500", role: "qualifier", title: "500 анкет", desc: "500 подтверждённых анкет", icon: "medal", tier: "silver", target: 500, value: (s) => s.forms },
  { code: "forms_1000", role: "qualifier", title: "Тысячник", desc: "1000 подтверждённых анкет", icon: "medal", tier: "gold", target: 1000, value: (s) => s.forms },
  { code: "day_10", role: "qualifier", title: "10 за день", desc: "10 анкет за один день", icon: "star", tier: "silver", target: 10, value: (s) => s.bestDayForms },
  { code: "week_30", role: "qualifier", title: "30 за неделю", desc: "30 анкет за рабочую неделю", icon: "star", tier: "gold", target: 30, value: (s) => s.bestWeekForms },
  { code: "calls_1000", role: "qualifier", title: "1000 недозвонов", desc: "Обработать 1000 недозвонов", icon: "phone", tier: "silver", target: 1000, value: (s) => s.calls },

  { code: "contract_1", role: "recruiter", title: "Первый контракт", desc: "Закрыть первый контракт", icon: "medal", tier: "bronze", target: 1, value: (s) => s.contracts },
  { code: "contracts_10", role: "recruiter", title: "10 контрактов", desc: "10 подтверждённых контрактов", icon: "medal", tier: "silver", target: 10, value: (s) => s.contracts },
  { code: "contracts_50", role: "recruiter", title: "50 контрактов", desc: "50 подтверждённых контрактов", icon: "medal", tier: "gold", target: 50, value: (s) => s.contracts },
  { code: "month_5", role: "recruiter", title: "5 за месяц", desc: "5 контрактов за календарный месяц", icon: "star", tier: "gold", target: 5, value: (s) => s.bestMonthContracts },
  { code: "docs_100", role: "recruiter", title: "100 пакетов документов", desc: "Получить документы от 100 кандидатов", icon: "doc", tier: "silver", target: 100, value: (s) => s.docs },
  { code: "vvk_50", role: "recruiter", title: "50 на ВВК", desc: "Отправить 50 кандидатов на ВВК", icon: "check", tier: "silver", target: 50, value: (s) => s.vvk },
];

export function defsFor(role: Role): AchievementDef[] {
  return DEFS.filter((d) => d.role === "all" || d.role === role);
}

/** Какие достижения выполнены при таких показателях (чистая функция) */
export function evaluate(role: Role, s: Stats) {
  return defsFor(role).map((d) => {
    const value = d.value(s);
    return { code: d.code, title: d.title, desc: d.desc, icon: d.icon, tier: d.tier, target: d.target, value: Math.min(value, d.target), done: value >= d.target };
  });
}

/** Самая длинная серия рабочих дней подряд в наборе дней с отчётами, и текущая серия */
export function streaks(days: string[], todayDay: string, w: WeekConfig): { current: number; best: number } {
  const have = new Set(days);
  const workday = (d: string) => (new Date(d + "T00:00:00Z").getUTCDay() - w.startDow + 7) % 7 < w.days;
  // текущая: назад от сегодня (или вчера, если сегодня ещё не отчитался)
  let d = have.has(todayDay) ? todayDay : addDays(todayDay, -1);
  let current = 0;
  for (let i = 0; i < 400; i++, d = addDays(d, -1)) {
    if (!workday(d)) continue;
    if (!have.has(d)) break;
    current++;
  }
  // лучшая: проход по всем рабочим дням от первого отчёта
  const sorted = [...have].sort();
  let best = 0, run = 0;
  if (sorted.length) {
    for (let x = sorted[0]; x <= todayDay; x = addDays(x, 1)) {
      if (!workday(x)) continue;
      if (have.has(x)) best = Math.max(best, ++run);
      else run = 0;
    }
  }
  return { current, best: Math.max(best, current) };
}

export async function statsOf(uid: number, role: Role): Promise<{ stats: Stats; daily: { day: string; forms: number; calls: number; contracts: number }[] }> {
  const s = await getSettings();
  const daily = (await db`
    SELECT day::text AS day,
      SUM(COALESCE((metrics->>'forms')::int, CASE WHEN metrics = '{}'::jsonb THEN n ELSE 0 END))::int AS forms,
      SUM(COALESCE((metrics->>'calls')::int, 0))::int AS calls,
      SUM(COALESCE((metrics->>'contracts')::int, 0))::int AS contracts,
      SUM(COALESCE((metrics->>'docs')::int, 0))::int AS docs,
      SUM(COALESCE((metrics->>'vvk')::int, 0))::int AS vvk,
      COUNT(*)::int AS reports
    FROM reports WHERE uid = ${uid} AND chat = ${config.groupId} AND status = 'approved' AND role = ${role}
    GROUP BY day ORDER BY day`) as any[];
  const allDays = (await db`SELECT DISTINCT day::text AS day FROM reports WHERE uid = ${uid} AND chat = ${config.groupId}`).map((r: any) => r.day);
  const byWeek = new Map<string, number>();
  const byMonth = new Map<string, number>();
  for (const r of daily) {
    const wk = weekOf(r.day, s.week)[0];
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + r.forms);
    const m = r.day.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + r.contracts);
  }
  const wins = await db`
    SELECT COUNT(*) FILTER (WHERE a.kind IN ('bonus','promo','manual'))::int AS bonuses,
      COUNT(*) FILTER (WHERE a.kind = 'bonus' AND b.kind = 'top_metric')::int AS top
    FROM accruals a LEFT JOIN bonus_rules b ON b.id = a.rule_id
    WHERE a.uid = ${uid} AND a.cancelled_at IS NULL AND a.amount > 0`;
  const st = streaks(allDays, today(), s.week);
  const sum = (k: string) => daily.reduce((acc, r) => acc + (r[k] ?? 0), 0);
  return {
    daily,
    stats: {
      reports: sum("reports"),
      forms: sum("forms"),
      calls: sum("calls"),
      contracts: sum("contracts"),
      docs: sum("docs"),
      vvk: sum("vvk"),
      bestDayForms: Math.max(0, ...daily.map((r) => r.forms)),
      bestWeekForms: Math.max(0, ...byWeek.values()),
      bestMonthContracts: Math.max(0, ...byMonth.values()),
      streak: st.current,
      bestStreak: st.best,
      bonuses: wins[0].bonuses,
      topWins: wins[0].top,
    },
  };
}

/** Проверить достижения сотрудника, запомнить новые и поздравить. Возвращает полный список. */
export async function checkAchievements(uid: number, role: Role, opts: { celebrate?: boolean } = { celebrate: true }) {
  const { stats, daily } = await statsOf(uid, role);
  const items = evaluate(role, stats);
  const earnedRows = await db`SELECT code, earned_at FROM achievements_earned WHERE uid = ${uid}`;
  const earned = new Map(earnedRows.map((r: any) => [r.code, r.earned_at]));
  for (const it of items) {
    if (!it.done || earned.has(it.code)) continue;
    const ins = await db`INSERT INTO achievements_earned(uid, code) VALUES(${uid}, ${it.code}) ON CONFLICT DO NOTHING RETURNING earned_at`;
    if (!ins.length) continue;
    earned.set(it.code, ins[0].earned_at);
    if (opts.celebrate !== false) {
      await notify(uid, { kind: "achievement", title: `Новое достижение: ${it.title}`, body: it.desc }, { dm: false });
    }
  }
  const list = items.map((it) => ({ ...it, done: it.done || earned.has(it.code), earnedAt: earned.get(it.code) ?? null }));
  return { items: list, stats, daily };
}

/** Личные рекорды: лучшая неделя, лучший день, лучший расчётный период по деньгам */
export async function recordsOf(uid: number, role: Role, daily: { day: string; forms: number; contracts: number }[]) {
  const s = await getSettings();
  const key = role === "qualifier" ? "forms" : "contracts";
  const weeks = new Map<string, number>();
  let bestDay = { value: 0, day: null as string | null };
  for (const r of daily) {
    const v = (r as any)[key] as number;
    if (v > bestDay.value) bestDay = { value: v, day: r.day };
    const wk = weekOf(r.day, s.week)[0];
    weeks.set(wk, (weeks.get(wk) ?? 0) + v);
  }
  let bestWeek = { value: 0, label: null as string | null };
  for (const [wk, v] of weeks) if (v > bestWeek.value) bestWeek = { value: v, label: humanRange(weekOf(wk, s.week)) };
  const money = await db`SELECT period_start::text AS p, SUM(amount)::int AS sum FROM accruals
    WHERE uid = ${uid} AND cancelled_at IS NULL GROUP BY period_start ORDER BY sum DESC LIMIT 1`;
  const { periodOf } = await import("../lib/time.ts");
  return {
    metric: key,
    bestDay: { value: bestDay.value, label: bestDay.day ? humanDay(bestDay.day) : null },
    bestWeek,
    bestPeriod: money.length ? { amount: money[0].sum, label: humanRange(periodOf(money[0].p, s.payoutDays)) } : { amount: 0, label: null },
    thisWeek: weeks.get(weekOf(today(), s.week)[0]) ?? 0,
  };
}
