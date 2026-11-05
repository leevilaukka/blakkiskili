export interface Config {
  botToken: string;
  appSecret: string;
  dbPath: string;
  adminIds: number[];
  mode: "polling" | "webhook";
  webhookUrl?: string;
  webhookSecret?: string;
  port: number;
  maintainer?: string; // name shown in /about and help, e.g. "leevilaukka"
  maintainerTelegram?: string; // Telegram username without "@", shown next to the name
  sourceUrl?: string; // link to this bot's source code, shown in /about
  inactivity: { deleteAfterDays: number; warnDaysBefore: number }; // deleteAfterDays 0 = keep forever
  backup: { dir?: string; everyMinutes: number }; // no dir = snapshots disabled
  productsUrl?: string; // Alkometriikka data.json; undefined = product search disabled
  accountLinking: boolean; // show "Yhdistetyt palvelut" and /yhdista (useful once another platform has a bot)
  barcodesUrl?: string; // Alkometriikka backend; undefined = barcode links disabled
  barcodesKey?: string; // lets the bot link barcodes; without it barcodes are lookup-only
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

/** "@handle" or "handle" → "handle"; validated against Telegram's username rules. */
function telegramHandle(raw: string | undefined): string | undefined {
  const handle = raw?.trim().replace(/^@/, "");
  if (!handle) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(handle)) {
    throw new Error("MAINTAINER_TELEGRAM must be a Telegram username (5–32 letters, digits or _)");
  }
  return handle;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(): Config {
  const mode = (process.env.BOT_MODE ?? "polling") as Config["mode"];
  if (mode !== "polling" && mode !== "webhook") throw new Error("BOT_MODE must be polling or webhook");
  const config: Config = {
    botToken: required("BOT_TOKEN"),
    appSecret: required("APP_SECRET"),
    dbPath: process.env.DB_PATH ?? "./data/kili.sqlite",
    adminIds: (process.env.ADMIN_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
    mode,
    webhookUrl: process.env.WEBHOOK_URL || undefined,
    webhookSecret: process.env.WEBHOOK_SECRET || undefined,
    port: Number(process.env.PORT ?? 8080),
    maintainer: process.env.MAINTAINER || undefined,
    maintainerTelegram: telegramHandle(process.env.MAINTAINER_TELEGRAM),
    sourceUrl: process.env.SOURCE_URL || undefined,
    inactivity: {
      deleteAfterDays: intEnv("INACTIVE_DELETE_DAYS", 730),
      warnDaysBefore: intEnv("INACTIVE_WARN_DAYS", 30),
    },
    // Unset → the public Alkometriikka catalogue; set to an empty value to disable search.
    productsUrl:
      process.env.ALKOMETRIIKKA_URL === undefined
        ? "https://alkometriikka.fi/data.json"
        : process.env.ALKOMETRIIKKA_URL || undefined,
    accountLinking: ["1", "true", "yes"].includes((process.env.ACCOUNT_LINKING ?? "").trim().toLowerCase()),
    barcodesUrl: process.env.ALKOMETRIIKKA_API_URL || undefined,
    barcodesKey: process.env.ALKOMETRIIKKA_API_KEY || undefined,
    backup: {
      dir: process.env.BACKUP_DIR || undefined,
      everyMinutes: Math.max(1, intEnv("BACKUP_EVERY_MINUTES", 60)),
    },
  };
  const { deleteAfterDays, warnDaysBefore } = config.inactivity;
  if (deleteAfterDays > 0 && (warnDaysBefore < 1 || warnDaysBefore >= deleteAfterDays)) {
    throw new Error("INACTIVE_WARN_DAYS must be at least 1 and less than INACTIVE_DELETE_DAYS");
  }
  if (mode === "webhook" && (!config.webhookUrl || !config.webhookSecret)) {
    throw new Error("Webhook mode needs WEBHOOK_URL and WEBHOOK_SECRET");
  }
  return config;
}
