import { describe, expect, test } from "bun:test";
import { parseReport, parseQualifierReport, reportAmount, type Direction } from "../../src/lib/report.ts";

const DIRS: Direction[] = [{ id: 1, name: "Уфа и офицеры", aliases: ["уфа и офицеры", "уфа", "офицеры"], price: 50000 }];
const RATES = { perForm: 500, contractBase: 80000 };

describe("отчёт квалификатора", () => {
  test("обычный отчёт", () => {
    expect(parseReport("#отчет\nОбработано недозвонов: 102\nАнкет собрано: 5")).toEqual({ ok: true, role: "qualifier", metrics: { calls: 102, forms: 5 } });
  });
  test("варианты тега и пробелов", () => {
    expect(parseQualifierReport("#отчёт Анкет собрано: 3")).toEqual({ forms: 3 });
    expect(parseQualifierReport("#ОтчетДня\nАнкет  собрано:7")).toEqual({ forms: 7 });
  });
  test("ноль — тоже отчёт", () => {
    expect(parseReport("#отчет\nОбработано недозвонов: 0\nАнкет собрано: 0")).toMatchObject({ ok: true, metrics: { calls: 0, forms: 0 } });
  });
  test("не отчёт или без цифр", () => {
    expect(parseReport("Анкет собрано: 5")).toEqual({ ok: false, reason: "not_report" });
    expect(parseReport("#отчетный период")).toEqual({ ok: false, reason: "not_report" });
    expect(parseReport("#отчет без цифр")).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseQualifierReport("#отчет\nАнкет собрано: 900")).toBeNull();
  });
  test("деньги: анкеты × ставка", () => {
    expect(reportAmount("qualifier", { calls: 102, forms: 5 }, RATES, DIRS)).toBe(2500);
  });
});

describe("отчёт рекрутера", () => {
  const text = "#отчет\nПолучили документы: 4\nОтправлено на ВВК: 2\nЗаключено контрактов: 3\nУфа и офицеры: 1";

  test("разбор с особой ценой", () => {
    expect(parseReport(text, DIRS)).toEqual({
      ok: true,
      role: "recruiter",
      metrics: { docs: 4, vvk: 2, contracts: 3, special: { "1": 1 } },
    });
  });
  test("пример из ТЗ: 2 × 80 000 + 1 × 50 000 = 210 000", () => {
    const r = parseReport(text, DIRS);
    if (!r.ok) throw new Error("not parsed");
    expect(reportAmount("recruiter", r.metrics, RATES, DIRS)).toBe(210000);
  });
  test("короткие названия направлений тоже работают", () => {
    const r = parseReport("#отчет\nЗаключено контрактов: 2\nУфа: 1\nОфицеры: 1", DIRS);
    if (!r.ok) throw new Error("not parsed");
    expect(r.metrics.special).toEqual({ "1": 2 });
    expect(reportAmount("recruiter", r.metrics, RATES, DIRS)).toBe(100000);
  });
  test("без контрактов — ноль рублей", () => {
    const r = parseReport("#отчет\nПолучили документы: 4\nОтправлено на ВВК: 2", DIRS);
    if (!r.ok) throw new Error("not parsed");
    expect(reportAmount("recruiter", r.metrics, RATES, DIRS)).toBe(0);
  });
  test("особых больше, чем всего — ошибка", () => {
    expect(parseReport("#отчет\nЗаключено контрактов: 1\nУфа и офицеры: 2", DIRS)).toMatchObject({ ok: false, reason: "invalid" });
  });
  test("строки двух ролей в одном отчёте — ошибка", () => {
    expect(parseReport("#отчет\nАнкет собрано: 2\nЗаключено контрактов: 1", DIRS)).toMatchObject({ ok: false, reason: "invalid" });
  });
  test("удалённое направление считается по базовой цене", () => {
    expect(reportAmount("recruiter", { contracts: 2, special: { "99": 1 } }, RATES, DIRS)).toBe(160000);
  });
});
