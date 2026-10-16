// Сотрудники: регистрация, роли, статусы, права админов.

import { db } from "../db/client.ts";
import { audit, json } from "../db/audit.ts";
import type { Role } from "../lib/report.ts";
import { today } from "../lib/time.ts";
import { cid, tryCid } from "./tenant.ts";
import { legacyClaim } from "./companies.ts";

/** new — написал боту, но не регистрировался; pending — заявка у админа */
export type Status = "new" | "pending" | "active" | "rejected" | "archived";
export type AdminLevel = "owner" | "manager" | null;

export interface Employee {
  uid: number;
  name: string;
  full_name: string | null;
  role: Role | null;
  status: Status;
  phone: string | null;
  city: string | null;
  username: string | null;
  photo_url: string | null;
  admin_level: string | null;
  can_dm: boolean;
  reminders: boolean;
  reply_idx: number;
  prefs: Prefs;
  registered_at: string | null;
  approved_at: string | null;
  salary_monthly: number | null;
  work_start: string | Date | null;
  company_id: number | null;
}

export interface Prefs {
  theme?: "system" | "day" | "night" | "military" | "funny";
  sounds?: boolean;
  haptics?: boolean;
  reminderTime?: string; // "19:30"
  notify?: { approved?: boolean; bonus?: boolean; payout?: boolean; promo?: boolean; reminder?: boolean };
}

export function displayName(e: Pick<Employee, "full_name" | "name">): string {
  return e.full_name || e.name || "Сотрудник";
}

/** Postgres отдаёт BIGINT строкой — приводим id к числу, иначе сравнения uid === id ломаются */
function norm<T extends Record<string, any> | undefined>(e: T): T {
  if (e) for (const k of ["uid", "approved_by", "company_id"]) if (e[k] !== null && e[k] !== undefined) (e as any)[k] = Number(e[k]);
  return e;
}

export async function getEmployee(uid: number): Promise<Employee | null> {
  const rows = await db`SELECT * FROM employees WHERE uid = ${uid}`;
  return norm(rows[0]) ?? null;
}

/** Обновляет имя/ник/фото из Telegram, создаёт запись, если её нет */
export async function touch(
  u: { id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string },
  opts: { canDm?: boolean } = {},
): Promise<Employee> {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  const rows = await db`
    INSERT INTO employees(uid, name, username, photo_url, can_dm, status)
    VALUES(${u.id}, ${name}, ${u.username ?? null}, ${u.photo_url ?? null}, ${opts.canDm ?? false}, 'new')
    ON CONFLICT(uid) DO UPDATE SET
      name = excluded.name,
      username = COALESCE(excluded.username, employees.username),
      photo_url = COALESCE(excluded.photo_url, employees.photo_url),
      can_dm = employees.can_dm OR excluded.can_dm
    RETURNING *`;
  const e = norm(rows[0]);
  if (!e.company_id && (await legacyClaim(e))) return (await getEmployee(e.uid))!;
  return e;
}

/** Уровень админа в своей компании: владелец или менеджер (хранится в базе) */
export function adminLevelOf(e: { admin_level?: string | null; company_id?: number | null } | null): AdminLevel {
  if (!e || !e.company_id) return null;
  if (e.admin_level === "owner") return "owner";
  if (e.admin_level === "manager") return "manager";
  return null;
}

/** Уровень админа пользователя в текущей компании запроса */
export async function adminLevel(user: { id: number; username?: string }): Promise<AdminLevel> {
  const e = await getEmployee(user.id);
  if (!e) return null;
  const c = tryCid();
  if (c !== null && e.company_id !== c) return null;
  return adminLevelOf(e);
}

/** Админы текущей компании — им уходят заявки */
export async function listAdmins(): Promise<number[]> {
  const rows = await db`SELECT uid FROM employees WHERE company_id = ${cid()} AND admin_level IS NOT NULL`;
  return rows.map((r: any) => Number(r.uid));
}

export class RegistrationError extends Error {}

export async function setPhone(uid: number, phone: string) {
  await db`UPDATE employees SET phone = ${phone} WHERE uid = ${uid}`;
}

export async function decide(uid: number, approve: boolean, actor: number): Promise<Employee | null> {
  const rows = await db`
    UPDATE employees SET status = ${approve ? "active" : "rejected"},
      approved_at = ${approve ? new Date() : null}, approved_by = ${actor},
      work_start = ${approve ? today() : null}
    WHERE uid = ${uid} AND status = 'pending' AND company_id = ${cid()} RETURNING *`;
  if (rows[0]) await audit(actor, approve ? "employee.approve" : "employee.reject", { uid });
  return norm(rows[0]) ?? null;
}

/** Удалить из команды: история отчётов и выплат остаётся у компании, человек может вступить куда угодно заново */
export async function archive(uid: number, actor: number) {
  await db`UPDATE employees SET company_id = NULL, status = 'new', role = NULL, admin_level = NULL,
    approved_at = NULL, approved_by = NULL, work_start = NULL, salary_monthly = NULL
    WHERE uid = ${uid} AND company_id = ${cid()} AND admin_level IS DISTINCT FROM 'owner'`;
  await audit(actor, "employee.archive", { uid });
}

export async function setAdminLevel(uid: number, level: "manager" | null, actor: number) {
  await db`UPDATE employees SET admin_level = ${level} WHERE uid = ${uid} AND company_id = ${cid()} AND admin_level IS DISTINCT FROM 'owner'`;
  await audit(actor, "employee.admin", { uid, level });
}

export async function updatePrefs(uid: number, patch: Prefs): Promise<Prefs> {
  const rows = await db`UPDATE employees SET prefs = prefs || ${json(patch)}::text::jsonb WHERE uid = ${uid} RETURNING prefs`;
  const prefs = rows[0]?.prefs ?? {};
  if (patch.notify && typeof patch.notify.reminder === "boolean") {
    await db`UPDATE employees SET reminders = ${patch.notify.reminder} WHERE uid = ${uid}`;
  }
  return prefs;
}

export async function listEmployees(filter: { role?: Role; status?: Status } = {}): Promise<Employee[]> {
  const rows: Employee[] = await db`SELECT * FROM employees WHERE company_id = ${cid()} ORDER BY status, role, COALESCE(full_name, name)`;
  return rows.map(norm).filter((e) => (!filter.role || e.role === filter.role) && (!filter.status || e.status === filter.status));
}
