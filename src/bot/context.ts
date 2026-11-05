import type { Context } from "grammy";
import type { User } from "grammy/types";
import type { Config } from "../config.ts";
import type { Profile } from "../services/accounts.ts";
import type { Services } from "../services/index.ts";
import { fmt, raw } from "../lib/format.ts";
import { S } from "../strings.ts";

export interface KiliFlavor {
  /** HMAC of the sender's Telegram id; null for updates without a human sender. */
  userId: string | null;
  profile: Profile | null;
  services: Services;
  config: Config;
}

export type BotContext = Context & { kili: KiliFlavor };

/** Name shown in group listings, same rule as the original: @username, else full name. */
export function displayName(from: User): string {
  if (from.username) return from.username;
  return [from.first_name, from.last_name].filter(Boolean).join(" ");
}

/** Telegram first + last name, used in charts (the original bot's graphs show this). */
export function fullName(from: User): string {
  return [from.first_name, from.last_name].filter(Boolean).join(" ");
}

export const isPrivate = (ctx: Context) => ctx.chat?.type === "private";

/** Numbers used in the retention sentence and the warning message. */
export function retentionParams(config: Config) {
  return {
    months: Math.round(config.inactivity.deleteAfterDays / 30.44),
    warn_days: config.inactivity.warnDaysBefore,
  };
}

/** The retention sentence, or nothing when inactive accounts are kept forever. */
export function retentionText(config: Config) {
  return raw(config.inactivity.deleteAfterDays > 0 ? fmt(S.retention, retentionParams(config)) : "");
}

/** Terms of service with the configured retention policy. */
export function termsHtml(config: Config): string {
  return fmt(S.terms, { retention: retentionText(config) });
}

/** Optional maintainer/source sentences appended to about/help texts. */
export function contactExtras(config: Config) {
  return {
    source: raw(config.sourceUrl ? fmt(" Lähdekoodi: {url}.", { url: config.sourceUrl }) : ""),
    maintainer: raw(config.maintainer ? fmt("\n\nYlläpitäjä: {m}", { m: config.maintainer }) : ""),
  };
}
