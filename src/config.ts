// Все настройки берутся из переменных окружения Railway.
// Ничего секретного в коде не хранится.

const env = Bun.env;

function num(name: string, fallback = 0): number {
  const v = Number(env[name] ?? fallback);
  return Number.isFinite(v) ? v : fallback;
}

function list(name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  serviceName: env.SERVICE_NAME ?? "qualifier-bot",
  version: "2.0.0-stage1",
  port: num("PORT", 3000),

  botToken: env.BOT_TOKEN ?? "",
  /** Адрес Telegram Bot API (меняется только в тестах) */
  telegramApiBase: env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
  webhookSecret: env.WEBHOOK_SECRET ?? "",
  databaseUrl: env.DATABASE_URL ?? "",
  publicUrl: env.PUBLIC_URL ?? "",

  /** Рабочий чат, куда сотрудники пишут отчёты */
  groupId: num("GROUP_ID"),
  /** Telegram ID владельца (поддерживается список через запятую) */
  adminIds: list("ADMIN_IDS").map(Number).filter(Number.isFinite),
  /** Ники тех, кто может подтверждать отчёты (без @), через запятую */
  approverUsernames: list("APPROVER_USERNAMES").map((s) => s.replace(/^@/, "").toLowerCase()),
  /** Ставка за подтверждённую анкету, ₽ */
  ratePerForm: num("RATE_PER_FORM", 500),
  /** Часовой пояс отчётности в часах от UTC (Москва = 3) */
  tzOffsetHours: num("TZ_OFFSET_HOURS", 3),
};

export function isAdmin(userId: number | undefined): boolean {
  return userId !== undefined && config.adminIds.includes(userId);
}

export function canApprove(user: { id?: number; username?: string } | undefined): boolean {
  if (!user) return false;
  if (isAdmin(user.id)) return true;
  const name = (user.username ?? "").toLowerCase();
  return name !== "" && config.approverUsernames.includes(name);
}
