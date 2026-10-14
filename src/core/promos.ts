// Акции и сторис. Акции четырёх видов:
//  • multiplier — множитель к деньгам за отчёт («анкета ×2 в пятницу»);
//  • threshold  — порог за неделю/месяц/весь срок («30 анкет за неделю — +3 000 ₽»);
//  • contest    — конкурс: лучший результат за срок акции получает сумму (ничья — делится);
//  • news       — просто новость, на деньги не влияет.

import { db } from "../db/client.ts";
import { audit } from "../db/audit.ts";
import { today, addDays, parseDay, weekOf, monthOf, humanRange, type Period } from "../lib/time.ts";
import type { Role } from "../lib/report.ts";
import { getSettings } from "./settings.ts";
import { createAccrual } from "./accruals.ts";
import { metricTotals, pickWinners, shareOf, METRICS, type Metric } from "./bonuses.ts";
import { notify } from "./notify.ts";

export type PromoKind = "multiplier" | "threshold" | "contest" | "news";

export interface Promo {
  id: number;
  name: string;
  kind: PromoKind;
  role: Role | "all";
  metric: Metric | null;
  multiplier: number | null;
  threshold: number | null;
  amount: number | null;
  period: "week" | "month" | "range";
  weekdays: number[];
  starts_on: string;
  ends_on: string;
  enabled: boolean;
  split_ties: boolean;
}

const rub = (n: number) => n.toLocaleString("ru-RU") + " ₽";
const ds = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10));

function normalize(r: any): Promo {
  return {
    ...r,
    id: Number(r.id),
    multiplier: r.multiplier === null ? null : Number(r.multiplier),
    weekdays: Array.isArray(r.weekdays) ? r.weekdays : [],
    starts_on: ds(r.starts_on),
    ends_on: ds(r.ends_on),
  };
}

export async function listPromos(): Promise<Promo[]> {
  return (await db`SELECT * FROM promotions ORDER BY ends_on DESC, id DESC`).map(normalize);
}

export class PromoError extends Error {}

export async function savePromo(p: Partial<Promo> & { name: string; kind: PromoKind }, actor: number): Promise<Promo> {
  const name = (p.name ?? "").trim();
  if (!name) throw new PromoError("Назовите акцию");
  if (!["multiplier", "threshold", "contest", "news"].includes(p.kind)) throw new PromoError("Выберите вид акции");
  const role = (p.role ?? "all") as Promo["role"];
  const starts = p.starts_on ?? today();
  const ends = p.ends_on ?? starts;
  if (ends < starts) throw new PromoError("Дата окончания раньше даты начала");
  if (p.kind !== "news" && p.kind !== "multiplier") {
    if (role === "all") throw new PromoError("Для порога и конкурса выберите роль: у ролей разные показатели");
    if (!p.metric || !METRICS[role].includes(p.metric)) throw new PromoError("Выберите показатель");
    if (!(Number(p.amount) > 0)) throw new PromoError("Укажите сумму");
  }
  if (p.kind === "threshold" && !(Number(p.threshold) > 0)) throw new PromoError("Укажите порог");
  if (p.kind === "multiplier" && !(Number(p.multiplier) > 1)) throw new PromoError("Множитель должен быть больше 1, например 2");
  const weekdays = (p.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const vals = {
    name, kind: p.kind, role, metric: p.metric ?? null,
    multiplier: p.kind === "multiplier" ? Number(p.multiplier) : null,
    threshold: p.kind === "threshold" || p.kind === "contest" ? Number(p.threshold ?? 0) : null,
    amount: p.kind === "threshold" || p.kind === "contest" ? Math.round(Number(p.amount)) : null,
    period: p.kind === "threshold" ? (p.period ?? "week") : "range",
    weekdays: JSON.stringify(weekdays),
    enabled: p.enabled ?? true,
    split: p.split_ties ?? true,
  };
  let row;
  if (p.id) {
    [row] = await db`UPDATE promotions SET name = ${vals.name}, kind = ${vals.kind}, role = ${vals.role}, metric = ${vals.metric},
      multiplier = ${vals.multiplier}, threshold = ${vals.threshold}, amount = ${vals.amount}, period = ${vals.period},
      weekdays = ${vals.weekdays}::text::jsonb, starts_on = ${starts}, ends_on = ${ends}, enabled = ${vals.enabled},
      split_ties = ${vals.split}, updated_at = now() WHERE id = ${p.id} RETURNING *`;
  } else {
    [row] = await db`INSERT INTO promotions(name, kind, role, metric, multiplier, threshold, amount, period, weekdays, starts_on, ends_on, enabled, split_ties, created_by)
      VALUES(${vals.name}, ${vals.kind}, ${vals.role}, ${vals.metric}, ${vals.multiplier}, ${vals.threshold}, ${vals.amount}, ${vals.period},
        ${vals.weekdays}::text::jsonb, ${starts}, ${ends}, ${vals.enabled}, ${vals.split}, ${actor}) RETURNING *`;
  }
  await audit(actor, "promo.save", row);
  return normalize(row);
}

/** Доплата по акциям-множителям к деньгам за подтверждённый отчёт. Возвращает сумму доплат. */
export async function applyMultipliers(r: { uid: number; role: Role; day: string; base: number; chat: number; msg: number }): Promise<number> {
  const promos = await db`SELECT * FROM promotions WHERE enabled AND kind = 'multiplier'
    AND (role = 'all' OR role = ${r.role}) AND ${r.day}::date BETWEEN starts_on AND ends_on`;
  const dow = parseDay(r.day).getUTCDay();
  let total = 0;
  for (const raw of promos) {
    const p = normalize(raw);
    if (p.weekdays.length && !p.weekdays.includes(dow)) continue;
    const extra = Math.round(r.base * ((p.multiplier ?? 1) - 1));
    if (extra <= 0) continue;
    const acc = await createAccrual({
      uid: r.uid,
      kind: "promo",
      amount: extra,
      day: r.day,
      dedupeKey: `promo:${p.id}:report:${r.chat}:${r.msg}`,
      report: { chat: r.chat, msg: r.msg },
      comment: `Акция «${p.name}» ×${p.multiplier}`,
    });
    if (acc) total += extra;
  }
  return total;
}

function periodsOf(p: Promo, upTo: string): { key: string; period: Period }[] {
  // Только завершившиеся периоды в пределах срока акции
  const out: { key: string; period: Period }[] = [];
  if (p.period === "range" || p.kind === "contest") {
    if (p.ends_on < upTo) out.push({ key: "range", period: [p.starts_on, p.ends_on] });
    return out;
  }
  let cursor = p.starts_on;
  for (let i = 0; i < 60 && cursor <= p.ends_on; i++) {
    const per: Period = p.period === "week" ? weekOf(cursor) : monthOf(cursor);
    const clipped: Period = [per[0] < p.starts_on ? p.starts_on : per[0], per[1] > p.ends_on ? p.ends_on : per[1]];
    if (clipped[1] < upTo) out.push({ key: per[0], period: clipped });
    cursor = addDays(per[1], 1);
  }
  return out;
}

/** Подвести итоги порогов и конкурсов за завершившиеся периоды (идемпотентно) */
export async function runDuePromos(day = today()): Promise<{ promo: string; key: string; winners: number }[]> {
  const s = await getSettings();
  const out = [];
  const promos = (await db`SELECT * FROM promotions WHERE enabled AND kind IN ('threshold','contest') AND ends_on >= ${addDays(day, -60)}`).map(normalize);
  for (const p of promos) {
    if (p.role === "all" || !p.metric) continue;
    for (const { key, period } of periodsOf(p, day)) {
      if (period[1] < s.startDate) continue;
      const done = await db`SELECT 1 FROM promo_runs WHERE promo_id = ${p.id} AND period_key = ${key}`;
      if (done.length) continue;
      const rows = await metricTotals(p.role, p.metric, period);
      const winners = p.kind === "threshold" ? rows.filter((r) => r.value >= (p.threshold ?? 0) && r.value > 0) : pickWinners(rows, p.threshold ?? 0);
      const each = p.kind === "contest" ? shareOf(p.amount ?? 0, winners.length, p.split_ties) : p.amount ?? 0;
      const result = [];
      for (const w of winners) {
        const acc = await createAccrual({
          uid: w.uid, kind: "promo", amount: each, day: period[1],
          dedupeKey: `promo:${p.id}:${key}:${w.uid}`,
          comment: `Акция «${p.name}», ${humanRange(period)}`,
        });
        result.push({ ...w, amount: each });
        if (acc) await notify(w.uid, { kind: "bonus", title: `Акция «${p.name}»: +${rub(each)}`, body: `Ваш результат: ${w.value}`, amount: each });
      }
      await db`INSERT INTO promo_runs(promo_id, period_key, winners) VALUES(${p.id}, ${key}, ${JSON.stringify(result)}::text::jsonb) ON CONFLICT DO NOTHING`;
      out.push({ promo: p.name, key, winners: result.length });
    }
  }
  return out;
}

// ───────── Сторис ─────────

export interface Story {
  id: number;
  title: string;
  body: string | null;
  big: string | null;
  style: "accent" | "card" | "gold";
  role: Role | "all";
  promo_id: number | null;
  starts_on: string;
  ends_on: string;
  active: boolean;
}

const storyNorm = (r: any): Story => ({ ...r, id: Number(r.id), starts_on: ds(r.starts_on), ends_on: ds(r.ends_on) });

export async function listStories(opts: { role?: Role; day?: string; all?: boolean } = {}): Promise<Story[]> {
  if (opts.all) return (await db`SELECT * FROM stories ORDER BY active DESC, ends_on DESC, id DESC LIMIT 100`).map(storyNorm);
  const day = opts.day ?? today();
  const rows = await db`SELECT * FROM stories WHERE active AND ${day}::date BETWEEN starts_on AND ends_on
    AND (role = 'all' OR role = ${opts.role ?? "all"}) ORDER BY id DESC`;
  return rows.map(storyNorm);
}

export async function saveStory(st: Partial<Story> & { title: string }, actor: number): Promise<Story> {
  const title = (st.title ?? "").trim();
  if (!title) throw new PromoError("Добавьте заголовок сторис");
  if (title.length > 40) throw new PromoError("Заголовок длиннее 40 символов не поместится в плитку");
  const starts = st.starts_on ?? today();
  const ends = st.ends_on ?? addDays(starts, 7);
  if (ends < starts) throw new PromoError("Дата окончания раньше даты начала");
  const style = ["accent", "card", "gold"].includes(st.style as string) ? st.style : "accent";
  const role = ["all", "qualifier", "recruiter"].includes(st.role as string) ? st.role : "all";
  let row;
  if (st.id) {
    [row] = await db`UPDATE stories SET title = ${title}, body = ${st.body ?? null}, big = ${st.big ?? null}, style = ${style},
      role = ${role}, promo_id = ${st.promo_id ?? null}, starts_on = ${starts}, ends_on = ${ends}, active = ${st.active ?? true}
      WHERE id = ${st.id} RETURNING *`;
  } else {
    [row] = await db`INSERT INTO stories(title, body, big, style, role, promo_id, starts_on, ends_on, created_by)
      VALUES(${title}, ${st.body ?? null}, ${st.big ?? null}, ${style}, ${role}, ${st.promo_id ?? null}, ${starts}, ${ends}, ${actor}) RETURNING *`;
  }
  await audit(actor, "story.save", row);
  return storyNorm(row);
}

export async function hideStory(id: number, actor: number) {
  await db`UPDATE stories SET active = FALSE WHERE id = ${id}`;
  await audit(actor, "story.hide", { id });
}
