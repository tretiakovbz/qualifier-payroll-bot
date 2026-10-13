// HTTP API для Mini App. Все запросы подписаны initData из Telegram.

import { config, canApprove } from "../config.ts";
import { verifyInitData, type TgUser } from "../lib/telegram.ts";
import { periodBack } from "../lib/time.ts";
import { db } from "../db/client.ts";
import * as q from "../db/queries.ts";

function authUser(req: Request): TgUser | null {
  return verifyInitData(req.headers.get("X-Telegram-Init-Data") ?? "");
}

const DEMO_NAMES = ["Александр", "Мария", "Екатерина", "Дмитрий"];

export async function statsHandler(req: Request, url: URL): Promise<Response> {
  const user = authUser(req);
  if (!user) return Response.json({ error: "Требуется авторизация Telegram" }, { status: 401 });

  const isAdminUser = canApprove(user);
  const offset = Math.max(0, Math.min(24, Number(url.searchParams.get("period") ?? 0) || 0));
  const [a, b] = periodBack(offset);
  const demo = url.searchParams.get("demo") === "1";

  let rows = await q.ranking(a, b);
  if (demo) {
    rows = DEMO_NAMES.map((name, i) => ({
      name: `${name} · демо`,
      uid: -(i + 1),
      approved: offset === 0 ? 47 - i * 8 : 32 - i * 5,
      pending: i % 3,
    }));
  }
  const self = demo ? undefined : rows.find((r) => String(r.uid) === String(user.id));

  const days = demo
    ? []
    : await db`
      SELECT day::text AS day,
        COALESCE(SUM(n) FILTER (WHERE status = 'approved'), 0)::int AS approved,
        COALESCE(SUM(n) FILTER (WHERE status = 'pending'), 0)::int AS pending
      FROM reports WHERE chat = ${config.groupId} AND uid = ${user.id} AND day BETWEEN ${a} AND ${b}
      GROUP BY day ORDER BY day DESC`;

  const details =
    isAdminUser && !demo
      ? await db`
        SELECT day::text AS day, uid, MAX(name) AS name,
          COALESCE(SUM(n) FILTER (WHERE status = 'approved'), 0)::int AS approved
        FROM reports WHERE chat = ${config.groupId} AND day BETWEEN ${a} AND ${b}
        GROUP BY day, uid ORDER BY day DESC`
      : [];

  return Response.json({
    isAdmin: isAdminUser,
    demo,
    offset,
    details,
    days,
    reminders: await q.getReminders(user.id),
    start: a,
    end: b,
    total: rows.reduce((v, r) => v + r.approved, 0),
    rows: rows.map((x) => ({ name: x.name, approved: x.approved, pending: x.pending })),
    self: self ? { approved: self.approved, pending: self.pending } : { approved: 0, pending: 0 },
  });
}

export async function remindersHandler(req: Request): Promise<Response> {
  const user = authUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return Response.json({ error: "Bad preference" }, { status: 400 });
  await q.setReminders(user.id, user.first_name ?? "", body.enabled);
  return Response.json({ enabled: body.enabled });
}
