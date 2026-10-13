import type { SQL } from "bun";
import { db as defaultDb } from "./client.ts";
import { migrations, type Migration } from "./migrations.ts";

const LOCK_KEY = 74_130_2026; // любое постоянное число: не даёт двум копиям мигрировать одновременно

export async function migrate(db: SQL = defaultDb, list: Migration[] = migrations): Promise<string[]> {
  const applied: string[] = [];
  await db`CREATE TABLE IF NOT EXISTS schema_migrations(
    id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await db`SELECT pg_advisory_lock(${LOCK_KEY})`;
  try {
    const done = new Set((await db`SELECT id FROM schema_migrations`).map((r: { id: string }) => r.id));
    for (const m of list) {
      if (done.has(m.id)) continue;
      await db.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations(id) VALUES(${m.id})`;
      });
      applied.push(m.id);
      console.log(`[migrate] applied ${m.id}`);
    }
  } finally {
    await db`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
  return applied;
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `[migrate] done: ${applied.join(", ")}` : "[migrate] nothing to apply");
  process.exit(0);
}
