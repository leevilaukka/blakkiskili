import { describe, expect, test } from "bun:test";
import { setup } from "./helpers.ts";
import { legacyHash } from "../src/lib/ids.ts";
import { HOUR_MS } from "../src/lib/units.ts";

const TG_ID = 123456789;
const profile = { name: "testuser", weight: 80, height: 180, gender: "mies" as const };

describe("crypto", () => {
  test("ids are keyed hashes, names are encrypted and decrypt back", () => {
    const { crypto, db, services } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    expect(uid).not.toBe(legacyHash(TG_ID));
    expect(crypto.identityKey("telegram", TG_ID)).toBe(uid);
    expect(crypto.groupKey(TG_ID)).not.toBe(uid);
    services.accounts.upsert(uid, { ...profile, name: "Mörkö <b>" });
    const row = db.query("SELECT name_enc FROM users").get() as { name_enc: string };
    expect(row.name_enc).not.toContain("Mörkö");
    expect(services.accounts.get(uid)!.name).toBe("Mörkö <b>");
  });

  test("full name is stored encrypted, null until set, and kept when only the nick is updated", () => {
    const { crypto, db, services } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    services.accounts.upsert(uid, profile);
    expect(services.accounts.get(uid)!.fullName).toBeNull();
    services.accounts.updateName(uid, "nick", "Matti Meikäläinen");
    const row = db.query("SELECT full_name_enc FROM users").get() as { full_name_enc: string };
    expect(row.full_name_enc).not.toContain("Matti");
    services.accounts.updateName(uid, "nick2");
    expect(services.accounts.get(uid)!.fullName).toBe("Matti Meikäläinen");
  });
});

describe("drinks", () => {
  test("add, last, undo", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    services.accounts.upsert(uid, profile);
    services.drinks.add(uid, 12379, "beer");
    clock.now += 60_000;
    services.drinks.add(uid, 15000, "wine");
    expect(services.drinks.last(uid)!.description).toBe("wine");
    expect(services.drinks.undoLast(uid)!.description).toBe("wine");
    expect(services.drinks.last(uid)!.description).toBe("beer");
  });

  test("identical drinks in the same millisecond are both kept", () => {
    const { crypto, services } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    services.accounts.upsert(uid, profile);
    services.drinks.add(uid, 1000, "shot");
    services.drinks.add(uid, 1000, "shot");
    expect(services.drinks.since(uid, 0)).toHaveLength(2);
  });

  test("late logging spreads drinks from `hours` ago to now", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    services.accounts.upsert(uid, profile);
    services.drinks.addLate(uid, [{ description: "a", mg: 1 }, { description: "b", mg: 2 }, { description: "c", mg: 3 }], 2);
    const times = services.drinks.since(uid, 0).map((d) => (clock.now - d.createdAt) / HOUR_MS);
    expect(times).toEqual([2, 1, 0]);
  });

  test("recentUnique skips repeats and late-logged drinks", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    services.accounts.upsert(uid, profile);
    for (const d of ["beer", "wine", "beer", "Jälkikellotus 33cl 4.7%"]) {
      services.drinks.add(uid, 1000, d);
      clock.now += 1000;
    }
    expect(services.drinks.recentUnique(uid, 2, "Jälkikellotus").map((d) => d.description)).toEqual(["beer", "wine"]);
  });

  test("ebac reacts to drinks", () => {
    const { crypto, services, clock } = setup();
    const uid = crypto.identityKey("telegram", TG_ID);
    services.accounts.upsert(uid, profile);
    services.drinks.add(uid, 12379, "beer");
    clock.now += HOUR_MS;
    expect(services.drinks.ebac(uid).permilles).toBeGreaterThan(0.05);
  });
});

describe("groups", () => {
  test("join, list, leave", () => {
    const { crypto, services, clock } = setup();
    const a = crypto.identityKey("telegram", 1);
    const b = crypto.identityKey("telegram", 2);
    services.accounts.upsert(a, { ...profile, name: "alice" });
    services.accounts.upsert(b, { ...profile, name: "bob" });
    services.groups.join(a, -100);
    services.groups.join(b, -100);
    services.drinks.add(a, 30000, "x");
    clock.now += HOUR_MS;
    const list = services.groups.memberStatuses(-100);
    expect(list.map((s) => s.name)).toEqual(["alice"]); // bob hasn't drunk
    expect(list[0]!.permilles).toBeGreaterThan(0);
    expect(list[0]!.std12h).toBeCloseTo(2.5, 5);
    services.groups.leave(a, -100);
    expect(services.groups.memberStatuses(-100)).toEqual([]);
    expect(services.groups.memberStatuses(-200)).toEqual([]);
  });

  test("deleting an account removes everything", () => {
    const { crypto, services, db } = setup();
    const a = crypto.identityKey("telegram", 1);
    services.accounts.upsert(a, profile);
    services.groups.join(a, -100);
    services.drinks.add(a, 1000, "x");
    services.pending.set(a, { kind: "customDrink" });
    services.accounts.delete(a);
    for (const table of ["users", "drinks", "group_members", "pending"]) {
      expect((db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});

describe("stats", () => {
  test("group top list and totals", () => {
    const { crypto, services } = setup();
    const a = crypto.identityKey("telegram", 1);
    const b = crypto.identityKey("telegram", 2);
    services.accounts.upsert(a, { ...profile, name: "alice" });
    services.accounts.upsert(b, { ...profile, name: "bob" });
    services.groups.join(a, -100);
    services.groups.join(b, -100);
    services.drinks.add(a, 12000, "x");
    services.drinks.add(b, 12000, "x");
    services.drinks.add(b, 12000, "y");
    const g = services.stats.group(-100, "count", 7);
    expect(g.top).toEqual([{ name: "bob", value: 2 }, { name: "alice", value: 1 }]);
    expect(g.grams).toBe(36);
    expect(g.dayCount).toBe(7);
    expect(services.stats.global().drinks).toBe(3);
  });
});

describe("pending", () => {
  test("expires after a day", () => {
    const { services, clock } = setup();
    services.pending.set("u", { kind: "editWeight" });
    expect(services.pending.get("u")).toEqual({ kind: "editWeight" });
    clock.now += 25 * HOUR_MS;
    expect(services.pending.get("u")).toBeNull();
  });
});
