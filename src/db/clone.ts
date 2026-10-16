// Тестовый стенд: копия боевых данных в отдельную базу.
// Включается переменной CLONE_FROM_DATABASE_URL (адрес боевой базы).
//  1. Если базы из DATABASE_URL ещё нет на сервере — создаёт её.
//  2. После миграций один раз переносит все строки из боевой базы (только чтение боевой базы!).
//     Переносятся общие для обеих баз колонки — новые колонки тестовой версии остаются по умолчанию.
// Повторно копирование не запускается: факт копии записывается в таблицу clone_info.

import { SQL } from "bun";

const SKIP = new Set(["schema_migrations", "clone_info"]);

function dbName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Создать базу назначения, если её нет (подключаемся к серверу через боевой адрес) */
export async function ensureDatabase(targetUrl: string, sourceUrl: string) {
  const name = dbName(targetUrl);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Имя тестовой базы: латиница, цифры и _");
  if (name === dbName(sourceUrl) && new URL(targetUrl).host === new URL(sourceUrl).host) {
    throw new Error("Тестовая база совпадает с боевой — копирование отменено");
  }
  const admin = new SQL(sourceUrl);
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!exists.length) {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      console.log(`[clone] создана база ${name}`);
    }
  } finally {
    await admin.close();
  }
}

/** Скопировать данные из боевой базы в тестовую (один раз) */
export async function cloneData(target: SQL, sourceUrl: string): Promise<boolean> {
  await target`CREATE TABLE IF NOT EXISTS clone_info(id INT PRIMARY KEY, source TEXT, cloned_at TIMESTAMPTZ NOT NULL DEFAULT now(), rows INT)`;
  if ((await target`SELECT 1 FROM clone_info WHERE id = 1`).length) return false;

  const source = new SQL(sourceUrl);
  let total = 0;
  try {
    const tables = (await source`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`).map((r: any) => r.table_name as string);
    const targetTables = new Set((await target`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((r: any) => r.table_name as string));
    await target.begin(async (tx) => {
      for (const t of tables) {
        if (SKIP.has(t) || !targetTables.has(t)) continue;
        const srcCols = (await source`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${t}`).map((r: any) => r.column_name as string);
        // Тип каждой колонки в тестовой базе: значения приходят текстом и явно приводятся к нему
        const dstTypes = new Map<string, string>((await tx`SELECT a.attname AS c, format_type(a.atttypid, a.atttypmod) AS t
          FROM pg_attribute a WHERE a.attrelid = ${'public."' + t + '"'}::regclass AND a.attnum > 0 AND NOT a.attisdropped`).map((r: any) => [r.c, r.t]));
        const cols = srcCols.filter((c) => dstTypes.has(c));
        if (!cols.length) continue;
        const list = cols.map((c) => `"${c}"`).join(", ");
        await tx.unsafe(`TRUNCATE "${t}" RESTART IDENTITY CASCADE`);
        // ::text — переносим значения как текст, Postgres сам приводит к типу колонки (jsonb, массивы, даты)
        const rows = await source.unsafe(`SELECT ${cols.map((c) => `"${c}"::text AS "${c}"`).join(", ")} FROM "${t}"`);
        for (const r of rows as any[]) {
          const values = cols.map((c) => r[c]);
          const ph = cols.map((c, i) => `$${i + 1}::text::${dstTypes.get(c)}`).join(", ");
          await tx.unsafe(`INSERT INTO "${t}" (${list}) VALUES (${ph})`, values);
        }
        total += rows.length;
        // Счётчики SERIAL — дальше максимального id
        for (const c of cols) {
          const seq = (await tx`SELECT pg_get_serial_sequence(${'"' + t + '"'}, ${c}) AS s`)[0]?.s;
          if (seq) await tx.unsafe(`SELECT setval('${seq}', GREATEST(1, (SELECT COALESCE(MAX("${c}"), 0) FROM "${t}")))`);
        }
        console.log(`[clone] ${t}: ${rows.length}`);
      }
      await tx`INSERT INTO clone_info(id, source, rows) VALUES(1, ${new URL(sourceUrl).host}, ${total})`;
    });
  } finally {
    await source.close();
  }
  console.log(`[clone] скопировано строк: ${total}`);
  return true;
}
