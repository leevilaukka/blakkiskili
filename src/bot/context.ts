import type { Context } from "grammy";
import type { User } from "grammy/types";
import type { Config } from "../config.ts";
import type { Profile } from "../services/accounts.ts";
import type { ImportResult } from "../services/importer.ts";
import type { Services } from "../services/index.ts";
import { fmt, raw } from "../lib/format.ts";
import { S } from "../strings.ts";

export interface KiliFlavor {
  /**
   * Key of the sender's Telegram login (services/identities.ts); null for updates without a
   * human sender. Typed-input state (pending) is keyed by this, the account by profile.id.
   */
  identityId: string | null;
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

/** Whether the sender is in ADMIN_IDS. */
export const isAdmin = (ctx: BotContext) => !!ctx.from && ctx.kili.config.adminIds.includes(ctx.from.id);

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

/** The website paragraph of the privacy text, or nothing when the website is off. */
export function webPrivacyText(config: Config) {
  return raw(config.web.enabled ? S.privacy_web : "");
}

/** The privacy text (bot help and the website's /privacy page), with the configured retention and contact details. */
export function privacyHtml(config: Config): string {
  return fmt(S.help.privacy.text, { ...contactExtras(config), retention: retentionText(config), web: webPrivacyText(config) });
}

/**
 * The texts of the website's help, terms and privacy pages (Telegram HTML, plus <h2> lines for
 * the help page's sections): the bot's own texts, so the two can't drift apart.
 */
export function docsHtml(config: Config): Record<"help" | "terms" | "privacy", string> {
  const { help } = S;
  const extras = contactExtras(config);
  const faq = [
    ["Juominen", help.faq.juominen.text],
    ["Ryhmät", help.faq.ryhmat.text + (config.web.enabled ? help.faq.ryhmat.web : "")],
    ["Koodi", fmt(help.faq.koodi.text, extras)],
  ] as const;
  return {
    help: [
      help.web_note,
      `<h2>Yleistä</h2>\n${help.general.text}`,
      ...faq.map(([title, text]) => `<h2>FAQ: ${title}</h2>\n${text}`),
      `<h2>Tietoa</h2>\n${fmt(S.about, extras).replace(/\n+Käyttöehdot: \/terms\s*$/, "")}`,
    ].join("\n\n"),
    terms: termsHtml(config).replace(/^<b>Käyttöehdot<\/b>\n+/, ""),
    privacy: privacyHtml(config),
  };
}

/** The reply to one imported CSV file. */
export function importResultText(r: ImportResult): string {
  if (!r.ok) return S.import[r.reason];
  switch (r.kind) {
    case "user":
      return r.created ? S.import.user_created : S.import.user_updated;
    case "drinks":
      return fmt(S.import.drinks, { inserted: r.inserted, duplicates: r.duplicates, invalid: r.invalid });
    case "groups":
      return fmt(S.import.groups, { groups: r.groups });
  }
}

/** Terms of service with the configured retention policy. */
export function termsHtml(config: Config): string {
  return fmt(S.terms, { retention: retentionText(config) });
}

/**
 * Optional maintainer/source sentences appended to /about and help texts: {source} and {maintainer}.
 */
export function contactExtras(config: Config) {
  const name = config.maintainer;
  const handle = config.maintainerTelegram ? `@${config.maintainerTelegram}` : undefined;
  const who = name && handle ? fmt("{name} ({handle})", { name, handle }) : fmt("{x}", { x: name ?? handle ?? "" });
  return {
    source: raw(config.sourceUrl ? fmt(" Lähdekoodi: {url}.", { url: config.sourceUrl }) : ""),
    maintainer: raw(
      !who
        ? ""
        : handle
          ? `\n\nYlläpitäjä: ${who}. Kysymykset, ideat ja bugiraportit voi lähettää suoraan Telegramissa.`
          : `\n\nYlläpitäjä: ${who}.`,
    ),
  };
}
