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
  {
    // Ядро v2: роли и регистрация, настройки, прайс направлений, правила бонусов,
    // журнал начислений, уведомления, журнал действий админов.
    id: "002_v2_core",
    sql: `
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS role TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS full_name TEXT,
        ADD COLUMN IF NOT EXISTS phone TEXT,
        ADD COLUMN IF NOT EXISTS city TEXT,
        ADD COLUMN IF NOT EXISTS username TEXT,
        ADD COLUMN IF NOT EXISTS photo_url TEXT,
        ADD COLUMN IF NOT EXISTS admin_level TEXT,
        ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS approved_by BIGINT,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

      -- Все, кто уже есть в v1, — действующие квалификаторы (по ТЗ)
      UPDATE employees SET role = 'qualifier', status = 'active', approved_at = now(),
        full_name = COALESCE(NULLIF(full_name, ''), NULLIF(name, ''))
      WHERE role IS NULL;

      ALTER TABLE reports
        ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'qualifier',
        ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS reviewed_by BIGINT,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reject_reason TEXT,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
      CREATE INDEX IF NOT EXISTS reports_day ON reports(chat, day);
      CREATE INDEX IF NOT EXISTS reports_uid_day ON reports(uid, day);

      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY, value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by BIGINT
      );

      CREATE TABLE IF NOT EXISTS directions(
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, aliases TEXT[] NOT NULL DEFAULT '{}',
        price INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, sort INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO directions(name, aliases, price, sort)
      SELECT 'Уфа и офицеры', ARRAY['уфа и офицеры','уфа','офицеры'], 50000, 1
      WHERE NOT EXISTS (SELECT 1 FROM directions);

      CREATE TABLE IF NOT EXISTS bonus_rules(
        id SERIAL PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL,
        role TEXT NOT NULL, kind TEXT NOT NULL, metric TEXT, period TEXT NOT NULL,
        amount INTEGER NOT NULL, threshold INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE, split_ties BOOLEAN NOT NULL DEFAULT TRUE,
        sort INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by BIGINT
      );
      INSERT INTO bonus_rules(code, name, role, kind, metric, period, amount, threshold, enabled, sort) VALUES
        ('top_calls_week', 'Лучший по недозвонам недели', 'qualifier', 'top_metric', 'calls', 'week', 5000, 0, FALSE, 1),
        ('top_forms_week', 'Лучший по анкетам недели', 'qualifier', 'top_metric', 'forms', 'week', 5000, 20, FALSE, 2),
        ('no_delays_week', 'Без 5 задержек', 'qualifier', 'manual', NULL, 'week', 10000, 0, TRUE, 3),
        ('top_recruiter_month', 'Лучший рекрутер месяца', 'recruiter', 'top_metric', 'contracts', 'month', 200000, 1, TRUE, 4)
      ON CONFLICT (code) DO NOTHING;

      CREATE TABLE IF NOT EXISTS bonus_runs(
        rule_id INTEGER NOT NULL, period_key TEXT NOT NULL, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        winners JSONB NOT NULL DEFAULT '[]', PRIMARY KEY(rule_id, period_key)
      );

      -- Журнал начислений: каждая копейка с причиной. Отмена — пометкой, не удалением.
      CREATE TABLE IF NOT EXISTS accruals(
        id BIGSERIAL PRIMARY KEY, uid BIGINT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
        period_start DATE NOT NULL, day DATE NOT NULL, dedupe_key TEXT,
        rule_id INTEGER, report_chat BIGINT, report_msg BIGINT, comment TEXT,
        created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        cancelled_at TIMESTAMPTZ, cancelled_by BIGINT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accruals_dedupe ON accruals(dedupe_key) WHERE cancelled_at IS NULL;
      CREATE INDEX IF NOT EXISTS accruals_uid_period ON accruals(uid, period_start);

      -- Подтверждённые анкеты из v1 — в журнал начислений по ставке v1 (500 ₽)
      INSERT INTO accruals(uid, kind, amount, period_start, day, dedupe_key, report_chat, report_msg, comment)
      SELECT uid, 'form', n * 500,
        CASE
          WHEN EXTRACT(DAY FROM day) >= 20 THEN (date_trunc('month', day) + INTERVAL '19 days')::date
          WHEN EXTRACT(DAY FROM day) >= 5 THEN (date_trunc('month', day) + INTERVAL '4 days')::date
          ELSE (date_trunc('month', day) - INTERVAL '1 month' + INTERVAL '19 days')::date
        END,
        day, 'report:' || chat || ':' || msg, chat, msg, 'перенос из v1'
      FROM reports r
      WHERE status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM accruals a WHERE a.dedupe_key = 'report:' || r.chat || ':' || r.msg AND a.cancelled_at IS NULL);

      CREATE TABLE IF NOT EXISTS notifications(
        id BIGSERIAL PRIMARY KEY, uid BIGINT NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT, amount INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), read_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS notifications_uid ON notifications(uid, created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_log(
        id BIGSERIAL PRIMARY KEY, actor BIGINT, action TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
];
