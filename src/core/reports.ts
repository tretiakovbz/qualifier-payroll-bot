// Отчёты сотрудников: сохранение, подтверждение, список на проверку.

import { db } from "../db/client.ts";
import { cid } from "./tenant.ts";
import { audit } from "../db/audit.ts";
import type { ReportMetrics, Role } from "../lib/report.ts";
import { reconcileReports } from "./accruals.ts";
import { notify } from "./notify.ts";

export type ReportStatus = "pending" | "approved" | "rejected";

export async function saveReport(r: { chat: number; msg: number; uid: number; name: string; day: string; role: Role; metrics: ReportMetrics }) {
  const n = r.role === "qualifier" ? r.metrics.forms ?? 0 : r.metrics.contracts ?? 0;
  await db`
    INSERT INTO reports(chat, msg, uid, name, n, day, status, role, metrics, company_id)
    VALUES(${r.chat}, ${r.msg}, ${r.uid}, ${r.name}, ${n}, ${r.day}, 'pending', ${r.role}, ${JSON.stringify(r.metrics)}::text::jsonb, ${cid()})
    ON CONFLICT(chat, msg) DO UPDATE SET n = excluded.n, name = excluded.name, role = excluded.role,
      metrics = excluded.metrics, status = 'pending', reviewed_by = NULL, reviewed_at = NULL`;
  // Изменённый после подтверждения отчёт снова ждёт проверки — деньги за него снимаются до повторного подтверждения
  await reconcileReports();
}

/** Сменить статус отчёта. chat — рабочий чат, где он написан (по умолчанию — чат текущей компании). */
export async function setReportStatus(msg: number, status: ReportStatus, actor: number | null, reason?: string) {
  const rows = await db`
    UPDATE reports SET status = ${status}, reviewed_by = ${actor}, reviewed_at = now(), reject_reason = ${reason ?? null}
    WHERE company_id = ${cid()} AND msg = ${msg} AND status <> ${status}
    RETURNING uid, day, role`;
  if (!rows[0]) return false;
  await audit(actor, `report.${status}`, { msg, reason });
  await reconcileReports();
  if (status === "rejected") {
    await notify(Number(rows[0].uid), {
      kind: "rejected",
      title: "Отчёт не подтверждён",
      body: reason ? `Причина: ${reason}` : "Уточните детали у админа",
    });
  }
  return true;
}

export async function listReports(opts: { status?: ReportStatus; role?: Role; limit?: number } = {}) {
  const rows = await db`
    SELECT r.msg, r.uid, r.day::text AS day, r.status, r.role, r.metrics, r.n, r.created_at,
      COALESCE(e.full_name, r.name) AS name, e.photo_url, COALESCE(e.status, 'new') AS employee_status,
      a.amount AS accrued
    FROM reports r
    LEFT JOIN employees e ON e.uid = r.uid
    LEFT JOIN accruals a ON a.dedupe_key = 'report:' || r.chat || ':' || r.msg AND a.cancelled_at IS NULL
    WHERE r.company_id = ${cid()}
    ORDER BY r.day DESC, r.msg DESC
    LIMIT ${opts.limit ?? 200}`;
  return rows.filter((r: any) => (!opts.status || r.status === opts.status) && (!opts.role || r.role === opts.role));
}

export async function pendingCount(): Promise<number> {
  const rows = await db`SELECT COUNT(*)::int AS n FROM reports WHERE company_id = ${cid()} AND status = 'pending'`;
  return rows[0].n;
}
