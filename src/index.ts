// Точка входа: HTTP-сервер с вебхуком Telegram, API и Mini App.

import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { handleUpdate } from "./bot/updates.ts";
import { statsHandler, remindersHandler } from "./api/routes.ts";
import { handleApiV2 } from "./api/v2.ts";
import { startScheduler } from "./core/scheduler.ts";

const miniApp = Bun.file(new URL("./miniapp/index.html", import.meta.url));

if (config.databaseUrl) {
  await migrate();
  // Короткая сводка в лог: сколько кого и сколько начислено (без личных данных)
  const { db } = await import("./db/client.ts");
  const staff = await db`SELECT COALESCE(role, '—') AS role, status, COUNT(*)::int AS n FROM employees GROUP BY 1, 2 ORDER BY 1, 2`;
  const money = await db`SELECT kind, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::int AS sum FROM accruals WHERE cancelled_at IS NULL GROUP BY kind ORDER BY kind`;
  console.log("[start] staff", JSON.stringify(staff.map((r: any) => `${r.role}/${r.status}: ${r.n}`)));
  console.log("[start] accruals", JSON.stringify(money.map((r: any) => `${r.kind}: ${r.n} шт, ${r.sum} ₽`)));
} else {
  console.warn("[start] DATABASE_URL не задан — миграции пропущены");
}

export const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: config.serviceName, version: config.version });
    }

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(miniApp, {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
      });
    }

    const v2 = await handleApiV2(req, url);
    if (v2) return v2;

    if (url.pathname === "/api/stats" && req.method === "GET") return statsHandler(req, url);
    if (url.pathname === "/api/reminders" && req.method === "POST") return remindersHandler(req);

    if (url.pathname === "/telegram/webhook" && req.method === "POST") {
      // Без настроенного секрета вебхук не принимается вообще
      if (!config.webhookSecret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== config.webhookSecret) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        await handleUpdate(await req.json());
        return Response.json({ ok: true });
      } catch (e) {
        console.error("[webhook]", e);
        return Response.json({ error: "retry" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

startScheduler();
console.log(`[start] ${config.serviceName} ${config.version} on :${server.port}`);
