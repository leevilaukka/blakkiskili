// Per-user flood protection: stops a script or a stuck client from hammering the bot and
// stuffing the database. Kept in memory only (keyed by Telegram id, never persisted).

import type { MiddlewareFn } from "grammy";
import type { BotContext } from "./context.ts";

export type Verdict = "ok" | "warn" | "drop";

export class RateLimiter {
  private readonly windows = new Map<number, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** "warn" is returned once, on the first update over the limit in a window. */
  hit(key: number): Verdict {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.sweep(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.limit) return "ok";
    return w.count === this.limit + 1 ? "warn" : "drop";
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

const NOTICE = "Hidasta vähän! 🐐 Liikaa viestejä lyhyessä ajassa, yritä hetken päästä uudelleen.";

export function rateLimit(limiter: RateLimiter): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const id = ctx.from?.id;
    // Inline queries fire on every keystroke; they're read-only and cheap, so don't count them.
    if (id === undefined || ctx.inlineQuery) return next();
    const verdict = limiter.hit(id);
    if (verdict === "ok") return next();
    if (verdict === "warn") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: NOTICE }).catch(() => {});
      else if (ctx.chat?.type === "private") await ctx.reply(NOTICE).catch(() => {});
    } else if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => {});
    }
  };
}
