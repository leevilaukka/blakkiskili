// A slow handler must not stop the bot from answering other users. This drives the real bot
// through a polling loop (fake Telegram API) with /data's upload held back, like a slow upload.

import { afterEach, describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { ALLOWED_UPDATES, createBot } from "../src/bot/index.ts";
import { startPolling } from "../src/bot/polling.ts";
import { RateLimiter } from "../src/bot/ratelimit.ts";
import type { Config } from "../src/config.ts";
import { setup, TEST_SECRET } from "./helpers.ts";

const config: Config = {
  botToken: "123:TEST",
  appSecret: TEST_SECRET,
  dbPath: ":memory:",
  adminIds: [],
  mode: "polling",
  port: 0,
  inactivity: { deleteAfterDays: 730, warnDaysBefore: 30 },
  backup: { everyMinutes: 60 },
};

const command = (id: number, from: number, text: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id, date: 0, text,
      from: { id: from, is_bot: false, first_name: `u${from}` },
      chat: { id: from, type: "private", first_name: `u${from}` },
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
    },
  }) as Update;

function pollingBot(updates: Update[]) {
  const env = setup();
  const bot = createBot(config, env.services, { limiter: new RateLimiter(10_000, 60_000) });
  bot.botInfo = {
    id: 42, is_bot: true, first_name: "Kili", username: "kili_test_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  } as typeof bot.botInfo;

  const sent: { method: string; chat: number }[] = [];
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => (releaseUpload = resolve));
  let delivered = false;

  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, any>;
    if (method === "getUpdates") {
      if (!delivered) {
        delivered = true;
        return { ok: true, result: updates } as any;
      }
      await Bun.sleep(20); // like long polling with nothing new
      return { ok: true, result: [] } as any;
    }
    if (method === "sendDocument") await uploadGate; // a slow upload to Telegram
    if (method.startsWith("send")) sent.push({ method, chat: p.chat_id });
    const result = method.startsWith("send") ? { message_id: 1, date: 0, chat: { id: p.chat_id, type: "private" }, text: "" } : true;
    return { ok: true, result } as any;
  });
  return { env, bot, sent, releaseUpload };
}

const until = async (condition: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await Bun.sleep(5);
  return condition();
};

describe("concurrent updates", () => {
  let stop: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  test("another user is answered while /data is still uploading", async () => {
    const { env, bot, sent, releaseUpload } = pollingBot([command(1, 111, "/data"), command(2, 222, "/help")]);
    env.services.accounts.upsert(env.services.deps.crypto.userKey(111), {
      name: "u111", fullName: "u111", weight: 80, height: 180, gender: "mies",
    } as any);

    const runner = startPolling(bot, ALLOWED_UPDATES);
    stop = async () => {
      releaseUpload();
      await runner.stop();
    };

    // The other user's help text arrives although the first user's document is still stuck
    expect(await until(() => sent.some((m) => m.chat === 222))).toBe(true);
    expect(sent.some((m) => m.method === "sendDocument")).toBe(false);

    releaseUpload();
    expect(await until(() => sent.some((m) => m.method === "sendDocument" && m.chat === 111))).toBe(true);
  });

  test("one user's updates are still handled in order", async () => {
    const { env, bot, sent, releaseUpload } = pollingBot([command(1, 333, "/data"), command(2, 333, "/help")]);
    env.services.accounts.upsert(env.services.deps.crypto.userKey(333), {
      name: "u333", fullName: "u333", weight: 80, height: 180, gender: "mies",
    } as any);
    const runner = startPolling(bot, ALLOWED_UPDATES);
    stop = async () => {
      releaseUpload();
      await runner.stop();
    };

    // /data announced the export and is stuck uploading; /help must wait for it
    expect(await until(() => sent.length >= 1)).toBe(true);
    await Bun.sleep(100);
    expect(sent.map((m) => m.method)).toEqual(["sendMessage"]);

    releaseUpload();
    expect(await until(() => sent[sent.length - 1]?.method === "sendMessage" && sent.length > 2)).toBe(true);
    const methods = sent.map((m) => m.method);
    expect(methods.indexOf("sendDocument")).toBeGreaterThan(0);
    expect(methods[methods.length - 1]).toBe("sendMessage"); // /help, after the documents
  });
});
