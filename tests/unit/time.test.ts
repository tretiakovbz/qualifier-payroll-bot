import { describe, expect, test } from "bun:test";
import { periodOf, periodBack, dayOfMessage, addDays } from "../../src/lib/time.ts";

const d = (s: string) => new Date(s + "T12:00:00Z");

describe("расчётные периоды", () => {
  test("5–19 число", () => {
    expect(periodOf(d("2026-10-05"))).toEqual(["2026-10-05", "2026-10-19"]);
    expect(periodOf(d("2026-10-19"))).toEqual(["2026-10-05", "2026-10-19"]);
  });
  test("20–4 число через границу месяца", () => {
    expect(periodOf(d("2026-10-20"))).toEqual(["2026-10-20", "2026-11-04"]);
    expect(periodOf(d("2026-11-04"))).toEqual(["2026-10-20", "2026-11-04"]);
  });
  test("через границу года", () => {
    expect(periodOf(d("2026-12-25"))).toEqual(["2026-12-20", "2027-01-04"]);
    expect(periodOf(d("2027-01-02"))).toEqual(["2026-12-20", "2027-01-04"]);
  });
  test("предыдущие периоды", () => {
    const now = d("2026-10-14");
    expect(periodBack(0, now)).toEqual(["2026-10-05", "2026-10-19"]);
    expect(periodBack(1, now)).toEqual(["2026-09-20", "2026-10-04"]);
    expect(periodBack(2, now)).toEqual(["2026-09-05", "2026-09-19"]);
  });
});

describe("дни", () => {
  test("отчёт в 22:30 UTC — уже следующий день по Москве", () => {
    const t = Date.UTC(2026, 9, 13, 22, 30) / 1000;
    expect(dayOfMessage(t)).toBe("2026-10-14");
  });
  test("addDays", () => {
    expect(addDays("2026-10-14", -6)).toBe("2026-10-08");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
