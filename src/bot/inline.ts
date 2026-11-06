// Inline mode: "@blakkiskilibot karhu" shows live Alko search results as the user types;
// picking one logs the drink (via chosen_inline_result) and the bot confirms in private.
//
// Needs two BotFather settings: /setinline (turns inline mode on) and /setinlinefeedback
// → Enabled (otherwise Telegram never tells the bot which result was picked).
// Inline results only work in the private chat with the bot, so drinks aren't posted to groups.

import type { Bot } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import type { BotContext } from "./context.ts";
import { drankText, logServing, shortPermilles } from "./menu.ts";
import { btn } from "./ui.ts";
import { S } from "../strings.ts";
import { escapeHtml } from "../lib/format.ts";
import {
  customServing,
  emojiFor,
  resolveServing,
  servingDescription,
  servingFacts,
  splitAmount,
  standardDrinksText,
  type CatalogDrink,
  type Serving,
} from "../lib/servings.ts";

const MAX_RESULTS = 50; // Telegram's limit per answer
const MAX_PRODUCTS = 16;

/**
 * The product photo as a small JPEG (160×192, padded), the same URL Alkometriikka uses for share
 * metadata. Telegram's servers fetch and cache it, so Alko never sees the user. A product without
 * a photo answers 4xx and the result just shows no thumbnail.
 */
export const thumbnailUrl = (productId: string) =>
  `https://images.alko.fi/images/cs_srgb,f_auto,t_products/cdn/${encodeURIComponent(productId)}/kuva.jpg`;

/**
 * One result per serving, so even "a glass of this wine" is a single tap. With an amount in
 * the query ("jallu 3 cl"), one result per drink with exactly that amount.
 */
export function inlineResults(drinks: readonly CatalogDrink[], litres?: number): InlineQueryResultArticle[] {
  const results: InlineQueryResultArticle[] = [];
  for (const d of drinks) {
    let servings: Serving[] = d.servings;
    if (litres !== undefined) {
      const r = customServing(d, litres);
      servings = "serving" in r ? [r.serving] : [];
    }
    for (const s of servings) {
      if (results.length >= MAX_RESULTS) return results;
      results.push({
        type: "article",
        id: `${d.id}:${s.key}`,
        title: `${emojiFor(d.product)} ${d.name}`,
        // Second line: "130 kcal · Alkossa 2,19 €"
        description: [`${s.label} · ${d.product.abv} % · ${standardDrinksText(s)}`, servingFacts(s)].filter(Boolean).join("\n"),
        input_message_content: { message_text: escapeHtml(servingDescription(d, s)), parse_mode: "HTML" },
        thumbnail_url: thumbnailUrl(d.product.id),
        thumbnail_width: 160,
        thumbnail_height: 192,
      });
    }
  }
  return results;
}

export interface InlineOptions {
  /** How long to wait for chosen_inline_result before assuming feedback is off. */
  feedbackGraceMs?: number;
}

export function registerInline(bot: Bot<BotContext>, opts: InlineOptions = {}) {
  const graceMs = opts.feedbackGraceMs ?? 5000;
  const lastChosenAt = new Map<number, number>(); // Telegram id → ms, in memory only
  const warned = new Set<number>();

  bot.on("inline_query", async (ctx) => {
    const { services, profile } = ctx.kili;
    const q = ctx.inlineQuery.query.trim();
    const answer = (results: InlineQueryResultArticle[], button?: { text: string; start_parameter: string }) =>
      ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true, ...(button ? { button } : {}) });

    if (!profile) return answer([], { text: S.search.inline_register, start_parameter: "tunnus" });
    // "sender" = the private chat with this bot. Elsewhere, results would post into the chat.
    if (ctx.inlineQuery.chat_type !== "sender") return answer([], { text: S.search.inline_private, start_parameter: "juo" });
    if (!services.products.ready) return answer([], { text: S.search.inline_unavailable, start_parameter: "juo" });

    const recent = services.drinks.recentProductIds(profile.id, 10);
    const { query, litres } = splitAmount(q);
    const found = query ? services.products.search(query, MAX_PRODUCTS, recent) : services.products.drinksFor(recent, MAX_PRODUCTS);
    await answer(inlineResults(found, litres));
  });

  bot.on("chosen_inline_result", async (ctx) => {
    const { services, profile } = ctx.kili;
    const from = ctx.chosenInlineResult.from;
    lastChosenAt.set(from.id, Date.now());
    if (!profile) return;
    const [drinkId, key] = ctx.chosenInlineResult.result_id.split(":");
    const drink = services.products.get(drinkId ?? "");
    const serving = drink && resolveServing(drink, key ?? "");
    if (!drink || !serving) {
      await ctx.api.sendMessage(from.id, S.search.gone);
      return;
    }
    const description = logServing(ctx, profile, drink, serving);
    const text = drankText(ctx, profile, description) + "\n\n" + shortPermilles(ctx, profile);
    await ctx.api.sendMessage(from.id, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: S.search.more, switch_inline_query_current_chat: "" }, btn(S.search.to_menu, "j")]],
      },
    });
  });

  // The picked result also arrives as an ordinary message "via" this bot. Don't treat it as
  // typed input; but if no chosen_inline_result follows, inline feedback is off in BotFather
  // and nothing was logged: tell the user once instead of failing silently.
  bot.chatType("private").on("message", async (ctx, next) => {
    if (ctx.message.via_bot?.id !== ctx.me.id) return next();
    const userId = ctx.from.id;
    const sentAt = Date.now();
    setTimeout(() => {
      if ((lastChosenAt.get(userId) ?? 0) >= sentAt - graceMs || warned.has(userId)) return;
      warned.add(userId);
      console.warn("Inline result was sent but no chosen_inline_result arrived: enable /setinlinefeedback in BotFather");
      void ctx.api.sendMessage(userId, S.search.feedback_off).catch(() => {});
    }, graceMs);
  });
}
