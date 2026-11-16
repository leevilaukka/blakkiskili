import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { escapeHtml, fmt, num, raw } from "../lib/format.ts";
import { describeError, redact } from "../lib/redact.ts";
import { cl } from "../lib/servings.ts";
import { PRODUCTS_MAX, PRODUCTS_PER_ACCOUNT, type CustomProduct } from "../services/customproducts.ts";
import type { Services } from "../services/index.ts";
import { S } from "../strings.ts";

/**
 * Sends an operational alert to every admin in ADMIN_IDS. Never throws. Alerts for the same
 * key are sent at most once per `cooldownMs` so a job failing every hour doesn't spam.
 */
export function createAdminAlerts(api: Api, config: Config, cooldownMs = 12 * 3600_000, now = () => Date.now()) {
  const lastSent = new Map<string, number>();
  return async function alert(key: string, message: string) {
    message = redact(message, [config.botToken]);
    console.error(`[alert:${key}] ${message}`);
    const last = lastSent.get(key);
    if (last !== undefined && now() - last < cooldownMs) return;
    lastSent.set(key, now());
    const text = `⚠️ <b>Bläkkiskili: ${escapeHtml(key)}</b>\n\n${escapeHtml(message.slice(0, 3000))}`;
    for (const id of config.adminIds) {
      await api.sendMessage(id, text, { parse_mode: "HTML" }).catch((e) => console.error("Could not alert admin:", describeError(e)));
    }
  };
}

/** Sends a message to every admin in ADMIN_IDS. Never throws. */
export async function notifyAdmins(api: Api, adminIds: readonly number[], html: string): Promise<void> {
  for (const id of adminIds) {
    await api.sendMessage(id, html, { parse_mode: "HTML" }).catch((e) => console.error("Could not notify admin:", describeError(e)));
  }
}

/** The admins' message about a new "Ilmoita virheestä" report (no reporter: admins don't see who it was). */
export function productReportNotice(p: CustomProduct, message: string): string {
  return fmt(S.custom.report_admin, {
    name: p.name,
    kind: S.custom.kind_names[p.kind],
    size: cl(p.sizeL),
    abv: num(p.abv),
    ean: p.ean,
    message,
  });
}

/**
 * The admins' message when someone can't add a product because of a limit ("too_many": theirs,
 * "full": the total), or null when they were already told recently (CustomProducts.limitNotice).
 * `origin` is the website's, for a link to the admin page.
 */
export function limitNotice(services: Services, accountId: string, reason: "too_many" | "full", origin?: string): string | null {
  if (!services.customProducts.limitNotice(reason === "full" ? "full" : accountId)) return null;
  const link = raw(origin ? fmt(S.custom.admin_link, { link: `${origin}/admin` }) : "");
  if (reason === "full") return fmt(S.custom.full_admin, { count: PRODUCTS_MAX, link });
  const name = services.accounts.get(accountId)?.name ?? "?";
  return fmt(S.custom.limit_admin, { name, count: PRODUCTS_PER_ACCOUNT, link });
}

/** Sends a message to the account's Telegram login, in private. False when it has none or Telegram refuses. Never throws. */
export async function messageAccount(api: Api, services: Services, accountId: string, html: string): Promise<boolean> {
  const contact = services.identities.contacts(accountId).find((c) => c.platform === "telegram");
  const chatId = Number(contact?.address);
  if (!contact || !Number.isSafeInteger(chatId)) return false;
  try {
    await api.sendMessage(chatId, html, { parse_mode: "HTML" });
    return true;
  } catch (e) {
    console.error("Could not message a user:", describeError(e));
    return false;
  }
}
