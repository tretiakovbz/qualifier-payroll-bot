import type { SQL } from "bun";
import { db as defaultDb } from "./client.ts";
import { migrations, type Migration } from "./migrations.ts";

const LOCK_KEY = 741302026; // постоянное число: не даёт двум копиям сервиса мигрировать одновременно

/**
 * Применяет новые миграции в одной транзакции под транзакционной блокировкой.
 * Если что-то упало — не применяется ничего, база остаётся как была.
 */
export async function migrate(db: SQL = defaultDb, list: Migration[] = migrations): Promise<string[]> {
  const applied: string[] = [];
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations(
      id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    const done = new Set((await tx`SELECT id FROM schema_migrations`).map((r: { id: string }) => r.id));
    for (const m of list) {
      if (done.has(m.id)) continue;
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations(id) VALUES(${m.id})`;
      applied.push(m.id);
    }
  });
  for (const id of applied) console.log(`[migrate] applied ${id}`);
  return applied;
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `[migrate] done: ${applied.join(", ")}` : "[migrate] nothing to apply");
  process.exit(0);
}
