// Тонкая обёртка над Telegram Bot API и проверка подписи Mini App.

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
  photo_url?: string;
}

export async function api<T = any>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.telegramApiBase}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<T>;
}

export function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return api("sendMessage", { chat_id: chatId, text, ...extra });
}

export async function sendDocument(chatId: number, file: Blob, filename: string): Promise<boolean> {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", file, filename);
  const res = await fetch(`${config.telegramApiBase}/bot${config.botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const json = (await res.json()) as { ok: boolean };
  return json.ok;
}

export function fullName(u: Pick<TgUser, "first_name" | "last_name">): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ");
}

/**
 * Проверяет initData из Telegram Mini App.
 * Возвращает пользователя или null, если подпись неверна или устарела (>24 ч).
 */
export function verifyInitData(raw: string, botToken = config.botToken, nowMs = Date.now()): TgUser | null {
  try {
    const q = new URLSearchParams(raw);
    const hash = q.get("hash") ?? "";
    q.delete("hash");
    const check = [...q.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const key = createHmac("sha256", "WebAppData").update(botToken).digest();
    const expected = createHmac("sha256", key).update(check).digest("hex");
    if (!hash || hash.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"))) return null;
    const stamp = Number(q.get("auth_date"));
    if (!stamp || Math.abs(nowMs / 1000 - stamp) > 86400) return null;
    return JSON.parse(q.get("user") ?? "null");
  } catch {
    return null;
  }
}
