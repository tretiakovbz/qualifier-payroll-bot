// Обработка входящих обновлений Telegram (вебхук).
// Этап 1: поведение как в v1, но с исправленными ошибками.

import { config, canApprove, isAdmin } from "../config.ts";
import { api, send, sendDocument, fullName, type TgUser } from "../lib/telegram.ts";
import { parseQualifierReport } from "../lib/report.ts";
import { periodOf, periodBack, nowLocal, addDays, toDay, dayOfMessage } from "../lib/time.ts";
import * as q from "../db/queries.ts";
import { REPLIES } from "./replies.ts";

interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
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
const remindersText = (on: boolean) => "🔔 Напоминания в 19:30 МСК (вс–чт): " + (on ? "Включены" : "Выключены");
const remindersKeyboard = (on: boolean) => ({
  inline_keyboard: [[{ text: on ? "🔕 Выключить" : "🔔 Включить", callback_data: "toggle_reminder" }]],
});

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
  if (u.callback_query?.data === "toggle_reminder") {
    await handleReminderToggle(u.callback_query);
    return;
  }
  if (u.message_reaction && u.message_reaction.chat.id === config.groupId && canApprove(u.message_reaction.user)) {
    const r = u.message_reaction;
    const yes = (r.new_reaction ?? []).some((x) => x.type === "emoji" && x.emoji === "👍");
    await q.setReportStatus(r.message_id, yes ? "approved" : "pending");
  }
}

async function handleGroupMessage(msg: TgMessage, edited: boolean) {
  const from = msg.from!;
  const text = msg.text ?? "";
  const report = parseQualifierReport(text);

  if (report) {
    const name = fullName(from);
    await q.upsertReport({ msg: msg.message_id, uid: from.id, name, n: report.forms, day: dayOfMessage(msg.date) });
    if (!edited) {
      await q.touchEmployee(from.id, name);
      const idx = await q.nextReplyIndex(from.id, REPLIES.length);
      await send(config.groupId, `${REPLIES[idx]} · ${report.forms} анкет ожидают подтверждения 👍`, {
        reply_to_message_id: msg.message_id,
      });
    }
    return;
  }

  const cmd = text.split(" ")[0].split("@")[0];
  const [a, b] = periodOf();

  if (cmd === "/stat" || cmd === "/week") {
    let from_ = a;
    let to = b;
    if (cmd === "/week") {
      to = toDay(nowLocal());
      from_ = addDays(to, -6);
    }
    const rows = await q.ranking(from_, to);
    const lines = rows.map((r, i) => `${i + 1}. ${r.name}: ${r.approved} ✅, ${r.pending} ⏳`).join("\n");
    await send(config.groupId, `🏆 Рейтинг ${from_} — ${to}\n${lines || "Нет отчётов"}`);
    return;
  }

  if ((cmd === "/approve" || cmd === "/reject") && canApprove(from) && msg.reply_to_message) {
    await q.setReportStatus(msg.reply_to_message.message_id, cmd === "/approve" ? "approved" : "rejected");
    await send(config.groupId, "Статус отчёта обновлён.");
    return;
  }

  if (cmd === "/payroll" && isAdmin(from.id)) {
    const rows = await q.ranking(a, b);
    const total = rows.reduce((s, r) => s + r.approved * config.ratePerForm, 0);
    const lines = rows.map((r) => `${r.name}: ${r.approved} × ${config.ratePerForm} = ${rub(r.approved * config.ratePerForm)}`);
    await send(from.id, [`💰 Ведомость ${a} — ${b}`, ...lines, `Итого: ${rub(total)}`].join("\n"));
    return;
  }

  if (cmd === "/history") {
    const out: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const [s, e] = periodBack(i);
      out.push(`${s}—${e}: ${await q.teamApprovedCount(s, e)}`);
    }
    await send(config.groupId, ["📚 История подтверждённых анкет", ...out].join("\n"));
    return;
  }

  if (cmd === "/paid" && isAdmin(from.id)) {
    await send(config.groupId, "🔒 Отметки выплат доступны только в личном чате бота: /paid TELEGRAM_ID");
    return;
  }
  if (cmd === "/export" && isAdmin(from.id)) {
    await send(config.groupId, "🔒 Выгрузка доступна в личном чате бота: /export");
    return;
  }
  if (cmd === "/app") {
    await send(config.groupId, "📊 Статистика квалификаторов", {
      reply_markup: { inline_keyboard: [[{ text: "Открыть Mini App", url: config.publicUrl }]] },
    });
  }
}

async function handlePrivateMessage(msg: TgMessage) {
  const from = msg.from!;
  const uid = from.id;
  const text = msg.text ?? "";
  const [a, b] = periodOf();
  await q.touchEmployee(uid, fullName(from), true);

  if (text === "/reminders" || text === "/settings") {
    const on = await q.getReminders(uid);
    await send(uid, remindersText(on), { reply_markup: remindersKeyboard(on) });
    return;
  }

  if (text.startsWith("/paid") && isAdmin(uid)) {
    const employee = Number(text.split(/\s+/)[1]);
    if (!Number.isSafeInteger(employee) || employee <= 0) {
      await send(uid, "Используй: /paid TELEGRAM_ID (отмечает выплату за завершённый период)");
      return;
    }
    const [from_, to] = periodBack(1);
    const n = await q.approvedCount(employee, from_, to);
    if (n === 0) {
      await send(uid, `Нет подтверждённых анкет сотрудника за ${from_} — ${to}`);
      return;
    }
    const amount = n * config.ratePerForm;
    await q.markPaid(employee, from_, amount, uid);
    await send(uid, `✅ Выплата отмечена: ${employee} · ${rub(amount)} за ${from_} — ${to}`);
    return;
  }

  if (text === "/export" && isAdmin(uid)) {
    const rows = await q.ranking(a, b);
    const quote = (x: unknown) => '"' + String(x).replaceAll('"', '""') + '"';
    const header = ["Период", "Telegram ID", "Сотрудник", "Подтверждено", "Ожидает", "Начислено ₽", "Выплачено ₽", "Статус"];
    const lines = await Promise.all(
      rows.map(async (r) => {
        const paid = await q.paidAmount(r.uid, a);
        return [a, r.uid, r.name, r.approved, r.pending, r.approved * config.ratePerForm, paid ?? 0, paid !== null ? "Оплачено" : "Не оплачено"]
          .map(quote)
          .join(";");
      }),
    );
    const csv = [header.map(quote).join(";"), ...lines].join("\r\n");
    const ok = await sendDocument(uid, new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `qualifiers_${a}_${b}.csv`);
    if (!ok) await send(uid, "Ошибка отправки CSV");
    return;
  }

  if (text === "/me") {
    const n = await q.approvedCount(uid, a, b);
    await send(uid, `✅ Подтверждено: ${n}\nНачислено: ${rub(n * config.ratePerForm)}`);
    return;
  }

  if (text.startsWith("/start") || text === "/app") {
    await send(uid, "📊 Статистика и результаты", {
      reply_markup: { inline_keyboard: [[{ text: "Открыть статистику", web_app: { url: config.publicUrl } }]] },
    });
  }
}

async function handleReminderToggle(cq: NonNullable<TgUpdate["callback_query"]>) {
  const on = await q.toggleReminders(cq.from.id, cq.from.first_name ?? "");
  await api("answerCallbackQuery", { callback_query_id: cq.id, text: on ? "Напоминания включены" : "Напоминания выключены" });
  if (cq.message) {
    await api("editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: remindersText(on),
      reply_markup: remindersKeyboard(on),
    });
  }
}
