import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { escapeHtml } from "../lib/format.ts";

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
