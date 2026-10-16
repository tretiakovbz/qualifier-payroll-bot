// Точка входа: HTTP-сервер с вебхуком Telegram, API и Mini App.

import { config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { handleUpdate } from "./bot/updates.ts";
import { statsHandler, remindersHandler } from "./api/routes.ts";
import { handleApiV2 } from "./api/v2.ts";
import { startScheduler } from "./core/scheduler.ts";
import { setupTelegram } from "./bot/setup.ts";
import { ensureDatabase, cloneData } from "./db/clone.ts";
import { api } from "./lib/telegram.ts";

const miniApp = Bun.file(new URL("./miniapp/index.html", import.meta.url));
const adminJs = Bun.file(new URL("./miniapp/admin.js", import.meta.url));

const cloneFrom = Bun.env.CLONE_FROM_DATABASE_URL ?? "";
if (config.databaseUrl) {
  if (cloneFrom) await ensureDatabase(config.databaseUrl, cloneFrom);
  await migrate();
  if (cloneFrom) await cloneData((await import("./db/client.ts")).db, cloneFrom);
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

    if (url.pathname === "/admin.js" && req.method === "GET") {
      return new Response(adminJs, { headers: { "content-type": "text/javascript;charset=utf-8", "cache-control": "no-store" } });
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

// Имя бота берём у Telegram — так ссылки верны и у тестового бота
if (config.botToken) {
  api("getMe", {}).then((r: any) => { if (r?.result?.username) config.botUsername = r.result.username; console.log("[telegram] бот @" + config.botUsername); }).catch(() => {});
}
startScheduler();
if (config.liveMode || Bun.env.ROLLBACK_TO_V1 === "1") setupTelegram().catch((e) => console.error("[telegram] настройка не удалась", e));
console.log(`[start] ${config.serviceName} ${config.version} on :${server.port}`);
