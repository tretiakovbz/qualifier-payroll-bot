import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyInitData } from "../../src/lib/telegram.ts";

const TOKEN = "123456:TEST-TOKEN";

function sign(params: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(params)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

describe("подпись Mini App", () => {
  const now = Date.UTC(2026, 9, 14, 12, 0);
  const user = JSON.stringify({ id: 42, first_name: "Анна" });
  const fresh = String(Math.floor(now / 1000) - 60);

  test("верная подпись", () => {
    expect(verifyInitData(sign({ auth_date: fresh, user }), TOKEN, now)).toEqual({ id: 42, first_name: "Анна" });
  });
  test("чужой токен", () => {
    expect(verifyInitData(sign({ auth_date: fresh, user }, "999:OTHER"), TOKEN, now)).toBeNull();
  });
  test("подделанный пользователь", () => {
    const raw = sign({ auth_date: fresh, user }).replace("42", "43");
    expect(verifyInitData(raw, TOKEN, now)).toBeNull();
  });
  test("устаревшая подпись", () => {
    const old = String(Math.floor(now / 1000) - 2 * 86400);
    expect(verifyInitData(sign({ auth_date: old, user }), TOKEN, now)).toBeNull();
  });
  test("мусор", () => {
    expect(verifyInitData("hash=zz", TOKEN, now)).toBeNull();
    expect(verifyInitData("", TOKEN, now)).toBeNull();
  });
});
