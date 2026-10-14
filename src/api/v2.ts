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
import { listPromos, savePromo, listStories, saveStory, hideStory, PromoError } from "../core/promos.ts";
import { sendDocument } from "../lib/telegram.ts";

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
  const e = await staff.touch(user);
  const level = staff.adminLevelOf(e);
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
    contact: config.approverUsernames[0] ?? null,
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
    unread: (await db`SELECT COUNT(*)::int AS n FROM notifications WHERE uid = ${e.uid} AND read_at IS NULL`)[0].n,
  });
};

function accrualView(a: any) {
  return { id: Number(a.id), kind: a.kind, amount: a.amount, day: typeof a.day === "string" ? a.day : new Date(a.day).toISOString().slice(0, 10), comment: a.comment };
}

/** Серия: подряд рабочих дней с отчётом, считая назад от сегодня (или вчера, если сегодня ещё не отчитался) */
async function streakOf(uid: number, day: string): Promise<number> {
  const s = await getSettings();
  const rows = await db`SELECT DISTINCT day::text AS day FROM reports WHERE uid = ${uid} AND chat = ${config.groupId}
    AND day > ${addDays(day, -120)} ORDER BY day DESC`;
  const have = new Set(rows.map((r: any) => r.day));
  const workday = (d: string) => {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    return ((dow - s.week.startDow + 7) % 7) < s.week.days;
  };
  let d = have.has(day) ? day : addDays(day, -1);
  let n = 0;
  for (let i = 0; i < 120; i++, d = addDays(d, -1)) {
    if (!workday(d)) continue;
    if (!have.has(d)) break;
    n++;
  }
  return n;
}

const register: Handler = async ({ req, user }) => {
  const b = await body<{ fullName: string; city?: string; role: Role; phone?: string }>(req);
  await staff.touch(user, { canDm: false });
  try {
    const e = await staff.register(user.id, { fullName: b.fullName ?? "", city: b.city, role: b.role, phone: b.phone });
    await announceRegistration(e);
    return ok({ status: e.status, role: e.role });
  } catch (err) {
    if (err instanceof staff.RegistrationError) return fail(400, err.message);
    throw err;
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
  const role = (demo ? (url.searchParams.get("role") as Role) || "qualifier" : e?.role) as Role | null;
  if (!role || (!demo && e?.status !== "active")) return fail(403, "Статистика доступна после одобрения регистрации");
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
    WHERE a.cancelled_at IS NULL AND a.day BETWEEN ${from} AND ${to}
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
  const s = await getSettings();
  const period = b.periodStart ? periodOf(b.periodStart, s.payoutDays) : periodBack(1, undefined, s.payoutDays);
  const sum = await markPaid(Number(b.uid), period, user.id, b.amount);
  return ok({ amount: sum, period });
};

const adminEmployee: Handler = async ({ params }) => {
  const uid = Number(params.uid);
  const e = await staff.getEmployee(uid);
  if (!e) return fail(404, "Сотрудник не найден");
  const s = await getSettings();
  const cur = periodOf(undefined, s.payoutDays);
  const prev = periodBack(1, undefined, s.payoutDays);
  const accruals = await db`SELECT id, kind, amount, day::text AS day, comment, created_by, cancelled_at FROM accruals
    WHERE uid = ${uid} ORDER BY day DESC, id DESC LIMIT 60`;
  return ok({
    uid, name: staff.displayName(e), username: e.username, photoUrl: e.photo_url, role: e.role, status: e.status,
    phone: e.phone, city: e.city, adminLevel: staff.adminLevelOf(e), registeredAt: e.registered_at, approvedAt: e.approved_at,
    balance: { ...(await balanceOf(uid, cur)), label: humanRange(cur) },
    previous: { ...(await balanceOf(uid, prev)), label: humanRange(prev) },
    accruals: accruals.map((a: any) => ({ ...a, id: Number(a.id), cancelled: Boolean(a.cancelled_at) })),
  });
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
    unread: 1,
  };
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
  ["POST", "/api/v2/register", register],
  ["POST", "/api/v2/me/prefs", prefs],
  ["GET", "/api/v2/stats/weekly", weekly],
  ["GET", "/api/v2/me/accruals", accrualsList],
  ["GET", "/api/v2/notifications", notifications],
  ["POST", "/api/v2/notifications/read", notifications],

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
    const isDemo = url.searchParams.get("demo") === "1" && req.method === "GET" && (pattern === "/api/v2/me" || pattern === "/api/v2/stats/weekly");
    const user = verifyInitData(req.headers.get("X-Telegram-Init-Data") ?? "") ?? (isDemo ? demoUser() : null);
    if (!user) return fail(401, "Откройте приложение из Telegram");
    try {
      return await handler({ req, url, user, params });
    } catch (e) {
      console.error("[api]", pattern, e);
      return fail(500, "Что-то пошло не так, попробуйте ещё раз");
    }
  }
  return fail(404, "Нет такого адреса");
}
