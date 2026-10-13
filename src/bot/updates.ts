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

interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
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

  if (msg && msg.chat.id === config.groupId && msg.from && !msg.from.is_bot) {
    await handleGroupMessage(msg, Boolean(u.edited_message));
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
  if (u.message_reaction && u.message_reaction.chat.id === config.groupId && u.message_reaction.user) {
    const r = u.message_reaction;
    const level = await staff.adminLevel(r.user!);
    if (!level) return;
    const yes = (r.new_reaction ?? []).some((x) => x.type === "emoji" && x.emoji === "👍");
    await setReportStatus(r.message_id, yes ? "approved" : "pending", r.user!.id);
  }
}

async function handleGroupMessage(msg: TgMessage, edited: boolean) {
  const from = msg.from!;
  const text = msg.text ?? "";

  if (isReportTag(text)) {
    await handleReport(msg, edited);
    return;
  }

  const cmd = text.split(" ")[0].split("@")[0];
  if (["/stat", "/week", "/history", "/app", "/me"].includes(cmd)) {
    // Статистика теперь в Mini App: у каждой роли своя, и чат не засоряется
    await send(config.groupId, "📊 Статистика, рейтинг и ваш баланс — в приложении бота", {
      reply_to_message_id: msg.message_id,
      reply_markup: { inline_keyboard: [[{ text: "Открыть", url: `https://t.me/${config.botUsername}?startapp=stats` }]] },
    });
    return;
  }

  if ((cmd === "/approve" || cmd === "/reject") && msg.reply_to_message) {
    if (!(await staff.adminLevel(from))) return;
    const reason = cmd === "/reject" ? text.split(" ").slice(1).join(" ").trim() || undefined : undefined;
    await setReportStatus(msg.reply_to_message.message_id, cmd === "/approve" ? "approved" : "rejected", from.id, reason);
    await api("setMessageReaction", {
      chat_id: config.groupId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👌" }],
    }).catch(() => {});
  }
}

async function handleReport(msg: TgMessage, edited: boolean) {
  const from = msg.from!;
  const text = msg.text ?? "";
  const employee = await staff.touch(from);
  const directions = await listDirections();
  const parsed = parseReport(text, directions);

  if (!parsed.ok) {
    if (parsed.reason === "invalid" && !edited) {
      const role = employee.role ?? "qualifier";
      await send(config.groupId, `Не получилось разобрать отчёт: ${parsed.message}.\nШаблон:\n${reportTemplate(role)}`, {
        reply_to_message_id: msg.message_id,
      });
    }
    return;
  }

  if (employee.status !== "active" || !employee.role) {
    if (!edited) {
 const waiting = employee.status === "pending" && employee.role;
      const hint =
        waiting
          ? "Отчёт сохранён. Он засчитается, как только админ одобрит вашу регистрацию."
          : "Отчёт сохранён. Чтобы он засчитался, зарегистрируйтесь в боте — это минута.";
      await send(config.groupId, hint, {
        reply_to_message_id: msg.message_id,
        reply_markup: waiting ? undefined : { inline_keyboard: [[{ text: "Зарегистрироваться", url: `https://t.me/${config.botUsername}?start=register` }]] },
      });
    }
  } else if (employee.role !== parsed.role) {
    if (!edited) {
      await send(
        config.groupId,
        `Похоже на отчёт ${parsed.role === "qualifier" ? "квалификатора" : "рекрутера"}, а вы зарегистрированы как ${ROLE_RU[employee.role]}. Шаблон:\n${reportTemplate(employee.role)}`,
        { reply_to_message_id: msg.message_id },
      );
    }
    return;
  }

  await saveReport({
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
  await send(config.groupId, pool[idx], { reply_to_message_id: msg.message_id });
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
        reply_markup: appButton("Продолжить регистрацию", "#/register"),
      });
    }
    return;
  }

  const level = staff.adminLevelOf(e);

  if (text.startsWith("/start")) {
    if (e.status === "active" && e.role) {
      await send(uid, `С возвращением, ${staff.displayName(e).split(" ")[0]}! Баланс, рейтинг и настройки — в приложении.`, {
        reply_markup: appButton("Открыть приложение"),
      });
    } else if (e.status === "pending" && e.role) {
      await send(uid, "Ваша заявка у админа. Как только её одобрят, я пришлю сообщение.");
    } else {
      await send(uid, "Привет! Здесь считаются ваши результаты, бонусы и зарплата. Для начала — короткая регистрация.", {
        reply_markup: appButton("Зарегистрироваться", "#/register"),
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

  // Команды админа в личке
  if (!level) return;
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
    const ok = await sendDocument(uid, new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `vedomost_${period[0]}_${period[1]}.csv`);
    if (!ok) await send(uid, "Ошибка отправки файла");
  }
}

async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>) {
  const data = cq.data ?? "";
  const answer = (text: string) => api("answerCallbackQuery", { callback_query_id: cq.id, text });

  const reg = data.match(/^reg:(ok|no):(\d+)$/);
  if (reg) {
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
    return;
  }

  // Совместимость с кнопкой напоминаний из v1
  if (data === "toggle_reminder") {
    await answer("Напоминания настраиваются в профиле приложения");
  }
}

/** Сообщить админам о новой заявке на регистрацию */
export async function announceRegistration(e: staff.Employee) {
  const text = `Новая заявка: ${staff.displayName(e)}\nРоль: ${ROLE_RU[e.role as Role]}\nГород: ${e.city ?? "—"}\nТелефон: ${e.phone ?? "—"}${e.username ? `\n@${e.username}` : ""}`;
  for (const admin of await staff.listAdmins()) {
    if (!config.liveMode) continue;
    await send(admin, text, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Одобрить", callback_data: `reg:ok:${e.uid}` }, { text: "❌ Отклонить", callback_data: `reg:no:${e.uid}` }]] },
    }).catch(() => {});
  }
}
