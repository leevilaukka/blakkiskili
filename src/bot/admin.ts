import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { escapeHtml, fmt, num } from "../lib/format.ts";
import { cl } from "../lib/servings.ts";
import type { CustomProduct } from "../services/customproducts.ts";
import { S } from "../strings.ts";

/**
 * Sends an operational alert to every admin in ADMIN_IDS. Never throws. Alerts for the same
 * key are sent at most once per `cooldownMs` so a job failing every hour doesn't spam.
 */
export function createAdminAlerts(api: Api, config: Config, cooldownMs = 12 * 3600_000, now = () => Date.now()) {
  const lastSent = new Map<string, number>();
  return async function alert(key: string, message: string) {
    console.error(`[alert:${key}] ${message}`);
    const last = lastSent.get(key);
    if (last !== undefined && now() - last < cooldownMs) return;
    lastSent.set(key, now());
    const text = `⚠️ <b>Bläkkiskili: ${escapeHtml(key)}</b>\n\n${escapeHtml(message.slice(0, 3000))}`;
    for (const id of config.adminIds) {
      await api.sendMessage(id, text, { parse_mode: "HTML" }).catch((e) => console.error("Could not alert admin:", e));
    }
  };
}

/** Sends a message to every admin in ADMIN_IDS. Never throws. */
export async function notifyAdmins(api: Api, adminIds: readonly number[], html: string): Promise<void> {
  for (const id of adminIds) {
    await api.sendMessage(id, html, { parse_mode: "HTML" }).catch((e) => console.error("Could not notify admin:", e));
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
