# @sqlhunter_bot — «Рейтинг квалификаторов»

Telegram-бот и Mini App: собирает отчёты сотрудников из рабочего чата, считает зарплату и бонусы, показывает рейтинг.
ТЗ версии 2 — в Claude Docs («ТЗ: бот «Рейтинг квалификаторов» v2»).

## Структура

```
src/
  index.ts          HTTP-сервер: /health, вебхук Telegram, API, Mini App
  config.ts         настройки из переменных окружения
  db/               подключение, миграции, запросы
  bot/              обработка сообщений, команд, реакций
  api/              API для Mini App (проверка подписи Telegram)
  miniapp/          интерфейс Mini App
  cron/             напоминания по расписанию
  lib/              даты и периоды, разбор отчётов, Telegram API
tests/unit          модульные тесты
tests/integration   сквозные тесты на настоящем Postgres
legacy-v1/          исходный код версии 1 (до переработки), для справки и отката
```

## Переменные окружения (Railway)

| Переменная | Что это |
| --- | --- |
| `BOT_TOKEN` | токен бота от @BotFather |
| `WEBHOOK_SECRET` | секрет вебхука; без него вебхук не принимается |
| `DATABASE_URL` | Postgres |
| `PUBLIC_URL` | адрес Mini App |
| `GROUP_ID` | ID рабочего чата |
| `ADMIN_IDS` | Telegram ID админов через запятую |
| `APPROVER_USERNAMES` | ники, которые могут подтверждать отчёты, через запятую |
| `RATE_PER_FORM` | ставка за анкету, ₽ (по умолчанию 500) |
| `SERVICE_NAME` | имя сервиса в /health |

## Команды

```
bun run start              запустить
bun run test               модульные тесты
TEST_DATABASE_URL=postgres://... bun run test:integration   сквозные тесты (база очищается!)
bun run migrate            применить миграции
bun run cron:reminders     разослать напоминания
```

## Деплой

Railway собирает `Dockerfile` при каждом пуше в `main`. Миграции применяются при старте и только добавляют таблицы.
