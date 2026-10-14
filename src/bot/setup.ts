// Настройка Telegram при старте боевого сервиса.
//  • SETUP_TELEGRAM=1 — вебхук бота переводится на этот сервис, ставится кнопка меню и список команд.
//  • ROLLBACK_TO_V1=1 — аварийный откат: вебхук возвращается старому сервису (V1_PUBLIC_URL), этот сервис его не забирает.
// Секрет вебхука у старого и нового сервиса общий, поэтому откат мгновенный.

import { config } from "../config.ts";
import { api } from "../lib/telegram.ts";

const UPDATES = ["message", "edited_message", "callback_query", "message_reaction"];

export async function setupTelegram(env = Bun.env) {
  if (!config.botToken) return;
  const info = await api("getWebhookInfo", {}).catch((e) => ({ ok: false, error: String(e) }));
  const current = (info as any)?.result?.url ?? "";
  console.log("[telegram] вебхук сейчас:", current || "(нет)");

  if (env.ROLLBACK_TO_V1 === "1") {
    const v1 = (env.V1_PUBLIC_URL ?? "").replace(/\/$/, "");
    if (!v1) return console.error("[telegram] откат невозможен: не задан V1_PUBLIC_URL");
    const r = await api("setWebhook", { url: `${v1}/telegram/webhook`, secret_token: config.webhookSecret, allowed_updates: UPDATES });
    await api("setChatMenuButton", { menu_button: { type: "web_app", text: "Статистика", web_app: { url: v1 } } }).catch(() => {});
    console.log("[telegram] ОТКАТ на v1:", JSON.stringify(r));
    return;
  }

  if (env.SETUP_TELEGRAM !== "1") return;
  if (!config.publicUrl || !config.webhookSecret) return console.error("[telegram] нужны PUBLIC_URL и WEBHOOK_SECRET");
  const target = `${config.publicUrl.replace(/\/$/, "")}/telegram/webhook`;
  if (current !== target) {
    const r = await api("setWebhook", { url: target, secret_token: config.webhookSecret, allowed_updates: UPDATES, drop_pending_updates: false });
    console.log("[telegram] вебхук переведён на этот сервис:", JSON.stringify(r));
  } else {
    // allowed_updates могли отличаться — обновляем, это безопасно
    await api("setWebhook", { url: target, secret_token: config.webhookSecret, allowed_updates: UPDATES });
    console.log("[telegram] вебхук уже на этом сервисе");
  }
  const menu = await api("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть", web_app: { url: config.publicUrl } } });
  const cmds = await api("setMyCommands", {
    commands: [
      { command: "start", description: "Открыть приложение" },
      { command: "settings", description: "Уведомления и тема" },
    ],
    scope: { type: "all_private_chats" },
  });
  const adminCmds = config.adminIds.map((id) =>
    api("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть приложение" },
        { command: "payroll", description: "Ведомость за текущий период" },
        { command: "export", description: "Ведомость файлом" },
        { command: "settings", description: "Уведомления и тема" },
      ],
      scope: { type: "chat", chat_id: id },
    }),
  );
  await Promise.all(adminCmds);
  // В рабочем чате команды не показываем — там только отчёты
  await api("deleteMyCommands", { scope: { type: "all_group_chats" } }).catch(() => {});
  console.log("[telegram] меню:", JSON.stringify(menu), "команды:", JSON.stringify(cmds));
}
