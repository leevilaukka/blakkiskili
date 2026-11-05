import { describe, expect, test } from "bun:test";
import { GrammyError, type Api } from "grammy";
import { runInactivityJob } from "../src/bot/inactivity.ts";
import type { Config } from "../src/config.ts";
import { DAY_MS } from "../src/lib/units.ts";
import { setup, TEST_SECRET } from "./helpers.ts";

const policy = { deleteAfterDays: 730, warnDaysBefore: 30 };
const config = { inactivity: policy, appSecret: TEST_SECRET } as Config;
const profile = { name: "n", weight: 80, height: 180, gender: "mies" as const };

function fakeApi(fail: (chatId: number) => GrammyError | Error | null = () => null) {
  const sent: { chatId: number; text: string }[] = [];
  const api = {
    sendMessage: async (chatId: number, text: string) => {
      const err = fail(chatId);
      if (err) throw err;
      sent.push({ chatId, text });
      return { message_id: 1 };
    },
  } as unknown as Api;
  return { api, sent };
}

const tgError = (code: number) =>
  new GrammyError("fail", { ok: false, error_code: code, description: "x" }, "sendMessage", {});

const noSleep = async () => {};

describe("inactivity", () => {
  test("stores the Telegram id encrypted, and touch() keeps the account alive", () => {
    const { crypto, services, db, clock } = setup();
    const uid = crypto.userKey(555);
    services.accounts.upsert(uid, { ...profile, telegramId: 555 });
    const row = db.query("SELECT tg_id_enc FROM users").get() as { tg_id_enc: string };
    expect(row.tg_id_enc).not.toContain("555");
    expect(crypto.decrypt(row.tg_id_enc)).toBe("555");

    clock.now += 701 * DAY_MS;
    expect(services.inactivity.dueForWarning(policy)).toEqual([{ userId: uid, telegramId: 555 }]);
    services.accounts.touch(uid, 555);
    expect(services.inactivity.dueForWarning(policy)).toEqual([]);
  });

  test("warns 30 days before, deletes only after both the deadline and the notice period", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.userKey(1);
    services.accounts.upsert(uid, { ...profile, telegramId: 1 });

    clock.now += 699 * DAY_MS;
    expect(services.inactivity.dueForWarning(policy)).toHaveLength(0);
    clock.now += 2 * DAY_MS; // day 701
    expect(services.inactivity.dueForWarning(policy)).toHaveLength(1);
    services.inactivity.markWarned(uid);
    expect(services.inactivity.dueForWarning(policy)).toHaveLength(0); // only once

    clock.now += 29 * DAY_MS; // day 730, warned 29 days ago
    expect(services.inactivity.purge(policy)).toBe(0);
    clock.now += 1 * DAY_MS + 1;
    expect(services.inactivity.purge(policy)).toBe(1);
    expect(services.accounts.get(uid)).toBeNull();
  });

  test("a warning that arrives late still gives the full notice period", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.userKey(1);
    services.accounts.upsert(uid, { ...profile, telegramId: 1 });
    clock.now += 800 * DAY_MS; // e.g. the bot was down for months
    services.inactivity.markWarned(uid);
    expect(services.inactivity.purge(policy)).toBe(0);
    clock.now += 30 * DAY_MS;
    expect(services.inactivity.purge(policy)).toBe(1);
  });

  test("using the bot after the warning cancels the deletion", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.userKey(1);
    services.accounts.upsert(uid, { ...profile, telegramId: 1 });
    clock.now += 701 * DAY_MS;
    services.inactivity.markWarned(uid);
    clock.now += 10 * DAY_MS;
    services.accounts.touch(uid, 1);
    clock.now += 40 * DAY_MS;
    expect(services.inactivity.purge(policy)).toBe(0);
    expect(services.accounts.get(uid)).not.toBeNull();
  });

  test("accounts without a stored Telegram id are deleted once inactive", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.userKey(1);
    services.accounts.upsert(uid, profile);
    clock.now += 731 * DAY_MS;
    expect(services.inactivity.dueForWarning(policy)).toEqual([]);
    expect(services.inactivity.purge(policy)).toBe(1);
  });

  test("deleteAfterDays 0 keeps everything", () => {
    const { crypto, services, clock } = setup();
    services.accounts.upsert(crypto.userKey(1), { ...profile, telegramId: 1 });
    clock.now += 5000 * DAY_MS;
    const off = { deleteAfterDays: 0, warnDaysBefore: 30 };
    expect(services.inactivity.dueForWarning(off)).toEqual([]);
    expect(services.inactivity.purge(off)).toBe(0);
  });
});

describe("inactivity job", () => {
  test("sends warnings, handles blocked users and retries transient failures", async () => {
    const { crypto, services, clock } = setup();
    for (const id of [1, 2, 3]) services.accounts.upsert(crypto.userKey(id), { ...profile, telegramId: id });
    clock.now += 701 * DAY_MS;

    const { api, sent } = fakeApi((chatId) => (chatId === 2 ? tgError(403) : chatId === 3 ? new Error("network") : null));
    expect(await runInactivityJob(api, services, config, noSleep)).toEqual({ warned: 1, undeliverable: 1, failed: 1, deleted: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(1);
    expect(sent[0]!.text).toContain("24 kuukauteen");
    expect(sent[0]!.text).toContain("30 päivän kuluttua");

    // Next run: only the network failure is retried.
    const second = fakeApi();
    expect(await runInactivityJob(second.api, services, config, noSleep)).toMatchObject({ warned: 1, failed: 0 });
    expect(second.sent.map((s) => s.chatId)).toEqual([3]);

    clock.now += 31 * DAY_MS;
    expect((await runInactivityJob(fakeApi().api, services, config, noSleep)).deleted).toBe(3);
  });
});
