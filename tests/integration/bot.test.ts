// Сквозная проверка v2 на настоящей базе Postgres с подставным Telegram API.
// Запуск: TEST_DATABASE_URL=postgres://... bun run test:integration   (база очищается!)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

const DB_URL = Bun.env.TEST_DATABASE_URL;
const GROUP = -1001;
const OWNER = 100;
const MANAGER = 555; // ник approver1
const TOKEN = "1:T";
const SECRET = "test-secret";

const sent: { method: string; body: any }[] = [];
let tg: ReturnType<typeof Bun.serve>;
let app: { port: number; stop: () => void } | undefined;
let base = "";
let M: any = {}; // модули приложения после импорта

function initData(user: Record<string, unknown>) {
  const params: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) };
  const check = Object.entries(params).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

const ANNA = { id: 7, first_name: "Анна", last_name: "Смирнова" }; // квалификатор из v1
const MARIA = { id: 9, first_name: "Мария" }; // второй квалификатор из v1
const IGOR = { id: 8, first_name: "Игорь", username: "igor_r" }; // новый рекрутер
const STRANGER = { id: 77, first_name: "Гость" };

describe.skipIf(!DB_URL)("бот v2 целиком", () => {
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
      BOT_TOKEN: TOKEN,
      WEBHOOK_SECRET: SECRET,
      GROUP_ID: String(GROUP),
      ADMIN_IDS: String(OWNER),
      APPROVER_USERNAMES: "approver1",
      PUBLIC_URL: "https://app.example",
      LIVE_MODE: "1",
      SCHEDULER: "0",
      PORT: "0",
    });
    const { db } = await import("../../src/db/client.ts");
    await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

    // База в состоянии v1: два квалификатора, подтверждённые и неподтверждённые отчёты
    const { migrate } = await import("../../src/db/migrate.ts");
    const { migrations } = await import("../../src/db/migrations.ts");
    await migrate(db, migrations.slice(0, 1));
    // 100 — владелец: писал боту в v1, но отчётов не сдавал — квалификатором стать не должен
    await db`INSERT INTO employees(uid, name, can_dm) VALUES(7, 'Анна Смирнова', TRUE), (9, 'Мария', TRUE), (100, 'Босс', TRUE)`;
    await db`INSERT INTO reports(chat, msg, uid, name, n, day, status) VALUES
      (${GROUP}, 1, 7, 'Анна Смирнова', 4, '2026-10-06', 'approved'),
      (${GROUP}, 2, 7, 'Анна Смирнова', 3, '2026-10-07', 'pending'),
      (${GROUP}, 3, 9, 'Мария', 2, '2026-09-25', 'approved')`;

    const mod = await import("../../src/index.ts");
    app = mod.server;
    base = `http://localhost:${app!.port}`;
    M.db = db;
    M.settings = await import("../../src/core/settings.ts");
    M.accruals = await import("../../src/core/accruals.ts");
    M.salary = await import("../../src/core/salary.ts");
    M.bonuses = await import("../../src/core/bonuses.ts");
    M.time = await import("../../src/lib/time.ts");
    await M.settings.updateSettings({ startDate: "2000-01-01" }, OWNER);
  }, 30_000);

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
  const api = (path: string, user: any, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "X-Telegram-Init-Data": initData(user), ...(init.headers ?? {}) },
    });
  const now = Math.floor(Date.now() / 1000);
  let msgId = 100;
  const groupMsg = (from: any, text: string, id = ++msgId) => ({ message: { message_id: id, date: now, chat: { id: GROUP, type: "supergroup" }, from, text } });
  const privateMsg = (from: any, text: string) => ({ message: { message_id: ++msgId, date: now, chat: { id: from.id, type: "private" }, from, text } });
  const react = (user: any, id: number, emoji = "👍") => ({ message_reaction: { chat: { id: GROUP }, message_id: id, user, new_reaction: emoji ? [{ type: "emoji", emoji }] : [] } });
  // неразрывные пробелы в суммах заменяем обычными, чтобы сравнивать текст
  const lastText = (chatId?: number) => ([...sent].reverse().find((s) => s.method === "sendMessage" && (chatId === undefined || s.body.chat_id === chatId))?.body.text as string | undefined)?.replace(/\u00a0/g, " ");
  const activeSum = async (uid: number, kind?: string) =>
    (await M.db`SELECT COALESCE(SUM(amount),0)::int AS s FROM accruals WHERE uid = ${uid} AND cancelled_at IS NULL AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})`)[0].s;

  test("перенос v1: сотрудники стали квалификаторами, подтверждённые анкеты — начислениями", async () => {
    const e = await M.db`SELECT uid, role, status FROM employees ORDER BY uid`;
    expect(e.map((r: any) => [Number(r.uid), r.role, r.status])).toEqual([[7, "qualifier", "active"], [9, "qualifier", "active"], [100, null, "new"]]);
    expect(await activeSum(7, "form")).toBe(2000); // 4 анкеты × 500, неподтверждённый не засчитан
    const maria = await M.db`SELECT period_start::text AS p FROM accruals WHERE uid = 9`;
    expect(maria[0].p).toBe("2026-09-20"); // 25 сентября → период 20.09–04.10
  });

  test("вебхук без секрета закрыт", async () => {
    expect((await hook({}, "wrong")).status).toBe(403);
  });

  let annaFive = 0;
  test("отчёт квалификатора: человеческий ответ без цифр", async () => {
    sent.length = 0;
    await hook(groupMsg(ANNA, "#отчет\nОбработано недозвонов: 102\nАнкет собрано: 5"));
    annaFive = msgId;
    const t = lastText(GROUP)!;
    expect(t).toBeTruthy();
    expect(t).not.toMatch(/\d/);
  });

  test("нулевой отчёт — мягкая фраза", async () => {
    sent.length = 0;
    await hook(groupMsg(MARIA, "#отчет\nОбработано недозвонов: 0\nАнкет собрано: 0"));
    const { PHRASES } = await import("../../src/lib/phrases.ts");
    expect(PHRASES.zero).toContain(lastText(GROUP));
  });

  test("подтверждение 👍 менеджером → начисление и уведомление", async () => {
    const id = annaFive;
    sent.length = 0;
    await hook(react({ id: MANAGER, username: "Approver1" }, id));
    expect(await activeSum(7, "form")).toBe(4500);
    expect(lastText(7)).toContain("2 500");
    const n = await M.db`SELECT title FROM notifications WHERE uid = 7 AND kind = 'approved'`;
    expect(n.length).toBe(1);
  });

  test("реакция постороннего ничего не меняет", async () => {
    await hook(groupMsg(ANNA, "#отчет\nОбработано недозвонов: 10\nАнкет собрано: 2"));
    await hook(react(STRANGER, msgId));
    expect(await activeSum(7, "form")).toBe(4500);
  });

  test("правка подтверждённого отчёта снимает деньги до повторного подтверждения", async () => {
    const id = annaFive;
    await hook({ edited_message: { message_id: id, date: now, chat: { id: GROUP, type: "supergroup" }, from: ANNA, text: "#отчет\nОбработано недозвонов: 102\nАнкет собрано: 6" } });
    expect(await activeSum(7, "form")).toBe(2000);
    await hook(react({ id: OWNER }, id));
    expect(await activeSum(7, "form")).toBe(5000);
  });

  test("незарегистрированный: отчёт сохранён, подсказка про регистрацию", async () => {
    sent.length = 0;
    await hook(groupMsg(STRANGER, "#отчет\nАнкет собрано: 3"));
    expect(lastText(GROUP)).toContain("зарегистрируйтесь");
    const r = await M.db`SELECT status FROM reports WHERE uid = 77`;
    expect(r[0].status).toBe("pending");
  });

  test("регистрация рекрутера: заявка админам, одобрение кнопкой, приветствие", async () => {
    await hook(privateMsg(IGOR, "/start"));
    sent.length = 0;
    const r = await api("/api/v2/register", IGOR, { method: "POST", body: JSON.stringify({ fullName: "Игорь Петров", city: "Москва", role: "recruiter" }) });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("pending");
    const toOwner = sent.find((s) => s.method === "sendMessage" && s.body.chat_id === OWNER);
    expect(toOwner?.body.text).toContain("Игорь Петров");
    expect(toOwner?.body.reply_markup.inline_keyboard[0][0].callback_data).toBe("reg:ok:8");

    // повторная заявка не принимается
    const again = await api("/api/v2/register", IGOR, { method: "POST", body: JSON.stringify({ fullName: "Игорь", role: "qualifier" }) });
    expect(again.status).toBe(400);

    sent.length = 0;
    await hook({ callback_query: { id: "cb1", from: { id: OWNER }, data: "reg:ok:8", message: { message_id: 5, date: now, chat: { id: OWNER, type: "private" } } } });
    expect(lastText(8)).toContain("одобрена");
    const e = await M.db`SELECT role, status FROM employees WHERE uid = 8`;
    expect([e[0].role, e[0].status]).toEqual(["recruiter", "active"]);
  });

  test("посторонний не может одобрять заявки", async () => {
    await M.db`INSERT INTO employees(uid, name, role, status) VALUES(78, 'X', 'qualifier', 'pending')`;
    await hook({ callback_query: { id: "cb2", from: STRANGER, data: "reg:ok:78" } });
    const e = await M.db`SELECT status FROM employees WHERE uid = 78`;
    expect(e[0].status).toBe("pending");
  });

  test("отчёт рекрутера по ТЗ: 210 000 ₽ после подтверждения", async () => {
    sent.length = 0;
    await hook(groupMsg(IGOR, "#отчет\nПолучили документы: 4\nОтправлено на ВВК: 2\nЗаключено контрактов: 3\nУфа и офицеры: 1"));
    const { PHRASES } = await import("../../src/lib/phrases.ts");
    expect(PHRASES.contract).toContain(lastText(GROUP));
    await hook(react({ id: OWNER }, msgId));
    expect(await activeSum(8, "contract")).toBe(210000);
  });

  test("отчёт не своей роли не сохраняется", async () => {
    sent.length = 0;
    await hook(groupMsg(IGOR, "#отчет\nАнкет собрано: 5"));
    expect(lastText(GROUP)).toContain("рекрутер");
    const r = await M.db`SELECT 1 FROM reports WHERE msg = ${msgId}`;
    expect(r.length).toBe(0);
  });

  test("отклонение командой /reject с причиной", async () => {
    await hook(groupMsg(ANNA, "#отчет\nАнкет собрано: 1"));
    const id = msgId;
    sent.length = 0;
    await hook({ message: { message_id: ++msgId, date: now, chat: { id: GROUP, type: "supergroup" }, from: { id: OWNER }, text: "/reject дубль", reply_to_message: { message_id: id } } });
    const r = await M.db`SELECT status, reject_reason FROM reports WHERE msg = ${id}`;
    expect([r[0].status, r[0].reject_reason]).toEqual(["rejected", "дубль"]);
    expect(lastText(7)).toContain("дубль");
  });

  test("оклад: половина месяца квалификаторам, рекрутерам выключен", async () => {
    await M.salary.ensureSalary();
    await M.salary.ensureSalary(); // повтор не задваивает
    expect(await activeSum(7, "salary")).toBe(10000);
    expect(await activeSum(9, "salary")).toBe(10000);
    expect(await activeSum(8, "salary")).toBe(0);
    expect(await activeSum(100, "salary")).toBe(0); // владелец — не сотрудник
  });

  test("оклад: первый рабочий день, свой размер, ручная сумма за период", async () => {
    const OWN = { id: OWNER };
    const cur = M.time.periodOf(M.time.today(), [5, 20]);
    const start = M.time.addDays(cur[0], 3);
    const post = (path: string, user: any, data: unknown) => api(path, user, { method: "POST", body: JSON.stringify(data) });
    // менеджер видит, но менять не может
    expect((await api("/api/v2/admin/employees/9/salary", { id: MANAGER, username: "approver1" })).status).toBe(200);
    expect((await post("/api/v2/admin/employees/9/salary", { id: MANAGER, username: "approver1" }, { workStart: start })).status).toBe(403);

    let d = await (await post("/api/v2/admin/employees/9/salary", OWN, { workStart: start })).json();
    const expected = M.salary.calcSalary(20000, cur, { startDow: 0, days: 5 }, start);
    expect(expected.prorated).not.toBeNull();
    expect(expected.amount).toBeLessThan(10000);
    expect(await activeSum(9, "salary")).toBe(expected.amount);
    const curRow = d.periods.find((p: any) => p.when === "current");
    expect(curRow.amount).toBe(expected.amount);
    expect(d.periods.find((p: any) => p.when === "next").amount).toBe(10000); // со следующего периода — полный

    // ручная сумма за текущий период
    d = await (await post("/api/v2/admin/employees/9/salary/period", OWN, { periodStart: cur[0], amount: 6000, comment: "оклад за неполный период" })).json();
    expect(await activeSum(9, "salary")).toBe(6000);
    const acc = await M.db`SELECT comment FROM accruals WHERE uid = 9 AND kind = 'salary' AND cancelled_at IS NULL`;
    expect(acc[0].comment).toBe("оклад за неполный период");
    await M.salary.ensureSalary(); // планировщик ручную сумму не перетирает
    expect(await activeSum(9, "salary")).toBe(6000);
    // свой оклад — следующий период считается от него
    d = await (await post("/api/v2/admin/employees/9/salary", OWN, { monthly: 30000 })).json();
    expect(d.individual).toBe(30000);
    expect(d.periods.find((p: any) => p.when === "next").amount).toBe(15000);
    expect(await activeSum(9, "salary")).toBe(6000);
    // вернуть расчёт
    await post("/api/v2/admin/employees/9/salary/period", OWN, { periodStart: cur[0], amount: null });
    expect(await activeSum(9, "salary")).toBe(M.salary.calcSalary(30000, cur, { startDow: 0, days: 5 }, start).amount);
    // неверный период и сумма
    expect((await post("/api/v2/admin/employees/9/salary/period", OWN, { periodStart: M.time.addDays(cur[0], 1), amount: 1 })).status).toBe(400);
    expect((await post("/api/v2/admin/employees/9/salary", OWN, { monthly: -5 })).status).toBe(400);
    // вернуть как было, чтобы не мешать следующим проверкам
    await post("/api/v2/admin/employees/9/salary", OWN, { monthly: null, workStart: null });
    expect(await activeSum(9, "salary")).toBe(10000);
    const hist = await M.db`SELECT count(*)::int AS n FROM accruals WHERE uid = 9 AND kind = 'salary' AND cancelled_at IS NOT NULL`;
    expect(hist[0].n).toBeGreaterThan(0); // прежние суммы остаются в истории отменёнными
  });

  test("главная: место в рейтинге и прогресс к бонусу считаются по своим отчётам", async () => {
    const week = M.time.weekOf(M.time.today(), { startDow: 0, days: 5 });
    await M.db`INSERT INTO reports(chat, msg, uid, name, n, day, status, role, metrics) VALUES
      (${GROUP}, 9501, 7, 'Анна', 15, ${week[0]}, 'pending', 'qualifier', '{"forms":15,"calls":40}')`;
    await M.db`UPDATE bonus_rules SET enabled = TRUE WHERE kind = 'top_metric' AND metric = 'forms' AND role = 'qualifier'`;
    const me = await (await api("/api/v2/me", ANNA)).json();
    expect(me.place.place).toBe(1);
    const g = me.goals.find((x: any) => x.metric === "forms");
    expect(g.value).toBeGreaterThanOrEqual(15);
    expect(g.isLeader).toBe(true);
    await M.db`DELETE FROM reports WHERE msg = 9501`;
    await M.db`UPDATE bonus_rules SET enabled = FALSE WHERE kind = 'top_metric'`;
  });

  test("статистика: админ выбирает команду, сотрудник видит только свою", async () => {
    const own = await (await api("/api/v2/stats/weekly?role=recruiter&metric=contracts", { id: OWNER })).json();
    expect(own.role).toBe("recruiter");
    const anna = await (await api("/api/v2/stats/weekly?role=recruiter", ANNA)).json();
    expect(anna.role).toBe("qualifier");
  });

  test("автобонус «лучший по анкетам»: порог и деление при ничьей", async () => {
    const week = ["2026-08-02", "2026-08-06"]; // неделя без других отчётов
    const d = (i: number) => M.time.addDays(week[0], i);
    await M.db`INSERT INTO reports(chat, msg, uid, name, n, day, status, role, metrics) VALUES
      (${GROUP}, 9001, 7, 'Анна', 12, ${d(0)}, 'approved', 'qualifier', '{"forms":12,"calls":50}'),
      (${GROUP}, 9002, 7, 'Анна', 10, ${d(1)}, 'approved', 'qualifier', '{"forms":10,"calls":40}'),
      (${GROUP}, 9003, 9, 'Мария', 22, ${d(2)}, 'approved', 'qualifier', '{"forms":22,"calls":20}'),
      (${GROUP}, 9004, 9, 'Мария', 30, ${d(3)}, 'pending', 'qualifier', '{"forms":30,"calls":0}')`;
    const rules = await M.bonuses.listRules();
    const forms = rules.find((r: any) => r.code === "top_forms_week");
    const r1 = await M.bonuses.evaluateRule({ ...forms, enabled: true }, week);
    expect(r1.winners.map((w: any) => [w.uid, w.amount])).toEqual([[7, 2500], [9, 2500]]); // 22 = 22, неподтверждённые не считаются
    const again = await M.bonuses.evaluateRule({ ...forms, enabled: true }, week);
    expect(again.skipped).toBe(true);

    const high = await M.bonuses.evaluateRule({ ...forms, id: 999, threshold: 50 }, week);
    expect(high.winners).toEqual([]); // порог не достигнут
  });

  test("ручной бонус «без 5 задержек»: галочка и снятие", async () => {
    const rules = await M.bonuses.listRules();
    const manual = rules.find((r: any) => r.code === "no_delays_week");
    const get = await api(`/api/v2/admin/manual/${manual.id}`, { id: MANAGER, username: "approver1" });
    const data = await get.json();
    expect(data.staff.map((s: any) => s.uid).sort()).toEqual([7, 9]); // только квалификаторы
    const key = data.key;
    let r = await api(`/api/v2/admin/manual/${manual.id}`, { id: MANAGER, username: "approver1" }, { method: "POST", body: JSON.stringify({ key, uid: 9, award: true }) });
    expect((await r.json()).staff.find((s: any) => s.uid === 9).awarded).toBe(10000);
    r = await api(`/api/v2/admin/manual/${manual.id}`, { id: MANAGER, username: "approver1" }, { method: "POST", body: JSON.stringify({ key, uid: 9, award: true }) });
    const bonusCount = await M.db`SELECT COUNT(*)::int AS n FROM accruals WHERE uid = 9 AND rule_id = ${manual.id} AND cancelled_at IS NULL`;
    expect(bonusCount[0].n).toBe(1); // повтор не задваивает
    await api(`/api/v2/admin/manual/${manual.id}`, { id: MANAGER, username: "approver1" }, { method: "POST", body: JSON.stringify({ key, uid: 9, award: false }) });
    const after = await M.db`SELECT COUNT(*)::int AS n FROM accruals WHERE uid = 9 AND rule_id = ${manual.id} AND cancelled_at IS NULL`;
    expect(after[0].n).toBe(0);
  });

  test("ручное начисление и отмена (отмена — только владелец)", async () => {
    const r = await api("/api/v2/admin/accruals", { id: MANAGER, username: "approver1" }, { method: "POST", body: JSON.stringify({ uid: 8, amount: 3000, comment: "Сложный кандидат" }) });
    expect(r.status).toBe(200);
    const acc = await r.json();
    expect(lastText(8)).toContain("Сложный кандидат");
    expect((await api(`/api/v2/admin/accruals/${acc.id}`, { id: MANAGER, username: "approver1" }, { method: "DELETE" })).status).toBe(403);
    expect((await api(`/api/v2/admin/accruals/${acc.id}`, { id: OWNER }, { method: "DELETE" })).status).toBe(200);
    expect(await activeSum(8, "manual")).toBe(0);
  });

  test("баланс сотрудника в /api/v2/me", async () => {
    const r = await (await api("/api/v2/me", IGOR)).json();
    expect(r.role).toBe("recruiter");
    expect(r.balance.accrued).toBe(210000);
    expect(r.payout.payoutDays).toEqual([5, 20]);
    expect(r.recent[0].kind).toBe("contract");
  });

  test("незарегистрированный в /api/v2/me — без денег", async () => {
    const r = await (await api("/api/v2/me", STRANGER)).json();
    expect(r.balance).toBeUndefined();
    expect(r.status).toBe("new");
    expect(r.registered).toBe(false);
  });

  test("статистика: квалификатор не видит рекрутеров", async () => {
    const r = await (await api("/api/v2/stats/weekly?metric=forms", ANNA)).json();
    expect(r.series.map((s: any) => s.uid).sort()).toEqual([7, 9]);
    expect((await api("/api/v2/stats/weekly?metric=contracts", ANNA)).status).toBe(400);
    const rec = await (await api("/api/v2/stats/weekly", IGOR)).json();
    expect(rec.series.map((s: any) => s.uid)).toEqual([8]);
  });

  test("права: сотрудник не видит админку, менеджер не меняет настройки, владелец меняет", async () => {
    expect((await api("/api/v2/admin/overview", ANNA)).status).toBe(403);
    expect((await api("/api/v2/admin/overview", { id: MANAGER, username: "approver1" })).status).toBe(200);
    expect((await api("/api/v2/admin/settings", { id: MANAGER, username: "approver1" }, { method: "PUT", body: JSON.stringify({ rates: { perForm: 1 } }) })).status).toBe(403);
    const put = await api("/api/v2/admin/settings", { id: OWNER }, { method: "PUT", body: JSON.stringify({ rates: { perForm: 600 } }) });
    expect(put.status).toBe(200);
    const got = await (await api("/api/v2/admin/settings", { id: MANAGER, username: "approver1" })).json();
    expect(got.settings.rates.perForm).toBe(600); // второй админ сразу видит изменение
    expect(got.settings.rates.contractBase).toBe(80000);
    const bad = await api("/api/v2/admin/settings", { id: OWNER }, { method: "PUT", body: JSON.stringify({ payoutDays: [20, 5] }) });
    expect(bad.status).toBe(400);
  });

  test("смена суммы бонуса владельцем", async () => {
    const rules = await M.bonuses.listRules();
    const r = rules.find((x: any) => x.code === "top_forms_week");
    const res = await api(`/api/v2/admin/rules/${r.id}`, { id: OWNER }, { method: "PUT", body: JSON.stringify({ ...r, amount: 7000, enabled: true }) });
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(7000);
  });

  test("настройки профиля сохраняются", async () => {
    const r = await api("/api/v2/me/prefs", ANNA, { method: "POST", body: JSON.stringify({ theme: "military", sounds: false, reminderTime: "18:45", notify: { bonus: false } }) });
    const p = await r.json();
    expect(p).toMatchObject({ theme: "military", sounds: false, reminderTime: "18:45", notify: { bonus: false } });
    const bad = await (await api("/api/v2/me/prefs", ANNA, { method: "POST", body: JSON.stringify({ theme: "hack", reminderTime: "99:00" }) })).json();
    expect(bad.theme).toBe("military");
  });

  test("выключенные уведомления о бонусах не приходят в личку", async () => {
    sent.length = 0;
    await api("/api/v2/admin/accruals", { id: OWNER }, { method: "POST", body: JSON.stringify({ uid: 7, amount: 1000, comment: "Тест" }) });
    expect(lastText(7)).toBeUndefined();
    const n = await M.db`SELECT COUNT(*)::int AS n FROM notifications WHERE uid = 7 AND body = 'Тест'`;
    expect(n[0].n).toBe(1); // в ленте приложения всё равно есть
  });

  test("ведомость /payroll в личке админа", async () => {
    sent.length = 0;
    await hook(privateMsg({ id: OWNER, first_name: "Босс" }, "/start"));
    await hook(privateMsg({ id: OWNER, first_name: "Босс" }, "/payroll"));
    const t = lastText(OWNER)!;
    expect(t).toContain("Ведомость");
    expect(t).toContain("Игорь Петров (рекрутер)");
    expect(t).not.toContain("\\n");
  });

  test("демо-режим доступен без авторизации, админка — нет", async () => {
    expect((await fetch(`${base}/api/v2/me?demo=1`)).status).toBe(200);
    expect((await fetch(`${base}/api/v2/stats/weekly?demo=1&role=recruiter`)).status).toBe(200);
    expect((await fetch(`${base}/api/v2/admin/overview?demo=1`)).status).toBe(401);
  });

  test("акция-множитель ×2: доплата к отчёту и снятие вместе с ним", async () => {
    const day = M.time.today();
    const mgr = await api("/api/v2/admin/promos", { id: MANAGER, username: "approver1" }, { method: "POST", body: JSON.stringify({ name: "x", kind: "multiplier", multiplier: 2, starts_on: day, ends_on: day }) });
    expect(mgr.status).toBe(403); // акции создаёт только владелец
    const r = await api("/api/v2/admin/promos", { id: OWNER }, { method: "POST", body: JSON.stringify({ name: "Анкета ×2", kind: "multiplier", role: "qualifier", multiplier: 2, starts_on: day, ends_on: day }) });
    expect(r.status).toBe(200);
    await hook(groupMsg(MARIA, "#отчет\nОбработано недозвонов: 5\nАнкет собрано: 4"));
    const id = msgId;
    await hook(react({ id: OWNER }, id));
    const rows = await M.db`SELECT kind, amount FROM accruals WHERE report_msg = ${id} AND cancelled_at IS NULL ORDER BY kind`;
    expect(rows.map((x: any) => [x.kind, x.amount])).toEqual([["form", 2400], ["promo", 2400]]); // ставка 600 после смены настроек
    await hook(react({ id: OWNER }, id, ""));
    const after = await M.db`SELECT COUNT(*)::int AS n FROM accruals WHERE report_msg = ${id} AND cancelled_at IS NULL`;
    expect(after[0].n).toBe(0);
    const bad = await api("/api/v2/admin/promos", { id: OWNER }, { method: "POST", body: JSON.stringify({ name: "y", kind: "multiplier", multiplier: 1 }) });
    expect(bad.status).toBe(400);
  });

  test("акция-порог и конкурс подводятся после окончания и не задваиваются", async () => {
    M.promos = await import("../../src/core/promos.ts");
    const owner = { id: OWNER };
    await M.db`INSERT INTO reports(chat, msg, uid, name, n, day, status, role, metrics) VALUES
      (${GROUP}, 9101, 7, 'Анна', 21, '2026-09-28', 'approved', 'qualifier', '{"forms":21}'),
      (${GROUP}, 9102, 9, 'Мария', 21, '2026-09-29', 'approved', 'qualifier', '{"forms":21}')`;
    await api("/api/v2/admin/promos", owner, { method: "POST", body: JSON.stringify({ name: "20 анкет", kind: "threshold", role: "qualifier", metric: "forms", threshold: 20, amount: 3000, period: "range", starts_on: "2026-09-27", ends_on: "2026-10-01" }) });
    await api("/api/v2/admin/promos", owner, { method: "POST", body: JSON.stringify({ name: "Конкурс", kind: "contest", role: "qualifier", metric: "forms", threshold: 1, amount: 9000, starts_on: "2026-09-27", ends_on: "2026-10-01" }) });
    const first = await M.promos.runDuePromos(M.time.today());
    expect(first.map((x: any) => [x.promo, x.winners]).sort()).toEqual([["20 анкет", 2], ["Конкурс", 2]]);
    const again = await M.promos.runDuePromos(M.time.today());
    expect(again).toEqual([]);
    const promo = await M.db`SELECT uid, amount, comment FROM accruals WHERE kind = 'promo' AND dedupe_key NOT LIKE '%:report:%' AND cancelled_at IS NULL ORDER BY comment, uid`;
    expect(promo.map((x: any) => [Number(x.uid), x.amount])).toEqual([[7, 3000], [9, 3000], [7, 4500], [9, 4500]]);
  });

  test("сторис: видна своей роли, скрывается", async () => {
    const day = M.time.today();
    const st = await (await api("/api/v2/admin/stories", { id: OWNER }, { method: "POST", body: JSON.stringify({ title: "Новость для рекрутеров", role: "recruiter", starts_on: day, ends_on: day }) })).json();
    expect((await (await api("/api/v2/me", IGOR)).json()).stories.map((s: any) => s.title)).toContain("Новость для рекрутеров");
    expect((await (await api("/api/v2/me", ANNA)).json()).stories.map((s: any) => s.title)).not.toContain("Новость для рекрутеров");
    await api(`/api/v2/admin/stories/${st.id}`, { id: OWNER }, { method: "DELETE" });
    expect((await (await api("/api/v2/me", IGOR)).json()).stories.length).toBe(0);
    const long = await api("/api/v2/admin/stories", { id: OWNER }, { method: "POST", body: JSON.stringify({ title: "x".repeat(41) }) });
    expect(long.status).toBe(400);
  });

  test("карточка сотрудника и ведомость для админа", async () => {
    const e = await (await api("/api/v2/admin/employees/8", { id: MANAGER, username: "approver1" })).json();
    expect(e.role).toBe("recruiter");
    expect(e.balance.accrued).toBe(210000);
    expect(e.accruals.some((a: any) => a.cancelled)).toBe(true); // отменённое ручное начисление видно с пометкой
    const ex = await (await api("/api/v2/admin/export", { id: MANAGER, username: "approver1" }, { method: "POST", body: "{}" })).json();
    expect(ex.csv.split("\r\n")[0]).toContain("Сотрудник");
    expect(ex.csv).toContain("Игорь Петров");
    const an = await (await api("/api/v2/admin/analytics", { id: MANAGER, username: "approver1" })).json();
    expect(an.periods.previous.label).toBeTruthy();
    expect(Array.isArray(an.payrollPrev)).toBe(true);
  });

  test("владелец без регистрации видит кабинет, но не баланс", async () => {
    const r = await (await api("/api/v2/me", { id: OWNER, first_name: "Босс" })).json();
    expect(r.adminLevel).toBe("owner");
    expect(r.balance).toBeUndefined();
    expect((await api("/api/v2/admin/overview", { id: OWNER })).status).toBe(200);
  });

  test("админ-скрипт отдаётся", async () => {
    const r = await fetch(`${base}/admin.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("const Admin");
  });

  test("достижения: выдаются один раз, с праздничным уведомлением в приложении", async () => {
    const r = await (await api("/api/v2/me/achievements", ANNA)).json();
    expect(r.total).toBe(12);
    const first = r.items.find((x: any) => x.code === "first_report");
    expect(first.done).toBe(true);
    expect(r.items.find((x: any) => x.code === "contract_1")).toBeUndefined(); // чужая роль
    expect(r.records.bestWeek.value).toBeGreaterThan(0);
    await api("/api/v2/me/achievements", ANNA);
    const n = await M.db`SELECT COUNT(*)::int AS n FROM notifications WHERE uid = 7 AND kind = 'achievement' AND title LIKE '%Первый отчёт%'`;
    expect(n[0].n).toBe(1);
    const dm = await M.db`SELECT COUNT(*)::int AS n FROM achievements_earned WHERE uid = 7 AND code = 'first_report'`;
    expect(dm[0].n).toBe(1);
    const rec = await (await api("/api/v2/me/achievements", IGOR)).json();
    expect(rec.items.find((x: any) => x.code === "contract_1").done).toBe(true);
    const me = await (await api("/api/v2/me", ANNA)).json();
    expect(me.achievements.total).toBe(12);
  });
});
