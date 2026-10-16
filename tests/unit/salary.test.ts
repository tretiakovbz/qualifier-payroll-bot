import { describe, expect, test } from "bun:test";
import { calcSalary, workDaysIn, isWorkDay } from "../../src/core/salary.ts";

const WEEK = { startDow: 0, days: 5 }; // вс–чт

describe("оклад", () => {
  test("рабочие дни вс–чт", () => {
    expect(isWorkDay("2026-10-11", WEEK)).toBe(true); // воскресенье
    expect(isWorkDay("2026-10-16", WEEK)).toBe(false); // пятница
    expect(workDaysIn("2026-10-05", "2026-10-19", WEEK)).toBe(11);
  });
  test("полный период — половина месяца", () => {
    expect(calcSalary(20000, ["2026-10-20", "2026-11-04"], WEEK, null)).toMatchObject({ amount: 10000, prorated: null });
    expect(calcSalary(20000, ["2026-10-20", "2026-11-04"], WEEK, "2026-10-12").amount).toBe(10000);
  });
  test("вышла 12 октября — по отработанным дням", () => {
    const c = calcSalary(20000, ["2026-10-05", "2026-10-19"], WEEK, "2026-10-12");
    expect(c.prorated).toEqual({ from: "2026-10-12", worked: 6, total: 11 });
    expect(c.amount).toBe(Math.round((10000 * 6) / 11));
  });
  test("ещё не вышла — ноль", () => {
    expect(calcSalary(20000, ["2026-10-05", "2026-10-19"], WEEK, "2026-10-25")).toMatchObject({ amount: 0, notStarted: true });
  });
});
