// Разбор отчётов из рабочего чата для обеих ролей.

const TAG = /#отч[её]т(?:дня)?(?![А-Яа-яЁёA-Za-z0-9_])/i;
const LINE = /^\s*([^:\n]{2,60}?)\s*:\s*(\d{1,5})\s*$/gm;
const MAX = 10_000;

export type Role = "qualifier" | "recruiter";

export interface Direction {
  id: number;
  name: string;
  aliases: string[];
  price: number;
}

export interface ReportMetrics {
  calls?: number;
  forms?: number;
  docs?: number;
  vvk?: number;
  contracts?: number;
  /** Контракты по особой цене: id направления → количество */
  special?: Record<string, number>;
}

export type ParseResult =
  | { ok: true; role: Role; metrics: ReportMetrics }
  | { ok: false; reason: "not_report" }
  | { ok: false; reason: "invalid"; message: string };

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

const KEYS: Record<string, keyof Omit<ReportMetrics, "special">> = {
  "обработано недозвонов": "calls",
  "недозвонов обработано": "calls",
  "недозвонов": "calls",
  "недозвоны": "calls",
  "анкет собрано": "forms",
  "собрано анкет": "forms",
  "анкет": "forms",
  "анкеты": "forms",
  "получили документы": "docs",
  "получено документов": "docs",
  "документы": "docs",
  "отправлено на ввк": "vvk",
  "на ввк": "vvk",
  "ввк": "vvk",
  "заключено контрактов": "contracts",
  "контрактов заключено": "contracts",
  "контрактов": "contracts",
  "контракты": "contracts",
};

const QUALIFIER_KEYS = new Set(["calls", "forms"]);
const RECRUITER_KEYS = new Set(["docs", "vvk", "contracts"]);

export function isReportTag(text: string): boolean {
  return TAG.test(text);
}

export function parseReport(text: string, directions: Direction[] = []): ParseResult {
  if (!TAG.test(text)) return { ok: false, reason: "not_report" };
  const metrics: ReportMetrics = {};
  const special: Record<string, number> = {};
  const aliasMap = new Map<string, Direction>();
  for (const d of directions) {
    aliasMap.set(norm(d.name), d);
    for (const a of d.aliases) aliasMap.set(norm(a), d);
  }

  for (const m of text.matchAll(LINE)) {
    const label = norm(m[1].replace(TAG, ""));
    const value = Number(m[2]);
    if (!Number.isInteger(value) || value < 0 || value > MAX) {
      return { ok: false, reason: "invalid", message: `Слишком большое число в строке «${m[1].trim()}»` };
    }
    const key = KEYS[label];
    if (key) {
      metrics[key] = value;
      continue;
    }
    const dir = aliasMap.get(label);
    if (dir) special[String(dir.id)] = (special[String(dir.id)] ?? 0) + value;
  }

  const hasQ = Object.keys(metrics).some((k) => QUALIFIER_KEYS.has(k));
  const hasR = Object.keys(metrics).some((k) => RECRUITER_KEYS.has(k)) || Object.keys(special).length > 0;

  if (!hasQ && !hasR) {
    return { ok: false, reason: "invalid", message: "Не нашёл в отчёте ни одной строки с цифрами" };
  }
  if (hasQ && hasR) {
    return { ok: false, reason: "invalid", message: "В одном отчёте строки и квалификатора, и рекрутера" };
  }

  if (hasR) {
    if (Object.keys(special).length) metrics.special = special;
    const specialTotal = Object.values(special).reduce((s, n) => s + n, 0);
    if (specialTotal > 0 && metrics.contracts === undefined) metrics.contracts = specialTotal;
    if (specialTotal > (metrics.contracts ?? 0)) {
      return { ok: false, reason: "invalid", message: "Контрактов по особой цене больше, чем заключено всего" };
    }
    return { ok: true, role: "recruiter", metrics };
  }
  return { ok: true, role: "qualifier", metrics };
}

/** Деньги за отчёт по текущим ставкам */
export function reportAmount(
  role: Role,
  metrics: ReportMetrics,
  rates: { perForm: number; contractBase: number },
  directions: Direction[],
): number {
  if (role === "qualifier") return (metrics.forms ?? 0) * rates.perForm;
  const special = metrics.special ?? {};
  let total = 0;
  let specialCount = 0;
  for (const [id, n] of Object.entries(special)) {
    const dir = directions.find((d) => String(d.id) === id);
    // направление удалили — считаем по базовой цене
    total += n * (dir ? dir.price : rates.contractBase);
    specialCount += n;
  }
  total += Math.max(0, (metrics.contracts ?? 0) - specialCount) * rates.contractBase;
  return total;
}

/** Шаблон отчёта для подсказки */
export function reportTemplate(role: Role): string {
  return role === "qualifier"
    ? "#отчет\nОбработано недозвонов: 0\nАнкет собрано: 0"
    : "#отчет\nПолучили документы: 0\nОтправлено на ВВК: 0\nЗаключено контрактов: 0\nУфа и офицеры: 0";
}

/** Совместимость с v1: только квалификаторский отчёт */
export function parseQualifierReport(text: string): { forms: number } | null {
  const r = parseReport(text);
  if (!r.ok || r.role !== "qualifier" || r.metrics.forms === undefined) return null;
  if (r.metrics.forms > 500) return null;
  return { forms: r.metrics.forms };
}
