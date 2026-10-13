// Разбор отчётов из рабочего чата.

const TAG = /#отч[её]т(?:дня)?(?![А-Яа-яЁёA-Za-z0-9_])/i;
const FORMS = /Анкет\s+собрано:\s*(\d+)/i;

export interface QualifierReport {
  forms: number;
}

/** Отчёт квалификатора v1: «#отчет … Анкет собрано: N». null — не отчёт. */
export function parseQualifierReport(text: string): QualifierReport | null {
  if (!TAG.test(text)) return null;
  const m = text.match(FORMS);
  if (!m) return null;
  const forms = Number(m[1]);
  if (!Number.isInteger(forms) || forms < 0 || forms > 500) return null;
  return { forms };
}
