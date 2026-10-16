// Направления с особой ценой контракта («Уфа и офицеры» и т.п.)

import { db } from "../db/client.ts";
import { audit, pgTextArray } from "../db/audit.ts";
import type { Direction } from "../lib/report.ts";
import { cid } from "./tenant.ts";

export async function listDirections(includeInactive = false): Promise<(Direction & { active: boolean })[]> {
  const rows = includeInactive
    ? await db`SELECT id, name, aliases, price, active FROM directions WHERE company_id = ${cid()} ORDER BY sort, id`
    : await db`SELECT id, name, aliases, price, active FROM directions WHERE company_id = ${cid()} AND active ORDER BY sort, id`;
  return rows.map((r: any) => ({ ...r, aliases: r.aliases ?? [] }));
}

export async function saveDirection(
  d: { id?: number; name: string; aliases?: string[]; price: number; active?: boolean },
  actor: number,
) {
  const aliases = (d.aliases ?? [d.name]).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!d.name.trim() || !(d.price >= 0)) throw new Error("Укажите название и цену");
  let row;
  if (d.id) {
    [row] = await db`UPDATE directions SET name = ${d.name}, aliases = ${pgTextArray(aliases)}::text[], price = ${d.price},
      active = ${d.active ?? true} WHERE id = ${d.id} AND company_id = ${cid()} RETURNING *`;
  } else {
    [row] = await db`INSERT INTO directions(company_id, name, aliases, price, active) VALUES(${cid()}, ${d.name}, ${pgTextArray(aliases)}::text[], ${d.price}, ${d.active ?? true}) RETURNING *`;
  }
  await audit(actor, "direction.save", row);
  return row;
}
