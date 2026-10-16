// Обработка входящих обновлений Telegram (вебхук), версия 2.

import { config } from "../config.ts";
import { api, send, sendDocument, type TgUser } from "../lib/telegram.ts";
import { parseReport, isReportTag, reportTemplate, type Role } from "../lib/report.ts";
import { PHRASES, pickIndex } from "../lib/phrases.ts";
import { periodOf, periodBack, dayOfMessage, humanRange } from "../lib/time.ts";
import { db } from "../db/client.ts";
import * as staff from "../core/employees.ts";
import { saveReport, setReportStatus } from "../core/reports.ts";
import { listDirections } from "../core/directions.ts";
import { getSettings } from "../core/settings.ts";
import { payroll, markPaid } from "../core/accruals.ts";
import { notify } from "../core/notify.ts";
import { companyByGroup, companyByInvite, bindGroup, getCompany, inviteLink, CompanyError, type Company } from "../core/companies.ts";
import { withCompany } from "../core/tenant.ts";

interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string };
  from?: TgUser;
  text?: string;
  contact?: { phone_number: string; user_id?: number };
  reply_to_message?: { message_id: number };
}

export interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
  message_reaction?: {
    chat: { id: number };
    message_id: number;
    user?: TgUser;
    new_reaction?: { type: string; emoji?: string }[];
  };
}

const rub = (n: number) => n.toLocaleString("ru-RU") + " ₽";
const ROLE_RU: Record<Role, string> = { qualifier: "квалификатор", recruiter: "рекрутер" };

function appButton(text: string, path = "") {
  return { inline_keyboard: [[{ text, web_app: { url: config.publicUrl + path } }]] };
}

export async function handleUpdate(u: TgUpdate): Promise<void> {
  const msg = u.message ?? u.edited_message;
  const isGroup = msg && (msg.chat.type === "group" || msg.chat.type === "supergroup");

  if (msg && isGroup && msg.from && !msg.from.is_bot) {
    // Подключение рабочего чата: руководитель добавил бота по ссылке «Подключить чат»
    const bind = (msg.text ?? "").match(/^\/start(?:@\w+)?\s+bind_([A-Za-z0-9]+)/);
    if (bind) return void (await handleBind(msg, bind[1]));
    const company = await companyByGroup(msg.chat.id);
    if (!company) return; // чат не подключён ни к одной компании — молчим
    await withCompany(company.id, () => handleGroupMessage(msg, Boolean(u.edited_message), company));
    return;
  }
  if (msg && msg.chat.type === "private" && msg.from) {
    await handlePrivateMessage(msg);
    return;
  }
  if (u.callback_query) {
    await handleCallback(u.callback_query);
    return;
  }
  if (u.message_reaction && u.message_reaction.user) {
    const r = u.message_reaction;
    const company = await companyByGroup(r.chat.id);
    if (!company) return;
    await staff.touch(r.user!);
    await withCompany(company.id, async () => {
      const level = await staff.adminLevel(r.user!);
      if (!level) return;
      const yes = (r.new_reaction ?? []).some((x) => x.type === "emoji" && x.emoji === "👍");
      await setReportStatus(r.message_id, yes ? "approved" : "pending", r.user!.id);
    });
  }
}

async function handleBind(msg: TgMessage, code: string) {
  const from = msg.from!;
  await staff.touch(from);
  try {
    const c = await bindGroup(code, { id: msg.chat.id, title: msg.chat.title }, from.id);
    if (!c) return;
    await send(msg.chat.id, `Готово! Чат подключён к компании «${c.name}».\n\nСотрудники пишут сюда отчёты с тегом #отчет — бот всё посчитает. Если кто-то ещё не в команде, бот пришлёт ему ссылку-приглашение.`);
  } catch (e) {
    if (e instanceof CompanyError) await send(msg.chat.id, e.message);
    else throw e;
  }
}

async function handleGroupMessage(msg: TgMessage, edited: boolean, company: Company) {
  const from = msg.from!;
  const text = msg.text ?? "";
  const chat = msg.chat.id;

  if (isReportTag(text)) {
    await handleReport(msg, edited, company);
    return;
  }

  const cmd = text.split(" ")[0].split("@")[0];
  if (["/stat", "/week", "/history", "/app", "/me"].includes(cmd)) {
    // Статистика теперь в Mini App: у каждой роли своя, и чат не засоряется
    await send(chat, "📊 Статистика, рейтинг и ваш баланс — в приложении бота", {
      reply_to_message_id: msg.message_id,
      reply_markup: { inline_keyboard: [[{ text: "Открыть", url: `https://t.me/${config.botUsername}?startapp=stats` }]] },
    });
    return;
  }

  if ((cmd === "/approve" || cmd === "/reject") && msg.reply_to_message) {
    await staff.touch(from);
    if (!(await staff.adminLevel(from))) return;
    const reason = cmd === "/reject" ? text.split(" ").slice(1).join(" ").trim() || undefined : undefined;
    await setReportStatus(msg.reply_to_message.message_id, cmd === "/approve" ? "approved" : "rejected", from.id, reason);
    await api("setMessageReaction", {
      chat_id: chat,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👌" }],
    }).catch(() => {});
  }
}

async function handleReport(msg: TgMessage, edited: boolean, company: Company) {
  const from = msg.from!;
  const text = msg.text ?? "";
  const chat = msg.chat.id;
  const employee = await staff.touch(from);
  const directions = await listDirections();
  const parsed = parseReport(text, directions);

  if (!parsed.ok) {
    if (parsed.reason === "invalid" && !edited) {
      const role = employee.role ?? "qualifier";
      await send(chat, `Не получилось разобрать отчёт: ${parsed.message}.\nШаблон:\n${reportTemplate(role)}`, {
        reply_to_message_id: msg.message_id,
      });
    }
    return;
  }

  const member = employee.company_id === company.id;
  if (!member) {
    // Не в этой команде: отчёт не сохраняем, а даём ссылку-приглашение этой компании
    if (!edited) {
      await send(chat, employee.company_id
        ? "Вы состоите в другой компании, поэтому отчёт здесь не засчитан. Чтобы перейти в эту команду, выйдите из текущей в профиле и вступите по ссылке."
        : "Чтобы отчёт засчитался, вступите в команду — это минута.", {
        reply_to_message_id: msg.message_id,
        reply_markup: { inline_keyboard: [[{ text: "Вступить в команду", url: inviteLink(company) }]] },
      });
    }
    return;
  }
  if (employee.status !== "active" || !employee.role) {
    if (!edited) {
      await send(chat, "Отчёт сохранён. Он засчитается, как только руководитель одобрит вашу заявку.", { reply_to_message_id: msg.message_id });
    }
  } else if (employee.role !== parsed.role) {
    if (!edited) {
      await send(
        chat,
        `Похоже на отчёт ${parsed.role === "qualifier" ? "квалификатора" : "рекрутера"}, а вы зарегистрированы как ${ROLE_RU[employee.role]}. Шаблон:\n${reportTemplate(employee.role)}`,
        { reply_to_message_id: msg.message_id },
      );
    }
    return;
  }

  await saveReport({
    chat,
    msg: msg.message_id,
    uid: from.id,
    name: staff.displayName(employee),
    day: dayOfMessage(msg.date),
    role: parsed.role,
    metrics: parsed.metrics,
  });

  if (edited || employee.status !== "active") return;

  const s = await getSettings();
  const main = parsed.role === "qualifier" ? parsed.metrics.forms ?? 0 : parsed.metrics.contracts ?? 0;
  const anything = Object.entries(parsed.metrics).some(([k, v]) => k !== "special" && (v as number) > 0);
  const pool =
    parsed.role === "recruiter" && main > 0
      ? PHRASES.contract
      : !anything
        ? s.phrases?.zero?.length ? s.phrases.zero : PHRASES.zero
        : s.phrases?.normal?.length ? s.phrases.normal : PHRASES.normal;
  const idx = pickIndex(pool.length, employee.reply_idx);
  await db`UPDATE employees SET reply_idx = ${idx} WHERE uid = ${from.id}`;
  await send(chat, pool[idx], { reply_to_message_id: msg.message_id });
}

async function handlePrivateMessage(msg: TgMessage) {
  const from = msg.from!;
  const uid = from.id;
  const text = msg.text ?? "";
  const e = await staff.touch(from, { canDm: true });

  if (msg.contact) {
    if (msg.contact.user_id === uid) {
      await staff.setPhone(uid, msg.contact.phone_number);
      await send(uid, "Спасибо, номер сохранён. Вернитесь в приложение, чтобы закончить регистрацию.", {
        reply_markup: appButton("Продолжить", e.company_id ? "#/register" : "#/welcome"),
      });
    }
    return;
  }

  if (text.startsWith("/start")) {
    const arg = text.split(/\s+/)[1] ?? "";
    const join = arg.match(/^join_([A-Za-z0-9]+)$/);
    if (join) {
      const c = await companyByInvite(join[1]);
      if (!c) return void (await send(uid, "Ссылка-приглашение устарела. Попросите у руководителя новую."));
      await send(uid, `Вас пригласили в команду «${c.name}». Заполните короткую анкету — руководитель её одобрит.`, {
        reply_markup: appButton("Вступить в команду", `?join=${join[1]}#/join`),
      });
      return;
    }
    const c = e.company_id ? await getCompany(e.company_id) : null;
    if (c && staff.adminLevelOf(e)) {
      await send(uid, `Кабинет компании «${c.name}»: команда, отчёты, деньги и приглашения — в приложении.`, { reply_markup: appButton("Открыть кабинет", "#/admin") });
    } else if (c && e.status === "active" && e.role) {
      await send(uid, `С возвращением, ${staff.displayName(e).split(" ")[0]}! Баланс, рейтинг и настройки — в приложении.`, { reply_markup: appButton("Открыть приложение") });
    } else if (c && e.status === "pending") {
      await send(uid, `Ваша заявка в «${c.name}» у руководителя. Как только её одобрят, я пришлю сообщение.`);
    } else {
      await send(uid, "Привет! Это бот для рейтинга, бонусов и зарплаты команды.\n\nРуководитель — создайте компанию и пригласите сотрудников по ссылке.\nСотрудник — откройте ссылку-приглашение от руководителя.", {
        reply_markup: appButton("Создать компанию", "#/welcome"),
      });
    }
    return;
  }

  if (text === "/reminders" || text === "/settings") {
    await send(uid, "Уведомления, напоминания и тема — в настройках профиля.", {
      reply_markup: appButton("Открыть настройки", "#/profile/settings"),
    });
    return;
  }

  // Команды админа в личке — в его компании
  if (!e.company_id || !staff.adminLevelOf(e)) return;
  await withCompany(e.company_id, () => adminCommand(uid, text, staff.adminLevelOf(e)!));
}

async function adminCommand(uid: number, text: string, level: "owner" | "manager") {
  const s = await getSettings();

  if (text === "/payroll") {
    const period = periodOf(undefined, s.payoutDays);
    const rows = await payroll(period);
    const total = rows.reduce((sum: number, r: any) => sum + r.total, 0);
    const lines = rows.map(
      (r: any) => `${r.name} (${ROLE_RU[r.role as Role] ?? "—"}): ${rub(r.total)}${r.paid !== null ? " ✅" : ""}`,
    );
    await send(uid, [`💰 Ведомость ${humanRange(period)}`, ...lines, `Итого: ${rub(total)}`].join("\n"));
    return;
  }

  if (text.startsWith("/paid") && level === "owner") {
    const employee = Number(text.split(/\s+/)[1]);
    if (!Number.isSafeInteger(employee) || employee <= 0) {
      await send(uid, "Используй: /paid TELEGRAM_ID — отмечает выплату за завершённый период. Удобнее — в кабинете админа.");
      return;
    }
    const period = periodBack(1, undefined, s.payoutDays);
    const sum = await markPaid(employee, period, uid);
    await send(uid, `✅ Выплата отмечена: ${employee} · ${rub(sum)} за ${humanRange(period)}`);
    return;
  }

  if (text === "/export") {
    const period = periodOf(undefined, s.payoutDays);
    const rows = await payroll(period);
    const quote = (x: unknown) => '"' + String(x ?? "").replaceAll('"', '""') + '"';
    const header = ["Период", "Telegram ID", "Сотрудник", "Роль", "Оклад ₽", "Анкеты/контракты ₽", "Бонусы ₽", "Начислено ₽", "Выплачено ₽"];
    const lines = rows.map((r: any) =>
      [humanRange(period), r.uid, r.name, ROLE_RU[r.role as Role] ?? "", r.salary, r.work, r.bonus, r.total, r.paid ?? 0].map(quote).join(";"),
    );
    const csv = [header.map(quote).join(";"), ...lines].join("\r\n");
    const ok = await sendDocument(uid, new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), `vedomost_${period[0]}_${period[1]}.csv`);
    if (!ok) await send(uid, "Ошибка отправки файла");
  }
}

async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>) {
  const data = cq.data ?? "";
  const answer = (text: string) => api("answerCallbackQuery", { callback_query_id: cq.id, text });

  const reg = data.match(/^reg:(ok|no):(\d+)$/);
  if (reg) {
    const me = await staff.touch(cq.from);
    if (!me?.company_id) return void (await answer("Только для админов"));
    return void (await withCompany(me.company_id, () => decideFromChat(cq, reg, answer)));
  }

  // Совместимость с кнопкой напоминаний из v1
  if (data === "toggle_reminder") {
    await answer("Напоминания настраиваются в профиле приложения");
  }
}

async function decideFromChat(cq: NonNullable<TgUpdate["callback_query"]>, reg: RegExpMatchArray, answer: (t: string) => Promise<unknown>) {
  {
    const level = await staff.adminLevel(cq.from);
    if (!level) return void (await answer("Только для админов"));
    const target = Number(reg[2]);
    const approved = reg[1] === "ok";
    const e = await staff.decide(target, approved, cq.from.id);
    if (!e) return void (await answer("Заявка уже рассмотрена"));
    await answer(approved ? "Одобрено" : "Отклонено");
    if (cq.message) {
      await api("editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `${approved ? "✅ Одобрено" : "❌ Отклонено"}: ${staff.displayName(e)}, ${ROLE_RU[e.role as Role] ?? ""}`,
      });
    }
    await notify(target, approved
      ? { kind: "registration", title: "Добро пожаловать в команду! Регистрация одобрена", body: "Теперь ваши отчёты засчитываются, а баланс виден в приложении." }
      : { kind: "registration", title: "Регистрация не одобрена", body: "Если это ошибка — напишите админу." });
  }
}

/** Сообщить админам о новой заявке на регистрацию */
export async function announceRegistration(e: staff.Employee) {
  const text = `Новая заявка в команду: ${staff.displayName(e)}\nРоль: ${ROLE_RU[e.role as Role]}\nГород: ${e.city ?? "—"}\nТелефон: ${e.phone ?? "—"}${e.username ? `\n@${e.username}` : ""}`;
  for (const admin of await staff.listAdmins()) {
    if (!config.liveMode) continue;
    await send(admin, text, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Одобрить", callback_data: `reg:ok:${e.uid}` }, { text: "❌ Отклонить", callback_data: `reg:no:${e.uid}` }]] },
    }).catch(() => {});
  }
}
