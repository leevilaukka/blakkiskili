import { describe, expect, test } from "bun:test";
import { setup } from "./helpers.ts";
import { toCsv } from "../src/lib/csv.ts";
import { legacyHash } from "../src/lib/ids.ts";

const TG_ID = 62461364;
const OTHER_ID = 999;
const old = legacyHash(TG_ID);

// Files shaped exactly like the original bot's /data output.
const userCsv = (userid = old) =>
  toCsv(
    ["userid", "nick", "weight", "gender", "height", "read_terms", "read_announcements", "created"],
    [{ userid, nick: "oldnick", weight: 75, gender: "nainen", height: 168, read_terms: true, read_announcements: 12, created: new Date("2018-01-10T12:00:00Z") }],
  );
const drinksCsv = (userid = old) =>
  toCsv(
    ["id", "userid", "alcohol", "description", "created"],
    [
      { id: 1, userid, alcohol: 12379, description: "🍺 33cl 4.7%", created: new Date("2024-05-01T18:30:00Z") },
      { id: 2, userid, alcohol: 15000, description: "=evil", created: new Date("2024-05-01T19:00:00Z") },
      { id: 3, userid, alcohol: "garbage", description: "x", created: new Date("2024-05-01T19:30:00Z") },
    ],
  );
const legacyGroup = legacyHash(-1001234567890);
const groupsCsv = (userid = old) => toCsv(["userid", "groupid"], [{ userid, groupid: legacyGroup }]);

describe("importer", () => {
  test("imports profile, drinks and groups that belong to the sender", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(TG_ID);

    expect(services.importer.import(userCsv(), TG_ID, uid, "currentname")).toEqual({ ok: true, kind: "user", created: true });
    const p = services.accounts.get(uid)!;
    expect(p).toMatchObject({ name: "currentname", weight: 75, height: 168, gender: "nainen", acceptedTerms: true });
    expect(p.createdAt).toBe(Date.parse("2018-01-10T12:00:00Z"));

    expect(services.importer.import(drinksCsv(), TG_ID, uid, "")).toEqual({ ok: true, kind: "drinks", inserted: 2, duplicates: 0, invalid: 1 });
    const drinks = services.drinks.since(uid, 0);
    expect(drinks.map((d) => d.description)).toEqual(["🍺 33cl 4.7%", "=evil"]);

    expect(services.importer.import(groupsCsv(), TG_ID, uid, "")).toEqual({ ok: true, kind: "groups", groups: 1 });
  });

  test("re-importing doesn't duplicate drinks", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(TG_ID);
    services.importer.import(userCsv(), TG_ID, uid, "n");
    services.importer.import(drinksCsv(), TG_ID, uid, "n");
    expect(services.importer.import(drinksCsv(), TG_ID, uid, "n")).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(services.drinks.since(uid, 0)).toHaveLength(2);
  });

  test("rejects someone else's export", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(OTHER_ID);
    expect(services.importer.import(userCsv(), OTHER_ID, uid, "n")).toEqual({ ok: false, reason: "not_yours" });
    expect(services.accounts.get(uid)).toBeNull();
  });

  test("rejects a file that mixes in someone else's rows", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(TG_ID);
    services.importer.import(userCsv(), TG_ID, uid, "n");
    const mixed = drinksCsv() + `9,${legacyHash(OTHER_ID)},1000,x,2024-05-01T19:00:00.000Z\r\n`;
    expect(services.importer.import(mixed, TG_ID, uid, "n")).toEqual({ ok: false, reason: "not_yours" });
  });

  test("drinks need an account first; unknown files are rejected", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(TG_ID);
    expect(services.importer.import(drinksCsv(), TG_ID, uid, "n")).toEqual({ ok: false, reason: "no_account" });
    expect(services.importer.import("foo,bar\r\n1,2\r\n", TG_ID, uid, "n")).toEqual({ ok: false, reason: "unknown_format" });
    expect(services.importer.peek(drinksCsv())).toBe("drinks");
  });

  test("imported group memberships are adopted when the group uses the bot", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(TG_ID);
    services.importer.import(userCsv(), TG_ID, uid, "n");
    services.importer.import(groupsCsv(), TG_ID, uid, "n");
    expect(services.groups.adoptLegacyMembers(-42)).toBe(0); // some other chat
    expect(services.groups.adoptLegacyMembers(-1001234567890)).toBe(1);
    expect(services.groups.isMember(uid, -1001234567890)).toBe(true);
    expect(services.groups.adoptLegacyMembers(-1001234567890)).toBe(0); // only once
  });

  test("our own /data export can be re-imported", () => {
    const { crypto, services } = setup();
    const uid = crypto.userKey(TG_ID);
    services.accounts.upsert(uid, { name: "n", weight: 70, height: 170, gender: "mies" });
    services.drinks.add(uid, 12379, "🍺 33cl 4.7%");
    services.groups.join(uid, -5);
    const files = services.accounts.exportCsv(uid, TG_ID)!;
    services.accounts.delete(uid);

    for (const f of files) {
      const r = services.importer.import(f.csv, TG_ID, uid, "n");
      expect(r.ok).toBe(true);
    }
    expect(services.drinks.since(uid, 0)).toHaveLength(1);
    expect(services.accounts.get(uid)!.weight).toBe(70);
  });
});
