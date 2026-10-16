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
  {
    // Исправление 002: квалификаторами из v1 считаем только тех, у кого есть отчёты.
    // Кто просто писал боту (например, админы), — «не зарегистрирован»; их оклад отменяется.
    id: "003_v1_staff_only_with_reports",
    sql: `
      WITH demoted AS (
        UPDATE employees e SET role = NULL, status = 'new', approved_at = NULL
        WHERE e.role = 'qualifier' AND e.status = 'active'
          AND e.registered_at IS NULL AND e.approved_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.uid = e.uid)
        RETURNING e.uid
      )
      UPDATE accruals a SET cancelled_at = now()
      FROM demoted d
      WHERE a.uid = d.uid AND a.kind = 'salary' AND a.cancelled_at IS NULL;
    `,
  },
  {
    // Акции (множитель, порог, конкурс, новость) и сторис, которые создаёт админ
    id: "004_promos_stories",
    sql: `
      CREATE TABLE IF NOT EXISTS promotions(
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'all', metric TEXT,
        multiplier NUMERIC(6,2), threshold INTEGER, amount INTEGER,
        period TEXT NOT NULL DEFAULT 'range', weekdays JSONB NOT NULL DEFAULT '[]',
        starts_on DATE NOT NULL, ends_on DATE NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE, split_ties BOOLEAN NOT NULL DEFAULT TRUE,
        created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS promo_runs(
        promo_id INTEGER NOT NULL, period_key TEXT NOT NULL, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        winners JSONB NOT NULL DEFAULT '[]', PRIMARY KEY(promo_id, period_key)
      );
      CREATE TABLE IF NOT EXISTS stories(
        id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT, big TEXT,
        style TEXT NOT NULL DEFAULT 'accent', role TEXT NOT NULL DEFAULT 'all',
        promo_id INTEGER, starts_on DATE NOT NULL, ends_on DATE NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // Полученные достижения: запоминаются навсегда, поздравление — один раз
    id: "005_achievements",
    sql: `
      CREATE TABLE IF NOT EXISTS achievements_earned(
        uid BIGINT NOT NULL, code TEXT NOT NULL, earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(uid, code)
      );
    `,
  },
  {
    // Запуск v2: все, кто сдавал отчёты через старого бота и ещё без роли, — действующие квалификаторы
    id: "006_launch_activate_v1_reporters",
    sql: `
      UPDATE employees e SET role = 'qualifier', status = 'active', approved_at = now(),
        full_name = COALESCE(NULLIF(e.full_name, ''), NULLIF(e.name, ''))
      WHERE e.role IS NULL AND e.registered_at IS NULL
        AND EXISTS (SELECT 1 FROM reports r WHERE r.uid = e.uid AND r.role = 'qualifier');
    `,
  },
  {
    // Индивидуальный оклад: свой размер в месяц, первый рабочий день (неполный период считается
    // пропорционально рабочим дням) и ручная сумма оклада за любой расчётный период
    id: "007_salary_individual",
    sql: `
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_monthly INTEGER;
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_start DATE;
      CREATE TABLE IF NOT EXISTS salary_overrides(
        uid BIGINT NOT NULL, period_start DATE NOT NULL, amount INTEGER NOT NULL,
        comment TEXT, set_by BIGINT, set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(uid, period_start)
      );
    `,
  },
  {
    // Много компаний в одном боте: у каждой своя команда, рабочий чат, настройки и данные.
    // Существующие данные переносятся в компанию № 1 при старте (см. core/companies.ts → bootstrapLegacy).
    id: "008_companies",
    sql: `
      CREATE TABLE IF NOT EXISTS companies(
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, owner_uid BIGINT NOT NULL,
        invite_code TEXT NOT NULL UNIQUE, bind_code TEXT NOT NULL UNIQUE,
        group_id BIGINT UNIQUE, group_title TEXT,
        referred_by BIGINT, legacy BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS company_id INTEGER, ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE accruals ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE directions ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE bonus_rules ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE stories ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE salary_overrides ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE bonus_rules DROP CONSTRAINT IF EXISTS bonus_rules_code_key;
      CREATE UNIQUE INDEX IF NOT EXISTS bonus_rules_company_code ON bonus_rules(company_id, code) WHERE code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS employees_company ON employees(company_id);
      CREATE INDEX IF NOT EXISTS reports_company_day ON reports(company_id, day);
      CREATE INDEX IF NOT EXISTS accruals_company_period ON accruals(company_id, period_start);
    `,
  },
];
