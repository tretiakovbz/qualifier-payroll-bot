// Текущая компания запроса. Каждый вебхук, запрос из Mini App и задача планировщика
// выполняются внутри withCompany(id) — все запросы к данным берут id отсюда,
// поэтому данные одной компании никогда не попадают в другую.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ companyId: number }>();

export class NoCompanyError extends Error {
  constructor() {
    super("Нет компании: войдите по ссылке-приглашению или создайте свою");
  }
}

/** id текущей компании; без компании — ошибка (защита от запроса «ко всем сразу») */
export function cid(): number {
  const c = store.getStore();
  if (!c) throw new NoCompanyError();
  return c.companyId;
}

/** id текущей компании или null */
export function tryCid(): number | null {
  return store.getStore()?.companyId ?? null;
}

export function withCompany<T>(companyId: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ companyId: Number(companyId) }, fn);
}
