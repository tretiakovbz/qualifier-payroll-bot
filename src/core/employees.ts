// Сотрудники: регистрация, роли, статусы, права админов.

import { db } from "../db/client.ts";
import { audit, json } from "../db/audit.ts";
import { config } from "../config.ts";
import type { Role } from "../lib/report.ts";
import { today } from "../lib/time.ts";

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
  if (e) for (const k of ["uid", "approved_by"]) if (e[k] !== null && e[k] !== undefined) (e as any)[k] = Number(e[k]);
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
  return norm(rows[0]);
}

/** Уровень админа: владелец из ADMIN_IDS, менеджер — из базы или APPROVER_USERNAMES */
export function adminLevelOf(e: { uid?: number; id?: number; username?: string | null; admin_level?: string | null } | null): AdminLevel {
  if (!e) return null;
  const id = Number(e.uid ?? e.id); // BIGINT из базы может прийти строкой
  if (Number.isFinite(id) && config.adminIds.includes(id)) return "owner";
  if (e.admin_level === "owner") return "owner";
  if (e.admin_level === "manager") return "manager";
  const uname = (e.username ?? "").toLowerCase();
  if (uname && config.approverUsernames.includes(uname)) return "manager";
  return null;
}

export async function adminLevel(user: { id: number; username?: string }): Promise<AdminLevel> {
  const direct = adminLevelOf({ id: user.id, username: user.username });
  if (direct) return direct;
  const e = await getEmployee(user.id);
  return adminLevelOf(e);
}

export async function listAdmins(): Promise<number[]> {
  const rows = await db`SELECT uid, username, admin_level FROM employees WHERE admin_level IS NOT NULL OR username IS NOT NULL`;
  const fromDb = rows.filter((r: any) => adminLevelOf({ uid: Number(r.uid), username: r.username, admin_level: r.admin_level })).map((r: any) => Number(r.uid));
  return [...new Set([...config.adminIds, ...fromDb])];
}

export class RegistrationError extends Error {}

export async function register(
  uid: number,
  data: { fullName: string; phone?: string; city?: string; role: Role },
): Promise<Employee> {
  const e = await getEmployee(uid);
  if (e && (e.status === "active" || e.status === "pending") && e.role) {
    throw new RegistrationError(
      e.status === "active"
        ? "Вы уже зарегистрированы. Сменить роль может только админ."
        : "Заявка уже отправлена, дождитесь решения админа.",
    );
  }
  if (!["qualifier", "recruiter"].includes(data.role)) throw new RegistrationError("Выберите роль");
  const fullName = data.fullName.trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 80) throw new RegistrationError("Укажите ФИО");
  const rows = await db`
    INSERT INTO employees(uid, name, full_name, phone, city, role, status, registered_at)
    VALUES(${uid}, ${fullName}, ${fullName}, ${data.phone ?? null}, ${data.city?.trim() || null}, ${data.role}, 'pending', now())
    ON CONFLICT(uid) DO UPDATE SET full_name = excluded.full_name,
      phone = COALESCE(excluded.phone, employees.phone), city = excluded.city,
      role = excluded.role, status = 'pending', registered_at = now(), approved_at = NULL, approved_by = NULL
    RETURNING *`;
  return norm(rows[0]);
}

export async function setPhone(uid: number, phone: string) {
  await db`UPDATE employees SET phone = ${phone} WHERE uid = ${uid}`;
}

export async function decide(uid: number, approve: boolean, actor: number): Promise<Employee | null> {
  const rows = await db`
    UPDATE employees SET status = ${approve ? "active" : "rejected"},
      approved_at = ${approve ? new Date() : null}, approved_by = ${actor},
      work_start = ${approve ? today() : null}
    WHERE uid = ${uid} AND status = 'pending' RETURNING *`;
  if (rows[0]) await audit(actor, approve ? "employee.approve" : "employee.reject", { uid });
  return norm(rows[0]) ?? null;
}

/** Удаление профиля = архив: история отчётов и выплат остаётся, можно регистрироваться заново */
export async function archive(uid: number, actor: number) {
  await db`UPDATE employees SET status = 'archived', role = NULL, admin_level = NULL WHERE uid = ${uid}`;
  await audit(actor, "employee.archive", { uid });
}

export async function setAdminLevel(uid: number, level: "manager" | null, actor: number) {
  await db`UPDATE employees SET admin_level = ${level} WHERE uid = ${uid}`;
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
  const rows: Employee[] = await db`SELECT * FROM employees ORDER BY status, role, COALESCE(full_name, name)`;
  return rows.map(norm).filter((e) => (!filter.role || e.role === filter.role) && (!filter.status || e.status === filter.status));
}
