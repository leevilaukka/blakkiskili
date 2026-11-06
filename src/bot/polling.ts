// Long polling that handles updates concurrently.
//
// grammY's `bot.start()` finishes one update before it takes the next, so a slow handler (the
// /data upload to Telegram, a barcode photo download, a backend call) froze the bot for every
// user until it was done. The runner takes updates in parallel instead. Updates from the same
// user still run one after another (`sequentialize` in createBot), so a flow's typed steps
// can't overtake each other.

import { run, type RunnerHandle } from "@grammyjs/runner";
import type { Bot } from "grammy";
import type { BotContext } from "./context.ts";

export function startPolling(bot: Bot<BotContext>, allowedUpdates: readonly string[]): RunnerHandle {
  return run(bot, {
    runner: { fetch: { allowed_updates: [...allowedUpdates] as never } },
  });
}
