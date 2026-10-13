import { describe, expect, test } from "bun:test";
import { parseQualifierReport } from "../../src/lib/report.ts";

describe("отчёт квалификатора", () => {
  test("обычный отчёт", () => {
    expect(parseQualifierReport("#отчет\nОбработано недозвонов: 102\nАнкет собрано: 5")).toEqual({ forms: 5 });
  });
  test("варианты тега", () => {
    expect(parseQualifierReport("#отчёт Анкет собрано: 3")).toEqual({ forms: 3 });
    expect(parseQualifierReport("#ОтчетДня\nАнкет  собрано:7")).toEqual({ forms: 7 });
  });
  test("ноль анкет — тоже отчёт", () => {
    expect(parseQualifierReport("#отчет\nАнкет собрано: 0")).toEqual({ forms: 0 });
  });
  test("не отчёт", () => {
    expect(parseQualifierReport("Анкет собрано: 5")).toBeNull();
    expect(parseQualifierReport("#отчетный период")).toBeNull();
    expect(parseQualifierReport("#отчет без цифр")).toBeNull();
    expect(parseQualifierReport("#отчет\nАнкет собрано: 900")).toBeNull();
  });
});
