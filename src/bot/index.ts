import { sequentialize } from "@grammyjs/runner";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Config } from "../config.ts";
import type { Services } from "../services/index.ts";
import { displayName, fullName, type BotContext } from "./context.ts";
import { CB_CHART, CB_CHART_DEMO, commandMenus, handleChartPage, handleDemoChartPage, registerCommands } from "./commands.ts";
import { handleMenuCallback, searchResultsView } from "./menu.ts";
import { handleFlowText, handleImportDocument } from "./flows.ts";
import { CB_MENU, sendHtml, sendView } from "./ui.ts";
import { RateLimiter, rateLimit } from "./ratelimit.ts";
import { registerInline, type InlineOptions } from "./inline.ts";
import { barcodeFromText, defaultBarcodeIO, handleBarcodePhoto, type BarcodeIO } from "./barcode.ts";
import { S } from "../strings.ts";
import { splitAmount } from "../lib/servings.ts";
import { fmt, longDate, raw } from "../lib/format.ts";

/**
 * Update types the bot asks Telegram for. Telegram only delivers these, so every type that
 * has a handler must be listed (tests deliver updates through this filter too).
 */
export const ALLOWED_UPDATES = ["message", "callback_query", "inline_query", "chosen_inline_result"] as const;

export interface BotOptions extends InlineOptions {
  /** Default: 30 updates per minute per user, far above normal use. */
  limiter?: RateLimiter;
  /** Downloading and decoding barcode photos; replaced in tests. */
  barcodeIO?: BarcodeIO;
}

export function createBot(config: Config, services: Services, opts: BotOptions = {}): Bot<BotContext> {
  const limiter = opts.limiter ?? new RateLimiter(30, 60_000);
  const bot = new Bot<BotContext>(config.botToken);

  // Updates are handled concurrently (see polling.ts), but one user's updates in order: a typed
  // answer must not be processed before the step that asked for it has finished.
  bot.use(sequentialize((ctx) => ctx.from?.id.toString()));

  // Before touching the database, so floods are dropped early.
  bot.use(rateLimit(limiter));

  // Resolve the sender's account once per update, and keep their display name fresh.
  bot.use(async (ctx, next) => {
    const from = ctx.from && !ctx.from.is_bot ? ctx.from : undefined;
    const ref = from ? ({ platform: "telegram", platformUserId: from.id } as const) : null;
    const identityId = ref ? services.identities.key(ref) : null;
    let profile = identityId ? services.accounts.byIdentity(identityId) : null;
    if (ref && from && profile) {
      services.accounts.touch(profile.id);
      services.identities.ensureContact(ref);
      const name = displayName(from);
      const full = fullName(from);
      if (name && (name !== profile.name || full !== profile.fullName)) {
        services.accounts.updateName(profile.id, name, full);
        profile = { ...profile, name, fullName: full };
      }
    }
    ctx.kili = { identityId, profile, services, config };
    await next();
  });

  // Unseen announcements, once, in the user's private chat (never spammed into groups).
  bot.use(async (ctx, next) => {
    const { profile } = ctx.kili;
    if (profile && ctx.chat?.type === "private") {
      const unseen = services.announcements.unseen(profile);
      if (unseen.length > 0) {
        services.announcements.markSeen(profile.id);
        const text = unseen
          .map((a) => fmt(S.announcement, { date: longDate(a.publishedAt), text: raw(a.text) }))
          .join("\n\n");
        await sendHtml(ctx, text).catch((e) => console.error("Could not send announcements:", e));
      }
    }
    await next();
  });

  // Before commands and the text handler: messages sent "via" the bot are not typed input.
  registerInline(bot, opts);
  registerCommands(bot);

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    if (data.startsWith(CB_MENU)) await handleMenuCallback(ctx, data.slice(CB_MENU.length));
    else if (data.startsWith(CB_CHART)) await handleChartPage(ctx, data.slice(CB_CHART.length));
    else if (data.startsWith(CB_CHART_DEMO)) await handleDemoChartPage(ctx, data.slice(CB_CHART_DEMO.length));
  });

  const priv = bot.chatType("private");
  const barcodeIO = opts.barcodeIO ?? defaultBarcodeIO();
  priv.on("message:document", (ctx) => handleImportDocument(ctx));
  priv.on("message:photo", (ctx) => handleBarcodePhoto(ctx, barcodeIO));
  priv.on("message:text", async (ctx) => {
    if (await handleFlowText(ctx, ctx.message.text)) return;
    if (await barcodeFromText(ctx, ctx.message.text)) return;
    if (await searchFromText(ctx, ctx.message.text)) return;
    await sendHtml(ctx, S.unknown_text);
  });

  bot.catch(async (err) => {
    const e = err.error;
    if (e instanceof GrammyError) console.error("Telegram API error:", e.description);
    else if (e instanceof HttpError) console.error("Could not reach Telegram:", e);
    else console.error("Error while handling update", err.ctx.update.update_id, e);
    await err.ctx.reply(S.error).catch(() => {});
  });

  return bot;
}

export async function publishCommandMenus(bot: Bot<BotContext>, config: Config) {
  const menus = commandMenus(config);
  await bot.api.setMyCommands(menus.private, { scope: { type: "all_private_chats" } });
  await bot.api.setMyCommands(menus.group, { scope: { type: "all_group_chats" } });
}

/**
 * Text typed in the private chat outside any flow is treated as a product search, e.g.
 * "karhu", or "@blakkiskilibot karhu" sent as a message instead of picking an inline result.
 * Returns false when nothing matched, so the caller can say it didn't understand.
 */
async function searchFromText(ctx: BotContext, text: string): Promise<boolean> {
  const { profile, services } = ctx.kili;
  if (!profile || !services.products.ready) return false;
  const mention = `@${ctx.me.username}`.toLowerCase();
  let query = text.trim();
  if (query.toLowerCase().startsWith(mention)) query = query.slice(mention.length).trim();
  if (!query || query.startsWith("/") || query.length > 100) return false;
  if (services.products.search(splitAmount(query).query, 1).length === 0) return false;
  // Keep searching on: the next message refines the query.
  services.pending.set(ctx.kili.identityId!, { kind: "productSearch" });
  await sendView(ctx, searchResultsView(ctx, profile, query));
  return true;
}
