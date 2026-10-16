// Компании: создание руководителем, ссылки-приглашения, привязка рабочего чата, выход сотрудника.
// Один человек состоит в одной компании за раз; чтобы перейти в другую или создать свою — выходит из текущей.

import { db } from "../db/client.ts";
import { audit } from "../db/audit.ts";
import { config } from "../config.ts";
import type { Role } from "../lib/report.ts";
import { today } from "../lib/time.ts";
import { withCompany } from "./tenant.ts";

export interface Company {
  id: number;
  name: string;
  owner_uid: number;
  invite_code: string;
  bind_code: string;
  group_id: number | null;
  group_title: string | null;
  referred_by: number | null;
  legacy: boolean;
  status: string;
  created_at: string;
}

export class CompanyError extends Error {}

function norm(c: any): Company | null {
  if (!c) return null;
  return { ...c, id: Number(c.id), owner_uid: Number(c.owner_uid), group_id: c.group_id === null ? null : Number(c.group_id), referred_by: c.referred_by === null ? null : Number(c.referred_by) };
}

/** Случайный код для ссылок: без похожих символов (0/O, 1/l) */
export function newCode(len = 10): string {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

export async function getCompany(id: number): Promise<Company | null> {
  return norm((await db`SELECT * FROM companies WHERE id = ${id}`)[0]);
}

export async function companyByInvite(code: string): Promise<Company | null> {
  return norm((await db`SELECT * FROM companies WHERE invite_code = ${code} AND status = 'active'`)[0]);
}

export async function companyByGroup(chatId: number): Promise<Company | null> {
  return norm((await db`SELECT * FROM companies WHERE group_id = ${chatId} AND status = 'active'`)[0]);
}

export async function listCompanies(): Promise<Company[]> {
  return (await db`SELECT * FROM companies WHERE status = 'active' ORDER BY id`).map((c: any) => norm(c)!);
}

export function inviteLink(c: Pick<Company, "invite_code">): string {
  return `https://t.me/${config.botUsername}?startapp=join_${c.invite_code}`;
}

export function bindLink(c: Pick<Company, "bind_code">): string {
  return `https://t.me/${config.botUsername}?startgroup=bind_${c.bind_code}&admin=delete_messages`;
}

/** Бонусы по умолчанию для новой компании — все выключены, руководитель включает нужные */
async function seedDefaults(companyId: number) {
  await db`INSERT INTO bonus_rules(company_id, code, name, role, kind, metric, period, amount, threshold, enabled, sort) VALUES
    (${companyId}, 'top_calls_week', 'Лучший по недозвонам недели', 'qualifier', 'top_metric', 'calls', 'week', 5000, 0, FALSE, 1),
    (${companyId}, 'top_forms_week', 'Лучший по анкетам недели', 'qualifier', 'top_metric', 'forms', 'week', 5000, 20, FALSE, 2),
    (${companyId}, 'top_recruiter_month', 'Лучший рекрутер месяца', 'recruiter', 'top_metric', 'contracts', 'month', 50000, 1, FALSE, 3)
    ON CONFLICT DO NOTHING`;
  await db`INSERT INTO settings(key, value) VALUES(${"company:" + companyId}, ${JSON.stringify({ startDate: today() })}::text::jsonb)
    ON CONFLICT(key) DO NOTHING`;
}

/** Руководитель создаёт компанию и становится её владельцем */
export async function createCompany(
  owner: { uid: number },
  data: { name: string; fullName: string; city?: string; phone?: string; ref?: string | null },
): Promise<Company> {
  const name = (data.name ?? "").trim().replace(/\s+/g, " ");
  const fullName = (data.fullName ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) throw new CompanyError("Название компании — от 2 до 60 символов");
  if (fullName.length < 3 || fullName.length > 80) throw new CompanyError("Укажите ваше ФИО");
  const me = (await db`SELECT company_id, status, admin_level FROM employees WHERE uid = ${owner.uid}`)[0];
  if (me?.company_id) {
    throw new CompanyError(me.admin_level === "owner" ? "У вас уже есть компания" : "Сначала выйдите из текущей компании в профиле");
  }
  // Партнёрская ссылка (этап 5): пока запоминаем только id пригласившего, если он передан числом
  const referrer = data.ref && /^\d{1,15}$/.test(data.ref) ? Number(data.ref) : null;
  const [c] = await db`INSERT INTO companies(name, owner_uid, invite_code, bind_code, referred_by)
    VALUES(${name}, ${owner.uid}, ${newCode()}, ${newCode(12)}, ${referrer}) RETURNING *`;
  const company = norm(c)!;
  await db`UPDATE employees SET company_id = ${company.id}, admin_level = 'owner', status = 'active', role = NULL,
      full_name = ${fullName}, city = ${data.city?.trim() || null}, phone = COALESCE(${data.phone ?? null}, phone),
      approved_at = now(), approved_by = ${owner.uid}, registered_at = now(), joined_at = now(), work_start = NULL, salary_monthly = NULL
    WHERE uid = ${owner.uid}`;
  await seedDefaults(company.id);
  await withCompany(company.id, () => audit(owner.uid, "company.create", { id: company.id, name }));
  return company;
}

/** Заявка сотрудника в компанию по ссылке-приглашению */
export async function joinCompany(
  uid: number,
  code: string,
  data: { fullName: string; city?: string; phone?: string; role: Role },
): Promise<{ company: Company; status: string }> {
  const company = await companyByInvite(code);
  if (!company) throw new CompanyError("Ссылка-приглашение недействительна. Попросите у руководителя новую.");
  const me = (await db`SELECT company_id, status, admin_level FROM employees WHERE uid = ${uid}`)[0];
  if (me?.company_id && Number(me.company_id) !== company.id) throw new CompanyError("Вы состоите в другой компании. Сначала выйдите из неё в профиле.");
  if (me?.company_id && Number(me.company_id) === company.id && (me.status === "active" || me.status === "pending")) {
    throw new CompanyError(me.status === "active" ? "Вы уже в этой команде" : "Заявка уже отправлена, дождитесь решения руководителя");
  }
  if (!["qualifier", "recruiter"].includes(data.role)) throw new CompanyError("Выберите роль");
  const fullName = (data.fullName ?? "").trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 80) throw new CompanyError("Укажите ФИО");
  await db`UPDATE employees SET company_id = ${company.id}, role = ${data.role}, status = 'pending', admin_level = NULL,
      full_name = ${fullName}, city = ${data.city?.trim() || null}, phone = COALESCE(${data.phone ?? null}, phone),
      registered_at = now(), approved_at = NULL, approved_by = NULL, joined_at = now(), work_start = NULL, salary_monthly = NULL
    WHERE uid = ${uid}`;
  await withCompany(company.id, () => audit(uid, "company.join", { company: company.id, role: data.role }));
  return { company, status: "pending" };
}

/** Сотрудник сам выходит из компании. История отчётов и выплат остаётся у компании. */
export async function leaveCompany(uid: number): Promise<void> {
  const me = (await db`SELECT company_id, admin_level FROM employees WHERE uid = ${uid}`)[0];
  if (!me?.company_id) throw new CompanyError("Вы не состоите в компании");
  const c = await getCompany(Number(me.company_id));
  if (c && c.owner_uid === uid) throw new CompanyError("Владелец не может выйти из своей компании");
  await withCompany(Number(me.company_id), () => audit(uid, "company.leave", {}));
  await db`UPDATE employees SET company_id = NULL, role = NULL, status = 'new', admin_level = NULL,
      approved_at = NULL, approved_by = NULL, work_start = NULL, salary_monthly = NULL WHERE uid = ${uid}`;
}

export async function renameCompany(id: number, name: string, actor: number) {
  name = (name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) throw new CompanyError("Название компании — от 2 до 60 символов");
  await db`UPDATE companies SET name = ${name} WHERE id = ${id}`;
  await withCompany(id, () => audit(actor, "company.rename", { name }));
}

/** Новая ссылка-приглашение: старая перестаёт работать */
export async function resetInvite(id: number, actor: number): Promise<string> {
  const code = newCode();
  await db`UPDATE companies SET invite_code = ${code} WHERE id = ${id}`;
  await withCompany(id, () => audit(actor, "company.invite_reset", {}));
  return code;
}

/** Привязать рабочий чат по коду из ссылки «Подключить чат». Привязать может только админ этой компании. */
export async function bindGroup(code: string, chat: { id: number; title?: string }, actorUid: number): Promise<Company | null> {
  const c = norm((await db`SELECT * FROM companies WHERE bind_code = ${code}`)[0]);
  if (!c) return null;
  const me = (await db`SELECT company_id, admin_level FROM employees WHERE uid = ${actorUid}`)[0];
  if (!me || Number(me.company_id) !== c.id || !me.admin_level) throw new CompanyError("Подключить чат может только руководитель компании");
  await db`UPDATE companies SET group_id = NULL, group_title = NULL WHERE group_id = ${chat.id} AND id <> ${c.id}`;
  await db`UPDATE companies SET group_id = ${chat.id}, group_title = ${chat.title ?? null} WHERE id = ${c.id}`;
  await withCompany(c.id, () => audit(actorUid, "company.bind_group", { chat: chat.id }));
  return { ...c, group_id: chat.id, group_title: chat.title ?? null };
}

/**
 * Перенос однокомпанийной версии: все существующие данные — в компанию № 1.
 * Владелец — первый из ADMIN_IDS, рабочий чат — GROUP_ID, менеджеры — APPROVER_USERNAMES.
 * Срабатывает один раз, когда компаний ещё нет, а данные уже есть.
 */
export async function bootstrapLegacy(): Promise<number | null> {
  const has = await db`SELECT 1 FROM companies LIMIT 1`;
  if (has.length) return null;
  const data = await db`SELECT (SELECT COUNT(*) FROM employees)::int AS e, (SELECT COUNT(*) FROM reports)::int AS r`;
  if (!data[0].e && !data[0].r) return null;
  const owner = config.adminIds[0];
  if (!owner) {
    console.warn("[companies] есть данные, но не задан ADMIN_IDS — перенос в компанию № 1 пропущен");
    return null;
  }
  const name = Bun.env.COMPANY_NAME || "Моя команда";
  const [c] = await db`INSERT INTO companies(name, owner_uid, invite_code, bind_code, group_id, legacy)
    VALUES(${name}, ${owner}, ${newCode()}, ${newCode(12)}, ${config.groupId || null}, TRUE) RETURNING id`;
  const id = Number(c.id);
  for (const t of ["reports", "accruals", "payments", "payment_audit", "directions", "bonus_rules", "promotions", "stories", "salary_overrides", "audit_log"]) {
    await db.unsafe(`UPDATE "${t}" SET company_id = $1 WHERE company_id IS NULL`, [id]);
  }
  await db`UPDATE employees SET company_id = ${id}, joined_at = COALESCE(approved_at, registered_at, created_at)
    WHERE company_id IS NULL AND status IN ('active', 'pending')`;
  for (const uid of config.adminIds) {
    await db`INSERT INTO employees(uid, name, status) VALUES(${uid}, '', 'active') ON CONFLICT(uid) DO NOTHING`;
    await db`UPDATE employees SET company_id = ${id}, admin_level = 'owner',
      status = CASE WHEN status IN ('active','pending') THEN status ELSE 'active' END WHERE uid = ${uid}`;
  }
  if (config.approverUsernames.length) {
    await db`UPDATE employees SET company_id = ${id}, admin_level = 'manager',
      status = CASE WHEN status IN ('active','pending') THEN status ELSE 'active' END
      WHERE lower(username) = ANY(${"{" + config.approverUsernames.join(",") + "}"}::text[]) AND admin_level IS NULL`;
  }
  await db`UPDATE settings SET key = ${"company:" + id} WHERE key = 'main'`;
  console.log(`[companies] данные перенесены в компанию № ${id} «${name}»`);
  return id;
}

/**
 * Совместимость с однокомпанийной версией: менеджер из APPROVER_USERNAMES или владелец из ADMIN_IDS,
 * впервые открывший бота, попадает в перенесённую компанию № 1 со своими правами.
 */
export async function legacyClaim(e: { uid: number; username: string | null; company_id: number | null }): Promise<boolean> {
  if (e.company_id) return false;
  const uname = (e.username ?? "").toLowerCase();
  const level = config.adminIds.includes(e.uid) ? "owner" : uname && config.approverUsernames.includes(uname) ? "manager" : null;
  if (!level) return false;
  const legacy = (await db`SELECT id FROM companies WHERE legacy AND status = 'active' ORDER BY id LIMIT 1`)[0];
  if (!legacy) return false;
  // Повторно не забираем: если человек сам вышел из компании, ADMIN_IDS не возвращает его обратно
  const left = await db`SELECT 1 FROM audit_log WHERE actor = ${e.uid} AND action = 'company.leave' LIMIT 1`;
  if (left.length) return false;
  await db`UPDATE employees SET company_id = ${legacy.id}, admin_level = ${level}, status = 'active', joined_at = now() WHERE uid = ${e.uid}`;
  return true;
}
