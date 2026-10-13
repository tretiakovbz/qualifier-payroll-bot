// Отчёты сотрудников: сохранение, подтверждение, список на проверку.

import { db } from "../db/client.ts";
import { config } from "../config.ts";
import { audit } from "../db/audit.ts";
import type { ReportMetrics, Role } from "../lib/report.ts";
import { reconcileReports } from "./accruals.ts";
import { notify } from "./notify.ts";

export type ReportStatus = "pending" | "approved" | "rejected";

export async function saveReport(r: { msg: number; uid: number; name: string; day: string; role: Role; metrics: ReportMetrics }) {
  const n = r.role === "qualifier" ? r.metrics.forms ?? 0 : r.metrics.contracts ?? 0;
  await db`
    INSERT INTO reports(chat, msg, uid, name, n, day, status, role, metrics)
    VALUES(${config.groupId}, ${r.msg}, ${r.uid}, ${r.name}, ${n}, ${r.day}, 'pending', ${r.role}, ${JSON.stringify(r.metrics)}::text::jsonb)
    ON CONFLICT(chat, msg) DO UPDATE SET n = excluded.n, name = excluded.name, role = excluded.role,
      metrics = excluded.metrics, status = 'pending', reviewed_by = NULL, reviewed_at = NULL`;
  // Изменённый после подтверждения отчёт снова ждёт проверки — деньги за него снимаются до повторного подтверждения
  await reconcileReports();
}

export async function setReportStatus(msg: number, status: ReportStatus, actor: number | null, reason?: string) {
  const rows = await db`
    UPDATE reports SET status = ${status}, reviewed_by = ${actor}, reviewed_at = now(), reject_reason = ${reason ?? null}
    WHERE chat = ${config.groupId} AND msg = ${msg} AND status <> ${status}
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
      COALESCE(e.full_name, r.name) AS name, e.photo_url,
      a.amount AS accrued
    FROM reports r
    LEFT JOIN employees e ON e.uid = r.uid
    LEFT JOIN accruals a ON a.dedupe_key = 'report:' || r.chat || ':' || r.msg AND a.cancelled_at IS NULL
    WHERE r.chat = ${config.groupId}
    ORDER BY r.day DESC, r.msg DESC
    LIMIT ${opts.limit ?? 200}`;
  return rows.filter((r: any) => (!opts.status || r.status === opts.status) && (!opts.role || r.role === opts.role));
}

export async function pendingCount(): Promise<number> {
  const rows = await db`SELECT COUNT(*)::int AS n FROM reports WHERE chat = ${config.groupId} AND status = 'pending'`;
  return rows[0].n;
}
