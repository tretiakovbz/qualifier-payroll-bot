// Миграции базы. Каждая применяется один раз и записывается в schema_migrations.
// Правило: только добавляем. Старые таблицы v1 не удаляем и не переименовываем,
// пока новая версия не проверена на реальных данных.

export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    // Таблицы v1 в том виде, в каком они уже есть в рабочей базе.
    // IF NOT EXISTS — на рабочей базе ничего не меняется, на пустой создаётся та же схема.
    id: "001_v1_baseline",
    sql: `
      CREATE TABLE IF NOT EXISTS reports(
        chat BIGINT NOT NULL, msg BIGINT NOT NULL, uid BIGINT NOT NULL,
        name TEXT NOT NULL, n INTEGER NOT NULL, day DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY(chat, msg)
      );
      CREATE TABLE IF NOT EXISTS payments(
        uid BIGINT NOT NULL, period DATE NOT NULL, amount INTEGER NOT NULL,
        paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(uid, period)
      );
      CREATE TABLE IF NOT EXISTS employees(
        uid BIGINT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
        can_dm BOOLEAN NOT NULL DEFAULT FALSE,
        reminders BOOLEAN NOT NULL DEFAULT TRUE,
        reply_idx INTEGER NOT NULL DEFAULT -1
      );
      CREATE TABLE IF NOT EXISTS payment_audit(
        uid BIGINT NOT NULL, period DATE NOT NULL, actor BIGINT NOT NULL,
        amount INTEGER NOT NULL, marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(uid, period)
      );
      CREATE TABLE IF NOT EXISTS reminder_deliveries(
        uid BIGINT, day DATE, PRIMARY KEY(uid, day)
      );
    `,
  },
];
