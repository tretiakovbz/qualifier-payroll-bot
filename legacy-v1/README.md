# @sqlhunter_bot — «Рейтинг квалификаторов» · резервная копия v1

Снимок рабочей версии от 14.10.2026, до полной переработки.
Railway: проект `qualifier-payroll-bot` (аккаунт tretiakovbz), окружение production.

| Файл | Сервис Railway | Что делает |
|---|---|---|
| `index.ts` | `qualifier-miniapp` | Бот (webhook `/telegram/webhook`), API Mini App, HTML Mini App |
| `reminder-cron.ts` | `qualifier-reminder-cron` | Напоминания в 19:30 МСК (вс–чт) |
| `bot-setup.ts` | `telegram-bot-setup` | Разово ставит аватар бота |

Все три — Railway Functions, Bun 1.4.0.

## Переменные окружения (значения не сохранены — лежат в Railway)
`BOT_TOKEN`, `ADMIN_IDS`, `GROUP_ID`, `PUBLIC_URL`, `WEBHOOK_SECRET`, `DATABASE_URL`, `PORT`

## База (Postgres в том же проекте)
`reports`, `employees`, `payments`, `payment_audit`, `reminder_deliveries` — таблицы создаются кодом при старте; данные при переработке не трогаются.

## Как откатиться
Вставить содержимое `index.ts` обратно в функцию `qualifier-miniapp` (Railway → сервис → код) и задеплоить. Либо в Railway → Deployments выбрать нынешний деплой и нажать Redeploy.
