import { describe, expect, test } from "bun:test";
import { pickWinners, shareOf } from "../../src/core/bonuses.ts";
import { pickIndex } from "../../src/lib/phrases.ts";
import { weekOf, lastCompletedWeek, monthOf, lastCompletedMonth, periodOf, humanRange, humanDay } from "../../src/lib/time.ts";

describe("победители бонуса", () => {
  const rows = (...v: number[]) => v.map((value, i) => ({ uid: i + 1, name: `С${i + 1}`, value }));

  test("один лидер", () => {
    expect(pickWinners(rows(24, 20, 17), 20).map((w) => w.uid)).toEqual([1]);
  });
  test("ниже порога — никому", () => {
    expect(pickWinners(rows(19, 15), 20)).toEqual([]);
  });
  test("все по нулям — никому", () => {
    expect(pickWinners(rows(0, 0), 0)).toEqual([]);
  });
  test("ничья — все лидеры", () => {
    expect(pickWinners(rows(22, 22, 10), 20).map((w) => w.uid)).toEqual([1, 2]);
  });
  test("деление при ничьей", () => {
    expect(shareOf(5000, 2, true)).toBe(2500);
    expect(shareOf(5000, 3, true)).toBe(1666);
    expect(shareOf(5000, 2, false)).toBe(5000);
    expect(shareOf(5000, 0, true)).toBe(0);
  });
});

describe("фразы бота", () => {
  test("не повторяет предыдущую", () => {
    for (let prev = 0; prev < 5; prev++) {
      for (const r of [0, 0.3, 0.6, 0.99]) {
        const i = pickIndex(5, prev, () => r);
        expect(i).not.toBe(prev);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(5);
      }
    }
  });
  test("первый раз — любая", () => {
    expect(pickIndex(5, -1, () => 0)).toBe(0);
  });
});

describe("рабочая неделя вс–чт", () => {
  test("неделя по дате", () => {
    expect(weekOf("2026-10-14")).toEqual(["2026-10-11", "2026-10-15"]); // среда → вс 11 – чт 15
    expect(weekOf("2026-10-11")).toEqual(["2026-10-11", "2026-10-15"]);
    expect(weekOf("2026-10-17")).toEqual(["2026-10-11", "2026-10-15"]); // суббота — ещё та же неделя
  });
  test("последняя завершённая неделя", () => {
    expect(lastCompletedWeek("2026-10-14")).toEqual(["2026-10-04", "2026-10-08"]);
    expect(lastCompletedWeek("2026-10-16")).toEqual(["2026-10-11", "2026-10-15"]); // пятница
    expect(lastCompletedWeek("2026-10-18")).toEqual(["2026-10-11", "2026-10-15"]); // воскресенье утром — итоги прошлой
  });
  test("месяц", () => {
    expect(monthOf("2026-02-10")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(lastCompletedMonth("2026-11-01")).toEqual(["2026-10-01", "2026-10-31"]);
  });
  test("другие дни выплат", () => {
    expect(periodOf("2026-10-14", [10, 25])).toEqual(["2026-10-10", "2026-10-24"]);
    expect(periodOf("2026-10-05", [10, 25])).toEqual(["2026-09-25", "2026-10-09"]);
  });
  test("по-русски", () => {
    expect(humanDay("2026-10-20")).toBe("20 октября");
    expect(humanRange(["2026-10-05", "2026-10-19"])).toBe("5–19 октября");
    expect(humanRange(["2026-10-20", "2026-11-04"])).toBe("20 октября – 4 ноября");
  });
});
