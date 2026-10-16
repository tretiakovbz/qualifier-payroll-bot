// API v2 для Mini App: сотрудник и кабинет админа.
// Каждый запрос подписан initData Telegram; права проверяются на сервере.

import { config } from "../config.ts";
import { verifyInitData, type TgUser } from "../lib/telegram.ts";
import { today, periodOf, periodBack, weekOf, addDays, payoutDayOf, daysBetween, humanRange, type Period } from "../lib/time.ts";
import type { Role } from "../lib/report.ts";
import { db } from "../db/client.ts";
import * as staff from "../core/employees.ts";
import { getSettings, updateSettings, SettingsError } from "../core/settings.ts";
import { balanceOf, recentAccruals, manualAccrual, cancelAccrual, payroll, markPaid } from "../core/accruals.ts";
import { listRules, saveRule, getRule, metricTotals, manualCandidates, setManualAward, bonusProgress, periodKey, METRICS, type Metric } from "../core/bonuses.ts";
import { listDirections, saveDirection } from "../core/directions.ts";
import { listReports, setReportStatus, pendingCount } from "../core/reports.ts";
import { listNotifications, markRead } from "../core/notify.ts";
import { announceRegistration } from "../bot/updates.ts";
import { salaryOverview, setSalaryProfile, setSalaryOverride, SalaryError, monthlyOf, workStartOf } from "../core/salary.ts";
import { checkAchievements, recordsOf, streaks, DEFS } from "../core/achievements.ts";
import { listPromos, savePromo, listStories, saveStory, hideStory, PromoError } from "../core/promos.ts";
import { sendDocument } from "../lib/telegram.ts";
import { cid, tryCid, withCompany, NoCompanyError } from "../core/tenant.ts";
import { getCompany, companyByInvite, createCompany, joinCompany, leaveCompany, renameCompany, resetInvite, inviteLink, bindLink, CompanyError } from "../core/companies.ts";

type Ctx = { req: Request; url: URL; user: TgUser; params: Record<string, string> };
type Handler = (c: Ctx) => Promise<Response>;

const ok = (data: unknown) => Response.json(data);
const fail = (status: number, error: string) => Response.json({ error }, { status });

async function body<T = any>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

function demoUser(): TgUser {
  return { id: -1, first_name: "Демо" };
}

// ───────────── Сотрудник ─────────────

const me: Handler = async ({ user, url }) => {
  if (url.searchParams.get("demo") === "1") return ok(demoMe());
  const e = (await staff.getEmployee(user.id))!;
  const level = staff.adminLevelOf(e);
  const company = e.company_id ? await getCompany(e.company_id) : null;
  const contact = company ? (await db`SELECT username FROM employees WHERE company_id = ${company.id} AND admin_level IS NOT NULL AND username IS NOT NULL ORDER BY admin_level = 'owner' DESC LIMIT 1`)[0]?.username ?? null : null;
  const base = {
    uid: e.uid,
    name: staff.displayName(e),
    username: e.username,
    photoUrl: e.photo_url,
    role: e.role,
    status: e.status,
    adminLevel: level,
    prefs: e.prefs ?? {},
    phone: e.phone,
    contact,
    company: company ? { id: company.id, name: company.name, isOwner: company.owner_uid === e.uid, groupBound: Boolean(company.group_id) } : null,
  };
  if (e.status !== "active" || !e.role) return ok({ ...base, registered: e.status === "pending" && Boolean(e.role) });

  const s = await getSettings();
  const day = today();
  const period = periodOf(day, s.payoutDays);
  const balance = await balanceOf(e.uid, period);
  const payoutDay = payoutDayOf(period);
  const streak = await streakOf(e.uid, day);
  const week = weekOf(day, s.week);
  const mainMetric: Metric = e.role === "qualifier" ? "forms" : "contracts";
  const rating = await metricTotals(e.role, mainMetric, week, { includePending: true });
  const place = rating.findIndex((r) => r.uid === e.uid) + 1;

  return ok({
    ...base,
    joinedAt: e.approved_at,
    balance: { ...balance, periodLabel: humanRange(period) },
    payout: { day: payoutDay, daysLeft: daysBetween(day, payoutDay), periodDays: daysBetween(period[0], payoutDay), payoutDays: s.payoutDays },
    streak,
    place: { place: place || null, of: rating.length, metric: mainMetric, week },
    goals: await bonusProgress(e.uid, e.role, day),
    stories: (await listStories({ role: e.role, day })).map((x) => ({ id: "s" + x.id, title: x.title, body: x.body, big: x.big, style: x.style })),
    recent: (await recentAccruals(e.uid, 10)).map(accrualView),
    achievements: await (async () => { const a = await checkAchievements(e.uid, e.role!); return { earned: a.items.filter((x) => x.done).length, total: a.items.length }; })(),
    unread: (await db`SELECT COUNT(*)::int AS n FROM notifications WHERE uid = ${e.uid} AND read_at IS NULL`)[0].n,
  });
};

const achievements: Handler = async ({ user, url }) => {
  if (url.searchParams.get("demo") === "1") return ok(demoAchievements());
  const e = await staff.getEmployee(user.id);
  if (!e || e.status !== "active" || !e.role) return fail(403, "Достижения появятся после одобрения регистрации");
  const a = await checkAchievements(e.uid, e.role);
  return ok({ items: a.items, earned: a.items.filter((x) => x.done).length, total: a.items.length, records: await recordsOf(e.uid, e.role, a.daily), streak: a.stats.streak, bestStreak: a.stats.bestStreak });
};

function accrualView(a: any) {
  return { id: Number(a.id), kind: a.kind, amount: a.amount, day: typeof a.day === "string" ? a.day : new Date(a.day).toISOString().slice(0, 10), comment: a.comment };
}

/** Серия: подряд рабочих дней с отчётом (сегодня или вчера — последний) */
async function streakOf(uid: number, day: string): Promise<number> {
  const s = await getSettings();
  const rows = await db`SELECT DISTINCT day::text AS day FROM reports WHERE uid = ${uid} AND company_id = ${cid()}
    AND day > ${addDays(day, -400)}`;
  return streaks(rows.map((r: any) => r.day), day, s.week).current;
}

// ───────────── Компании: создание, приглашение, выход ─────────────

function companyError(e: unknown): Response {
  if (e instanceof CompanyError) return fail(400, e.message);
  throw e;
}

/** Руководитель создаёт свою компанию */
const companyCreate: Handler = async ({ req, user }) => {
  const b = await body<{ name: string; fullName: string; city?: string; phone?: string; ref?: string }>(req);
  try {
    const c = await createCompany({ uid: user.id }, { name: b.name, fullName: b.fullName, city: b.city, phone: b.phone, ref: b.ref ?? null });
    return ok({ id: c.id, name: c.name });
  } catch (e) {
    return companyError(e);
  }
};

/** Что за компания по ссылке-приглашению — до вступления */
const joinPreview: Handler = async ({ params, user }) => {
  const c = await companyByInvite(params.code);
  if (!c) return fail(404, "Ссылка-приглашение недействительна. Попросите у руководителя новую.");
  const n = (await db`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = ${c.id} AND status = 'active'`)[0].n;
  const ownerRow = (await db`SELECT full_name, name FROM employees WHERE uid = ${c.owner_uid}`)[0];
  const e = await staff.getEmployee(user.id);
  const current = e?.company_id ? await getCompany(e.company_id) : null;
  return ok({
    company: { name: c.name, members: n, owner: ownerRow ? staff.displayName(ownerRow) : null },
    me: { inThis: current?.id === c.id, status: e?.status ?? "new", current: current && current.id !== c.id ? { name: current.name, isOwner: current.owner_uid === user.id } : null },
  });
};

/** Сотрудник вступает по ссылке: заявка уходит руководителю */
const joinPost: Handler = async ({ params, req, user }) => {
  const b = await body<{ fullName: string; city?: string; role: Role; phone?: string }>(req);
  try {
    const r = await joinCompany(user.id, params.code, { fullName: b.fullName, city: b.city, role: b.role, phone: b.phone });
    const e = (await staff.getEmployee(user.id))!;
    await withCompany(r.company.id, () => announceRegistration(e));
    return ok({ status: r.status, company: r.company.name });
  } catch (e) {
    return companyError(e);
  }
};

/** Сотрудник сам выходит из компании */
const leave: Handler = async ({ user }) => {
  try {
    await leaveCompany(user.id);
    return ok({ ok: true });
  } catch (e) {
    return companyError(e);
  }
};

const adminCompany: Handler = async ({ user }) => {
  const c = (await getCompany(cid()))!;
  const staffCount = (await db`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = ${c.id} AND status = 'active' AND role IS NOT NULL`)[0].n;
  return ok({
    id: c.id, name: c.name, isOwner: c.owner_uid === user.id,
    inviteLink: inviteLink(c), bindLink: bindLink(c),
    group: c.group_id ? { id: c.group_id, title: c.group_title } : null,
    staff: staffCount, createdAt: c.created_at,
  });
};

const adminCompanySave: Handler = async ({ req, user }) => {
  const b = await body<{ name?: string; resetInvite?: boolean }>(req);
  try {
    if (b.name !== undefined) await renameCompany(cid(), b.name, user.id);
    if (b.resetInvite) await resetInvite(cid(), user.id);
    return adminCompany({ req, user } as Ctx);
  } catch (e) {
    return companyError(e);
  }
};

const prefs: Handler = async ({ req, user }) => {
  const b = await body<staff.Prefs>(req);
  const allowed: staff.Prefs = {};
  if (b.theme && ["system", "day", "night", "military", "funny"].includes(b.theme)) allowed.theme = b.theme;
  if (typeof b.sounds === "boolean") allowed.sounds = b.sounds;
  if (typeof b.haptics === "boolean") allowed.haptics = b.haptics;
  if (typeof b.reminderTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.reminderTime)) allowed.reminderTime = b.reminderTime;
  if (b.notify && typeof b.notify === "object") {
    allowed.notify = {};
    for (const k of ["approved", "bonus", "payout", "promo", "reminder"] as const) {
      if (typeof b.notify[k] === "boolean") allowed.notify[k] = b.notify[k];
    }
    const cur = (await staff.getEmployee(user.id))?.prefs?.notify ?? {};
    allowed.notify = { ...cur, ...allowed.notify };
  }
  return ok(await staff.updatePrefs(user.id, allowed));
};

/** Статистика по неделям для графика: только своя роль */
const weekly: Handler = async ({ user, url }) => {
  const demo = url.searchParams.get("demo") === "1";
  const e = demo ? null : await staff.getEmployee(user.id);
  const asked = url.searchParams.get("role") as Role | null;
  // Админ может смотреть статистику любой команды, сотрудник — только своей
  const isAdm = !demo && asked && (asked === "qualifier" || asked === "recruiter") ? Boolean(await staff.adminLevel(user)) : false;
  const role = (demo ? asked || "qualifier" : isAdm ? asked : e?.role) as Role | null;
  if (!role || (!demo && !isAdm && e?.status !== "active")) return fail(403, "Статистика доступна после одобрения регистрации");
  const metric = (url.searchParams.get("metric") as Metric) || METRICS[role][0];
  if (!METRICS[role].includes(metric)) return fail(400, "Нет такого показателя для вашей роли");
  const weeks = Math.min(26, Math.max(4, Number(url.searchParams.get("weeks") ?? 8)));
  if (demo) return ok(demoWeekly(role, metric, weeks));

  const s = await getSettings();
  const cur = weekOf(today(), s.week);
  const periods: Period[] = [];
  for (let i = weeks - 1; i >= 0; i--) periods.push(weekOf(addDays(cur[0], -7 * i), s.week));
  const people = new Map<number, { uid: number; name: string; values: number[] }>();
  for (const [i, p] of periods.entries()) {
    for (const r of await metricTotals(role, metric, p, { includePending: true })) {
      if (!people.has(r.uid)) people.set(r.uid, { uid: r.uid, name: r.name, values: Array(weeks).fill(0) });
      people.get(r.uid)!.values[i] = r.value;
    }
  }
  const series = [...people.values()].map((p) => ({ ...p, me: p.uid === user.id }));
  const rating = series.map((p) => ({ uid: p.uid, name: p.name, value: p.values[weeks - 1], me: p.me })).sort((a, b) => b.value - a.value);
  return ok({ role, metric, metrics: METRICS[role], weeks: periods, series, rating });
};

const accrualsList: Handler = async ({ user }) => {
  const s = await getSettings();
  const periods = [0, 1, 2, 3, 4, 5].map((i) => periodBack(i, undefined, s.payoutDays));
  const history = [];
  for (const p of periods) history.push({ ...(await balanceOf(user.id, p)), label: humanRange(p), payoutDay: payoutDayOf(p) });
  return ok({ history, items: (await recentAccruals(user.id, 100)).map(accrualView) });
};

const notifications: Handler = async ({ user, req }) => {
  if (req.method === "POST") {
    await markRead(user.id);
    return ok({ ok: true });
  }
  return ok(await listNotifications(user.id));
};

// ───────────── Админ ─────────────

/** Человек в этой компании сейчас или был в ней (есть начисления) — иначе админ чужой компании его не трогает */
async function inCompany(uid: number): Promise<boolean> {
  const r = await db`SELECT 1 FROM employees WHERE uid = ${uid} AND company_id = ${cid()}
    UNION ALL SELECT 1 FROM accruals WHERE uid = ${uid} AND company_id = ${cid()} LIMIT 1`;
  return r.length > 0;
}

function admin(min: "manager" | "owner", h: Handler): Handler {
  return async (c) => {
    const level = await staff.adminLevel(c.user);
    if (!level || (min === "owner" && level !== "owner")) return fail(403, "Недостаточно прав");
    return h(c);
  };
}

const adminOverview: Handler = async () => {
  const regs = await staff.listEmployees({ status: "pending" });
  const s = await getSettings();
  const rules = await listRules();
  const manual = [];
  for (const r of rules.filter((r) => r.kind === "manual" && r.enabled)) {
    const lastWeek = weekOf(addDays(weekOf(today(), s.week)[0], -1), s.week);
    const key = periodKey(r, r.period === "week" ? lastWeek : periodBack(0));
    const c = await manualCandidates(r, key);
    manual.push({ ruleId: r.id, name: r.name, key, period: c.period, total: c.staff.length, awarded: c.staff.filter((x: any) => x.awarded !== null).length });
  }
  return ok({ pendingReports: await pendingCount(), pendingRegistrations: regs.filter((e) => e.role).length, manual });
};

const adminReports: Handler = async ({ url }) => {
  const status = url.searchParams.get("status") as any;
  const role = url.searchParams.get("role") as any;
  return ok(await listReports({ status: status || undefined, role: role || undefined, limit: 300 }));
};

const adminReportDecide: Handler = async ({ req, user, params }) => {
  const b = await body<{ status: "approved" | "rejected" | "pending"; reason?: string }>(req);
  if (!["approved", "rejected", "pending"].includes(b.status)) return fail(400, "Неверный статус");
  const changed = await setReportStatus(Number(params.msg), b.status, user.id, b.reason);
  return ok({ changed });
};

const adminEmployees: Handler = async () => {
  const s = await getSettings();
  const period = periodOf(undefined, s.payoutDays);
  const list = await staff.listEmployees();
  const out = [];
  for (const e of list) {
    if (e.status === "archived" && !e.role) continue;
    const b = e.status === "active" ? await balanceOf(e.uid, period) : null;
    out.push({ uid: e.uid, name: staff.displayName(e), username: e.username, photoUrl: e.photo_url, role: e.role, status: e.status, phone: e.phone, city: e.city, adminLevel: staff.adminLevelOf(e), balance: b?.balance ?? null, registeredAt: e.registered_at });
  }
  return ok(out);
};

const adminEmployeeAction: Handler = async ({ req, user, params }) => {
  const uid = Number(params.uid);
  if (!(await inCompany(uid))) return fail(404, "Сотрудник не найден");
  const b = await body<{ action: "approve" | "reject" | "archive" | "make_manager" | "remove_manager" }>(req);
  const level = await staff.adminLevel(user);
  switch (b.action) {
    case "approve":
    case "reject": {
      const e = await staff.decide(uid, b.action === "approve", user.id);
      if (!e) return fail(409, "Заявка уже рассмотрена");
      return ok({ status: e.status });
    }
    case "archive":
      if (level !== "owner") return fail(403, "Удалять профили может только владелец");
      await staff.archive(uid, user.id);
      return ok({ status: "archived" });
    case "make_manager":
    case "remove_manager":
      if (level !== "owner") return fail(403, "Назначать админов может только владелец");
      await staff.setAdminLevel(uid, b.action === "make_manager" ? "manager" : null, user.id);
      return ok({ ok: true });
  }
  return fail(400, "Неизвестное действие");
};

const adminSettingsGet: Handler = async () => ok({ settings: await getSettings(), rules: await listRules(), directions: await listDirections(true) });

const adminSettingsPut: Handler = async ({ req, user }) => {
  try {
    return ok(await updateSettings(await body(req), user.id));
  } catch (e) {
    if (e instanceof SettingsError) return fail(400, e.message);
    throw e;
  }
};

const adminRuleSave: Handler = async ({ req, user, params }) => {
  const b = await body(req);
  try {
    return ok(await saveRule({ ...b, id: params.id ? Number(params.id) : b.id }, user.id));
  } catch (e: any) {
    return fail(400, e.message);
  }
};

const adminDirectionSave: Handler = async ({ req, user }) => {
  try {
    return ok(await saveDirection(await body(req), user.id));
  } catch (e: any) {
    return fail(400, e.message);
  }
};

const adminAccrualCreate: Handler = async ({ req, user }) => {
  const b = await body<{ uid: number; amount: number; comment: string; ruleId?: number }>(req);
  if (!b.uid || !b.comment?.trim()) return fail(400, "Укажите сотрудника и за что начисление");
  if (!(await inCompany(Number(b.uid)))) return fail(404, "Сотрудник не найден");
  try {
    return ok(await manualAccrual({ uid: Number(b.uid), amount: Number(b.amount), comment: b.comment.trim(), ruleId: b.ruleId, actor: user.id }));
  } catch (e: any) {
    return fail(400, e.message);
  }
};

const adminAccrualCancel: Handler = async ({ user, params }) => {
  const a = await cancelAccrual(Number(params.id), user.id);
  return a ? ok(a) : fail(404, "Начисление не найдено или уже отменено");
};

const adminManualGet: Handler = async ({ params, url }) => {
  const rule = await getRule(Number(params.id));
  if (!rule || rule.kind !== "manual") return fail(404, "Нет такого ручного бонуса");
  const s = await getSettings();
  const key = url.searchParams.get("key") || periodKey(rule, rule.period === "week" ? weekOf(addDays(weekOf(today(), s.week)[0], -1), s.week) : periodBack(0));
  return ok(await manualCandidates(rule, key));
};

const adminManualSet: Handler = async ({ req, user, params }) => {
  const rule = await getRule(Number(params.id));
  if (!rule || rule.kind !== "manual") return fail(404, "Нет такого ручного бонуса");
  const b = await body<{ key: string; uid: number; award: boolean; amount?: number }>(req);
  if (b.uid && !(await inCompany(Number(b.uid)))) return fail(404, "Сотрудник не найден");
  if (!b.key || !b.uid) return fail(400, "Неполные данные");
  await setManualAward(rule, b.key, Number(b.uid), Boolean(b.award), user.id, b.amount);
  return ok(await manualCandidates(rule, b.key));
};

const adminAnalytics: Handler = async ({ url }) => {
  const s = await getSettings();
  const from = url.searchParams.get("from") || addDays(today(), -27);
  const to = url.searchParams.get("to") || today();
  const out: Record<string, unknown> = { from, to };
  for (const role of ["qualifier", "recruiter"] as Role[]) {
    const byMetric: Record<string, any[]> = {};
    for (const m of METRICS[role]) byMetric[m] = await metricTotals(role, m, [from, to]);
    out[role] = byMetric;
  }
  const money = await db`
    SELECT a.uid, COALESCE(e.full_name, e.name) AS name, e.role, a.kind, COALESCE(SUM(a.amount), 0)::int AS sum
    FROM accruals a JOIN employees e ON e.uid = a.uid
    WHERE a.company_id = ${cid()} AND a.cancelled_at IS NULL AND a.day BETWEEN ${from} AND ${to}
    GROUP BY a.uid, e.full_name, e.name, e.role, a.kind`;
  out.money = money;
  const cur = periodOf(undefined, s.payoutDays);
  const prev = periodBack(1, undefined, s.payoutDays);
  out.payroll = await payroll(cur);
  out.payrollPrev = await payroll(prev);
  out.periods = { current: { period: cur, label: humanRange(cur), payoutDay: payoutDayOf(cur) }, previous: { period: prev, label: humanRange(prev), payoutDay: payoutDayOf(prev) } };
  return ok(out);
};

const adminPayout: Handler = async ({ req, user }) => {
  const b = await body<{ uid: number; periodStart?: string; amount?: number }>(req);
  if (!(await inCompany(Number(b.uid)))) return fail(404, "Сотрудник не найден");
  const s = await getSettings();
  const period = b.periodStart ? periodOf(b.periodStart, s.payoutDays) : periodBack(1, undefined, s.payoutDays);
  const sum = await markPaid(Number(b.uid), period, user.id, b.amount);
  return ok({ amount: sum, period });
};

const adminEmployee: Handler = async ({ params }) => {
  const uid = Number(params.uid);
  const e = await staff.getEmployee(uid);
  if (!e || !(await inCompany(uid))) return fail(404, "Сотрудник не найден");
  const s = await getSettings();
  const cur = periodOf(undefined, s.payoutDays);
  const prev = periodBack(1, undefined, s.payoutDays);
  const accruals = await db`SELECT id, kind, amount, day::text AS day, comment, created_by, cancelled_at FROM accruals
    WHERE uid = ${uid} AND company_id = ${cid()} ORDER BY day DESC, id DESC LIMIT 60`;
  return ok({
    uid, name: staff.displayName(e), username: e.username, photoUrl: e.photo_url, role: e.role, status: e.status,
    phone: e.phone, city: e.city, adminLevel: staff.adminLevelOf(e), registeredAt: e.registered_at, approvedAt: e.approved_at,
    balance: { ...(await balanceOf(uid, cur)), label: humanRange(cur) },
    previous: { ...(await balanceOf(uid, prev)), label: humanRange(prev) },
    accruals: accruals.map((a: any) => ({ ...a, id: Number(a.id), cancelled: Boolean(a.cancelled_at) })),
    salary: e.role ? { monthly: monthlyOf(e as any, s), individual: e.salary_monthly ?? null, workStart: workStartOf(e as any) } : null,
  });
};

const adminSalaryGet: Handler = async ({ params }) => {
  const d = await salaryOverview(Number(params.uid));
  return d ? ok(d) : fail(404, "Сотрудник не найден");
};

const adminSalaryProfile: Handler = async ({ req, user, params }) => {
  if (!(await inCompany(Number(params.uid)))) return fail(404, "Сотрудник не найден");
  const b = await body<{ monthly?: number | null; workStart?: string | null }>(req);
  const patch: { monthly?: number | null; workStart?: string | null } = {};
  if ("monthly" in b) patch.monthly = b.monthly === null || (b.monthly as unknown) === "" ? null : Number(b.monthly);
  if ("workStart" in b) patch.workStart = b.workStart || null;
  try {
    return ok(await setSalaryProfile(Number(params.uid), patch, user.id));
  } catch (e) {
    if (e instanceof SalaryError) return fail(400, e.message);
    throw e;
  }
};

const adminSalaryPeriod: Handler = async ({ req, user, params }) => {
  if (!(await inCompany(Number(params.uid)))) return fail(404, "Сотрудник не найден");
  const b = await body<{ periodStart: string; amount: number | null; comment?: string }>(req);
  const amount = b.amount === null || (b.amount as unknown) === "" ? null : Number(b.amount);
  try {
    return ok(await setSalaryOverride(Number(params.uid), String(b.periodStart ?? ""), amount, b.comment ?? null, user.id));
  } catch (e) {
    if (e instanceof SalaryError) return fail(400, e.message);
    throw e;
  }
};

const adminPromosGet: Handler = async () => ok({ promos: await listPromos(), stories: await listStories({ all: true }) });

const adminPromoSave: Handler = async ({ req, user }) => {
  try {
    return ok(await savePromo(await body(req), user.id));
  } catch (e) {
    if (e instanceof PromoError) return fail(400, e.message);
    throw e;
  }
};

const adminStorySave: Handler = async ({ req, user }) => {
  try {
    return ok(await saveStory(await body(req), user.id));
  } catch (e) {
    if (e instanceof PromoError) return fail(400, e.message);
    throw e;
  }
};

const adminStoryHide: Handler = async ({ user, params }) => {
  await hideStory(Number(params.id), user.id);
  return ok({ ok: true });
};

const ROLE_RU: Record<string, string> = { qualifier: "квалификатор", recruiter: "рекрутер" };

/** Ведомость CSV: возвращается в ответе и, в боевом режиме, приходит файлом в личку */
const adminExport: Handler = async ({ req, user }) => {
  const b = await body<{ periodStart?: string }>(req);
  const s = await getSettings();
  const period = b.periodStart ? periodOf(b.periodStart, s.payoutDays) : periodOf(undefined, s.payoutDays);
  const rows = await payroll(period);
  const quote = (x: unknown) => '"' + String(x ?? "").replaceAll('"', '""') + '"';
  const header = ["Период", "Telegram ID", "Сотрудник", "Роль", "Оклад ₽", "Анкеты/контракты ₽", "Бонусы и акции ₽", "Начислено ₽", "Выплачено ₽"];
  const lines = rows.map((r: any) => [humanRange(period), r.uid, r.name, ROLE_RU[r.role] ?? "", r.salary, r.work, r.bonus, r.total, r.paid ?? 0].map(quote).join(";"));
  const csv = [header.map(quote).join(";"), ...lines].join("\r\n");
  const filename = `vedomost_${period[0]}_${period[1]}.csv`;
  let sent = false;
  if (config.liveMode) sent = await sendDocument(user.id, new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }), filename).catch(() => false);
  return ok({ filename, csv, sent });
};

// ───────────── Демо-данные ─────────────

function demoMe() {
  const s = { payoutDays: [5, 20] as [number, number] };
  const day = today();
  const period = periodOf(day, s.payoutDays);
  const payoutDay = payoutDayOf(period);
  return {
    demo: true, uid: -1, name: "Анна Смирнова", role: "qualifier", status: "active", adminLevel: null, prefs: {}, contact: config.approverUsernames[0] ?? null, joinedAt: "2026-09-02T09:00:00Z",
    balance: { period, periodLabel: humanRange(period), accrued: 24500, byKind: { salary: 10000, form: 14500 }, paid: null, balance: 24500 },
    payout: { day: payoutDay, daysLeft: daysBetween(day, payoutDay), periodDays: daysBetween(period[0], payoutDay), payoutDays: s.payoutDays },
    streak: 9, place: { place: 1, of: 4, metric: "forms" },
    goals: [{ ruleId: 0, name: "Лучший по анкетам недели", amount: 5000, metric: "forms", threshold: 20, value: 17, leader: 17, toThreshold: 3, isLeader: true }],
    recent: [
      { id: 3, kind: "form", amount: 2500, day: addDays(day, -1), comment: "анкет: 5" },
      { id: 2, kind: "form", amount: 1500, day: addDays(day, -2), comment: "анкет: 3" },
      { id: 1, kind: "salary", amount: 10000, day: period[0], comment: "оклад, половина месяца" },
    ],
    achievements: { earned: 6, total: 12 },
    unread: 1,
  };
}

function demoAchievements() {
  const done = new Set(["first_report", "streak_5", "first_bonus", "champion", "forms_100", "day_10"]);
  const progress: Record<string, number> = { streak_20: 9, champion_3: 1, forms_500: 214, forms_1000: 214, week_30: 24, calls_1000: 860 };
  const items = DEFS.filter((d) => d.role === "all" || d.role === "qualifier").map((d) => ({
    code: d.code, title: d.title, desc: d.desc, icon: d.icon, tier: d.tier, target: d.target,
    value: done.has(d.code) ? d.target : progress[d.code] ?? 0, done: done.has(d.code), earnedAt: done.has(d.code) ? "2026-10-01T10:00:00Z" : null,
  }));
  return { demo: true, items, earned: done.size, total: items.length, streak: 9, bestStreak: 12,
    records: { metric: "forms", bestDay: { value: 11, label: "3 октября" }, bestWeek: { value: 24, label: "11–15 октября" }, bestPeriod: { amount: 31500, label: "20 сентября – 4 октября" }, thisWeek: 24 } };
}

function demoWeekly(role: Role, metric: Metric, weeks: number) {
  const base: Record<string, number[]> =
    role === "qualifier"
      ? metric === "calls"
        ? { "Анна (демо)": [80, 95, 90, 110, 102, 120, 115, 130], "Игорь (демо)": [70, 88, 96, 92, 108, 104, 118, 112], "Мария (демо)": [60, 64, 75, 72, 85, 80, 90, 96], "Дмитрий (демо)": [90, 85, 88, 100, 96, 105, 99, 110] }
        : { "Анна (демо)": [12, 15, 14, 18, 17, 21, 19, 24], "Игорь (демо)": [10, 13, 16, 15, 19, 18, 22, 20], "Мария (демо)": [8, 9, 12, 11, 14, 13, 15, 17], "Дмитрий (демо)": [14, 12, 13, 16, 15, 17, 16, 18] }
      : { "Олег (демо)": [1, 2, 1, 3, 2, 2, 4, 3], "Светлана (демо)": [2, 1, 2, 2, 3, 1, 2, 4], "Павел (демо)": [0, 1, 1, 1, 2, 2, 1, 2] };
  const series = Object.entries(base).map(([name, v], i) => ({ uid: -(i + 1), name, values: v.slice(-weeks), me: i === 0 }));
  const rating = series.map((p) => ({ uid: p.uid, name: p.name, value: p.values.at(-1)!, me: p.me })).sort((a, b) => b.value - a.value);
  const cur = weekOf(today());
  const weeksList: Period[] = [];
  for (let i = weeks - 1; i >= 0; i--) weeksList.push(weekOf(addDays(cur[0], -7 * i)));
  return { demo: true, role, metric, metrics: METRICS[role], weeks: weeksList, series, rating };
}

// ───────────── Маршруты ─────────────

const routes: [string, string, Handler][] = [
  ["GET", "/api/v2/me", me],
  ["POST", "/api/v2/me/prefs", prefs],
  ["GET", "/api/v2/stats/weekly", weekly],
  ["GET", "/api/v2/me/accruals", accrualsList],
  ["GET", "/api/v2/me/achievements", achievements],
  ["GET", "/api/v2/notifications", notifications],
  ["POST", "/api/v2/notifications/read", notifications],

  ["POST", "/api/v2/company", companyCreate],
  ["GET", "/api/v2/join/:code", joinPreview],
  ["POST", "/api/v2/join/:code", joinPost],
  ["POST", "/api/v2/me/leave", leave],
  ["GET", "/api/v2/admin/company", admin("manager", adminCompany)],
  ["POST", "/api/v2/admin/company", admin("owner", adminCompanySave)],
  ["GET", "/api/v2/admin/overview", admin("manager", adminOverview)],
  ["GET", "/api/v2/admin/reports", admin("manager", adminReports)],
  ["POST", "/api/v2/admin/reports/:msg", admin("manager", adminReportDecide)],
  ["GET", "/api/v2/admin/employees", admin("manager", adminEmployees)],
  ["POST", "/api/v2/admin/employees/:uid", admin("manager", adminEmployeeAction)],
  ["GET", "/api/v2/admin/settings", admin("manager", adminSettingsGet)],
  ["PUT", "/api/v2/admin/settings", admin("owner", adminSettingsPut)],
  ["POST", "/api/v2/admin/rules", admin("owner", adminRuleSave)],
  ["PUT", "/api/v2/admin/rules/:id", admin("owner", adminRuleSave)],
  ["POST", "/api/v2/admin/directions", admin("owner", adminDirectionSave)],
  ["POST", "/api/v2/admin/accruals", admin("manager", adminAccrualCreate)],
  ["DELETE", "/api/v2/admin/accruals/:id", admin("owner", adminAccrualCancel)],
  ["GET", "/api/v2/admin/manual/:id", admin("manager", adminManualGet)],
  ["POST", "/api/v2/admin/manual/:id", admin("manager", adminManualSet)],
  ["GET", "/api/v2/admin/analytics", admin("manager", adminAnalytics)],
  ["POST", "/api/v2/admin/payouts", admin("manager", adminPayout)],
  ["GET", "/api/v2/admin/employees/:uid", admin("manager", adminEmployee)],
  ["GET", "/api/v2/admin/employees/:uid/salary", admin("manager", adminSalaryGet)],
  ["POST", "/api/v2/admin/employees/:uid/salary", admin("owner", adminSalaryProfile)],
  ["POST", "/api/v2/admin/employees/:uid/salary/period", admin("owner", adminSalaryPeriod)],
  ["GET", "/api/v2/admin/promos", admin("manager", adminPromosGet)],
  ["POST", "/api/v2/admin/promos", admin("owner", adminPromoSave)],
  ["POST", "/api/v2/admin/stories", admin("owner", adminStorySave)],
  ["DELETE", "/api/v2/admin/stories/:id", admin("owner", adminStoryHide)],
  ["POST", "/api/v2/admin/export", admin("manager", adminExport)],
];

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function handleApiV2(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/v2/")) return null;
  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const params = match(pattern, url.pathname);
    if (!params) continue;
    const isDemo = url.searchParams.get("demo") === "1" && req.method === "GET" && (pattern === "/api/v2/me" || pattern === "/api/v2/stats/weekly" || pattern === "/api/v2/me/achievements");
    const user = verifyInitData(req.headers.get("X-Telegram-Init-Data") ?? "") ?? (isDemo ? demoUser() : null);
    if (!user) return fail(401, "Откройте приложение из Telegram");
    try {
      if (user.id === -1) return await handler({ req, url, user, params });
      // Контекст компании: все данные запроса — только из компании пользователя
      const e = await staff.touch(user);
      if (e.company_id) return await withCompany(e.company_id, () => handler({ req, url, user, params }));
      return await handler({ req, url, user, params });
    } catch (e) {
      if (e instanceof NoCompanyError) return fail(409, e.message);
      console.error("[api]", pattern, e);
      return fail(500, "Что-то пошло не так, попробуйте ещё раз");
    }
  }
  return fail(404, "Нет такого адреса");
}
