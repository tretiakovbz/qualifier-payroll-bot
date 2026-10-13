// Сквозная проверка на настоящей базе Postgres с подставным Telegram API.
// Запуск: TEST_DATABASE_URL=postgres://... bun test tests/integration.test.ts
// Без TEST_DATABASE_URL тесты пропускаются.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const DB_URL = Bun.env.TEST_DATABASE_URL;
const GROUP = -1001;
const ADMIN = 100;
const SECRET = "test-secret";

const sent: { method: string; body: any }[] = [];
let tg: ReturnType<typeof Bun.serve>;
let app: { port: number; stop: () => void } | undefined;

describe.skipIf(!DB_URL)("бот целиком", () => {
  let base = "";

  beforeAll(async () => {
    tg = Bun.serve({
      port: 0,
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop()!;
        const body = req.headers.get("content-type")?.includes("json") ? await req.json() : await req.formData();
        sent.push({ method, body });
        return Response.json({ ok: true, result: {} });
      },
    });
    Object.assign(process.env, {
      DATABASE_URL: DB_URL,
      TELEGRAM_API_BASE: `http://localhost:${tg.port}`,
      BOT_TOKEN: "1:T",
      WEBHOOK_SECRET: SECRET,
      GROUP_ID: String(GROUP),
      ADMIN_IDS: String(ADMIN),
      APPROVER_USERNAMES: "approver1",
      PORT: "0",
    });
    const { db } = await import("../../src/db/client.ts");
    await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const mod = await import("../../src/index.ts");
    app = mod.server;
    base = `http://localhost:${app!.port}`;
  });

  afterAll(() => {
    app?.stop();
    tg?.stop();
  });

  const hook = (update: unknown, secret = SECRET) =>
    fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update),
    });

  const now = Math.floor(Date.now() / 1000);
  const anna = { id: 7, first_name: "Анна", last_name: "Смирнова" };

  test("health", async () => {
    const r = await (await fetch(`${base}/health`)).json();
    expect(r.ok).toBe(true);
  });

  test("вебхук без секрета отклоняется", async () => {
    expect((await hook({}, "wrong")).status).toBe(403);
  });

  test("отчёт принимается и бот отвечает в чате", async () => {
    sent.length = 0;
    const r = await hook({
      message: { message_id: 1, date: now, chat: { id: GROUP, type: "supergroup" }, from: anna, text: "#отчет\nОбработано недозвонов: 50\nАнкет собрано: 5" },
    });
    expect(r.status).toBe(200);
    const reply = sent.find((s) => s.method === "sendMessage");
    expect(reply?.body.chat_id).toBe(GROUP);
    expect(reply?.body.reply_to_message_id).toBe(1);
  });

  test("подтверждение реакцией и /me", async () => {
    await hook({ message_reaction: { chat: { id: GROUP }, message_id: 1, user: { id: 555, username: "Approver1" }, new_reaction: [{ type: "emoji", emoji: "👍" }] } });
    sent.length = 0;
    await hook({ message: { message_id: 2, date: now, chat: { id: 7, type: "private" }, from: anna, text: "/me" } });
    const msg = sent.find((s) => s.method === "sendMessage")!;
    expect(msg.body.text).toContain("Подтверждено: 5");
    expect(msg.body.text.replace(/\s/g, " ")).toContain("2 500 ₽");
  });

  test("реакция постороннего ничего не меняет", async () => {
    await hook({ message: { message_id: 3, date: now, chat: { id: GROUP, type: "supergroup" }, from: anna, text: "#отчет\nАнкет собрано: 2" } });
    await hook({ message_reaction: { chat: { id: GROUP }, message_id: 3, user: { id: 999, username: "stranger" }, new_reaction: [{ type: "emoji", emoji: "👍" }] } });
    sent.length = 0;
    await hook({ message: { message_id: 4, date: now, chat: { id: 7, type: "private" }, from: anna, text: "/me" } });
    expect(sent[0].body.text).toContain("Подтверждено: 5");
  });

  test("ведомость: настоящие переносы строк", async () => {
    sent.length = 0;
    await hook({ message: { message_id: 5, date: now, chat: { id: GROUP, type: "supergroup" }, from: { id: ADMIN, first_name: "Босс" }, text: "/payroll" } });
    const text: string = sent[0].body.text;
    expect(text).not.toContain("\\n");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(text).toContain("Анна Смирнова: 5 × 500");
  });

  test("CSV-выгрузка с BOM", async () => {
    sent.length = 0;
    await hook({ message: { message_id: 6, date: now, chat: { id: ADMIN, type: "private" }, from: { id: ADMIN, first_name: "Босс" }, text: "/export" } });
    const doc = sent.find((s) => s.method === "sendDocument")!;
    const file = (doc.body as FormData).get("document") as File;
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("\r\n");
    expect(text).not.toContain("\\r\\n");
  });

  test("API статистики без подписи — 401", async () => {
    expect((await fetch(`${base}/api/stats`)).status).toBe(401);
  });
});
