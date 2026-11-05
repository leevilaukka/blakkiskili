import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHmac, hkdfSync } from "node:crypto";
import { migrate } from "../src/db/index.ts";
import { createCrypto } from "../src/lib/ids.ts";
import { createServices } from "../src/services/index.ts";
import { LINK_CODE_TTL_MS, formatLinkCode } from "../src/services/identities.ts";
import { runInactivityJob } from "../src/bot/inactivity.ts";
import type { Api } from "grammy";
import type { Config } from "../src/config.ts";
import { DAY_MS } from "../src/lib/units.ts";
import { setup, TEST_SECRET, tg } from "./helpers.ts";

const profile = { name: "n", weight: 80, height: 180, gender: "mies" as const };
// Discord ids are snowflakes beyond Number.MAX_SAFE_INTEGER, so they travel as strings.
const discord = (id: string) => ({ platform: "discord", platformUserId: id }) as const;
const SNOWFLAKE = "1234567890123456789";

describe("identities", () => {
  test("the Telegram key is the one accounts were stored under before identities existed", () => {
    const { crypto } = setup();
    const idKey = Buffer.from(hkdfSync("sha256", TEST_SECRET, "blakkiskili", "id-hmac", 32));
    expect(crypto.identityKey("telegram", 42)).toBe(createHmac("sha256", idKey).update("user:42").digest("hex"));
    expect(crypto.identityKey("discord", 42)).not.toBe(crypto.identityKey("telegram", 42));
    expect(crypto.identityKey("discord", SNOWFLAKE)).not.toBe(crypto.identityKey("discord", "1234567890123456788"));
  });

  test("register creates an account with a random id and links the login; again it updates", () => {
    const { crypto, services } = setup();
    const first = services.accounts.register(tg(1), profile);
    expect(first.created).toBe(true);
    expect(first.profile.id).not.toBe(crypto.identityKey("telegram", 1));
    expect(services.accounts.byIdentity(crypto.identityKey("telegram", 1))!.id).toBe(first.profile.id);

    const again = services.accounts.register(tg(1), { ...profile, weight: 90 });
    expect(again).toMatchObject({ created: false, profile: { id: first.profile.id, weight: 90 } });
    expect(services.identities.list(first.profile.id).map((i) => i.platform)).toEqual(["telegram"]);
  });

  test("a link code adds another platform to the account, once", () => {
    const { crypto, services } = setup();
    const acc = services.accounts.register(tg(1), profile).profile.id;
    const { code } = services.identities.createLinkCode(acc);
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);

    // Typed sloppily: lower case, with the dash and spaces
    const typed = ` ${formatLinkCode(code).toLowerCase()} `;
    expect(services.identities.redeemLinkCode(typed, discord(SNOWFLAKE))).toEqual({ ok: true, accountId: acc });
    expect(services.accounts.byIdentity(crypto.identityKey("discord", SNOWFLAKE))!.id).toBe(acc);
    expect(services.identities.contacts(acc)).toEqual([
      { platform: "telegram", address: "1" },
      { platform: "discord", address: SNOWFLAKE },
    ]);
    // Single use
    expect(services.identities.redeemLinkCode(code, discord("99"))).toEqual({ ok: false, reason: "invalid" });
  });

  test("codes expire, and a new code replaces the previous one", () => {
    const { services, clock } = setup();
    const acc = services.accounts.register(tg(1), profile).profile.id;
    const old = services.identities.createLinkCode(acc).code;
    const current = services.identities.createLinkCode(acc).code;
    expect(services.identities.redeemLinkCode(old, discord("5"))).toEqual({ ok: false, reason: "invalid" });

    clock.now += LINK_CODE_TTL_MS;
    expect(services.identities.redeemLinkCode(current, discord("5"))).toEqual({ ok: false, reason: "invalid" });
    expect(services.identities.list(acc)).toHaveLength(1);
  });

  test("accounts are never merged, and one login per platform", () => {
    const { services } = setup();
    const a = services.accounts.register(tg(1), profile).profile.id;
    services.accounts.register(tg(2), profile);
    services.accounts.register(discord("7"), profile);

    // The redeemer is already on this account
    expect(services.identities.redeemLinkCode(services.identities.createLinkCode(a).code, tg(1))).toEqual({
      ok: false,
      reason: "already_linked",
    });
    // The redeemer has an account of their own
    expect(services.identities.redeemLinkCode(services.identities.createLinkCode(a).code, discord("7"))).toEqual({
      ok: false,
      reason: "has_account",
    });
    // A second Telegram login for the same account
    expect(services.identities.redeemLinkCode(services.identities.createLinkCode(a).code, tg(3))).toEqual({
      ok: false,
      reason: "platform_taken",
    });
    expect(services.identities.list(a)).toHaveLength(1);
  });

  test("unlink keeps the last login, and forgets the unlinked login's typed input", () => {
    const { crypto, services } = setup();
    const acc = services.accounts.register(tg(1), profile).profile.id;
    expect(services.identities.unlink(acc, "telegram")).toBe("last");
    expect(services.identities.unlink(acc, "discord")).toBe("not_linked");

    services.identities.redeemLinkCode(services.identities.createLinkCode(acc).code, discord("7"));
    const discordId = crypto.identityKey("discord", "7");
    services.pending.set(discordId, { kind: "customDrink" });
    expect(services.identities.unlink(acc, "discord")).toBe("ok");
    expect(services.accounts.byIdentity(discordId)).toBeNull();
    expect(services.pending.get(discordId)).toBeNull();
    // The data stays with the account
    expect(services.accounts.byIdentity(crypto.identityKey("telegram", 1))!.id).toBe(acc);
  });

  test("deleting the account removes every login, its codes and typed input on every platform", () => {
    const { crypto, db, services } = setup();
    const acc = services.accounts.register(tg(1), profile).profile.id;
    services.identities.redeemLinkCode(services.identities.createLinkCode(acc).code, discord("7"));
    services.identities.createLinkCode(acc);
    services.pending.set(crypto.identityKey("telegram", 1), { kind: "customDrink" });
    services.pending.set(crypto.identityKey("discord", "7"), { kind: "customDrink" });

    services.accounts.delete(acc);
    for (const table of ["users", "identities", "link_codes", "pending"]) {
      expect((db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    // The freed logins can register again
    expect(services.accounts.register(discord("7"), profile).created).toBe(true);
  });

  test("an account reachable only from a platform without a bot is deleted after the notice period", async () => {
    const { services, clock } = setup();
    const acc = services.accounts.register(discord("7"), profile).profile.id;
    clock.now += 701 * DAY_MS;
    const sent: unknown[] = [];
    const api = { sendMessage: async (...args: unknown[]) => sent.push(args) } as unknown as Api;
    const config = { inactivity: { deleteAfterDays: 730, warnDaysBefore: 30 } } as Config;

    expect(await runInactivityJob(api, services, config, async () => {})).toMatchObject({ warned: 0, undeliverable: 1 });
    expect(sent).toEqual([]);
    clock.now += 30 * DAY_MS;
    expect((await runInactivityJob(api, services, config, async () => {})).deleted).toBe(1);
    expect(services.accounts.get(acc)).toBeNull();
  });
});

describe("migration 6: platform identities", () => {
  test("existing accounts keep their id and data, and are found through their Telegram login", () => {
    const db = new Database(":memory:", { strict: true });
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, 5);
    const crypto = createCrypto(TEST_SECRET);
    const legacyId = crypto.identityKey("telegram", 555);
    db.query(
      `INSERT INTO users (id, name_enc, weight, height, gender, accepted_terms_at, created_at, tg_id_enc, last_active_at)
       VALUES (?, ?, 80, 180, 'mies', 1, 1000, ?, 1)`,
    ).run(legacyId, crypto.encrypt("vanha"), crypto.encrypt("555"));
    db.query(
      `INSERT INTO users (id, name_enc, weight, height, gender, accepted_terms_at, created_at, last_active_at)
       VALUES ('no-contact', ?, 80, 180, 'mies', 1, 1000, 1)`,
    ).run(crypto.encrypt("x"));
    db.query("INSERT INTO drinks (user_id, alcohol_mg, description, created_at) VALUES (?, 12000, 'olut', 5)").run(legacyId);
    db.query("INSERT INTO pending (user_id, state, updated_at) VALUES (?, '{\"kind\":\"customDrink\"}', 1)").run(legacyId);

    migrate(db);
    const services = createServices({ db, crypto, now: () => 2 });
    const p = services.accounts.byIdentity(crypto.identityKey("telegram", 555))!;
    expect(p).toMatchObject({ id: legacyId, name: "vanha", createdAt: 1000 });
    expect(services.drinks.since(p.id, 0)).toHaveLength(1);
    expect(services.identities.contacts(p.id)).toEqual([{ platform: "telegram", address: "555" }]);
    expect(services.identities.contacts("no-contact")).toEqual([]);
    // Typed input was keyed by the Telegram HMAC, which is the identity key: still there
    expect(services.pending.get(crypto.identityKey("telegram", 555))).toEqual({ kind: "customDrink" });
    // The contact moved: the old column is gone
    const cols = db.query("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("tg_id_enc");
  });
});
