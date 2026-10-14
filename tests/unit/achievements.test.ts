import { describe, expect, test } from "bun:test";
import { evaluate, streaks, defsFor, type Stats } from "../../src/core/achievements.ts";

const W = { startDow: 0, days: 5 }; // вс–чт
const base: Stats = { reports: 0, forms: 0, calls: 0, contracts: 0, docs: 0, vvk: 0, bestDayForms: 0, bestWeekForms: 0, bestMonthContracts: 0, streak: 0, bestStreak: 0, bonuses: 0, topWins: 0 };

describe("серии рабочих дней", () => {
  test("пятница и суббота не рвут серию", () => {
    // чт 15.10, вс 18.10, пн 19.10 — подряд по рабочим дням
    expect(streaks(["2026-10-15", "2026-10-18", "2026-10-19"], "2026-10-19", W)).toEqual({ current: 3, best: 3 });
  });
  test("сегодня ещё не отчитался — серия считается со вчера", () => {
    expect(streaks(["2026-10-13", "2026-10-14"], "2026-10-15", W).current).toBe(2);
  });
  test("пропуск рабочего дня обнуляет текущую, лучшая остаётся", () => {
    const days = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-11"];
    expect(streaks(days, "2026-10-12", W)).toEqual({ current: 1, best: 4 });
  });
  test("нет отчётов", () => {
    expect(streaks([], "2026-10-12", W)).toEqual({ current: 0, best: 0 });
  });
});

describe("достижения", () => {
  test("у каждой роли 12 своих, без чужих", () => {
    const q = defsFor("qualifier").map((d) => d.code);
    const r = defsFor("recruiter").map((d) => d.code);
    expect(q.length).toBe(12);
    expect(r.length).toBe(12);
    expect(q).not.toContain("contract_1");
    expect(r).not.toContain("forms_100");
  });
  test("выполненные и прогресс", () => {
    const res = evaluate("qualifier", { ...base, reports: 3, forms: 140, bestDayForms: 11, bestStreak: 4, topWins: 1 });
    const by = Object.fromEntries(res.map((x) => [x.code, x]));
    expect(by.first_report.done).toBe(true);
    expect(by.forms_100.done).toBe(true);
    expect(by.forms_500).toMatchObject({ done: false, value: 140, target: 500 });
    expect(by.day_10.done).toBe(true);
    expect(by.streak_5).toMatchObject({ done: false, value: 4 });
    expect(by.champion.done).toBe(true);
    expect(by.champion_3.done).toBe(false);
  });
  test("прогресс не больше цели", () => {
    const res = evaluate("recruiter", { ...base, contracts: 75 });
    expect(res.find((x) => x.code === "contracts_10")!.value).toBe(10);
  });
});
