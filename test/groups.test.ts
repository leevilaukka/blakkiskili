import { describe, expect, test } from "bun:test";
import { findPreset } from "../src/lib/catalog.ts";
import { DAY_MS, HOUR_MS } from "../src/lib/units.ts";
import { INVITE_TTL_MS, MAX_WEB_GROUP_MEMBERS, MAX_WEB_GROUPS_PER_OWNER, cleanGroupName } from "../src/services/groups.ts";
import { MAX_SCREENS_PER_TARGET, SCREEN_MAX_TTL_MS } from "../src/services/screens.ts";
import { setup, tg } from "./helpers.ts";

function world() {
  const w = setup();
  const user = (id: number, name: string) => w.services.accounts.register(tg(id), { name, fullName: `${name} Full`, weight: 75, height: 178, gender: "mies" }).profile;
  return { ...w, user, alice: user(1, "alice"), bob: user(2, "bob"), carol: user(3, "carol") };
}

describe("group names", () => {
  test("are trimmed, single-spaced and length-limited", () => {
    expect(cleanGroupName("  Kaverit \n 2026 ")).toBe("Kaverit 2026");
    expect(cleanGroupName("")).toBeNull();
    expect(cleanGroupName("   ")).toBeNull();
    expect(cleanGroupName("x".repeat(41))).toBeNull();
    expect(cleanGroupName("x".repeat(40))).toBe("x".repeat(40));
    expect(cleanGroupName("a\u0000b‮evil")).toBe("a b evil"); // control and bidi characters become spaces
    expect(cleanGroupName(42)).toBeNull();
  });
});

describe("web groups", () => {
  test("creating makes the owner the first member; the name is stored encrypted", () => {
    const { services, db, alice } = world();
    const g = services.groups.createWeb(alice.id, "Mökki 2026");
    expect(g).toMatchObject({ name: "Mökki 2026", kind: "web", memberCount: 1 });
    const id = (g as { id: string }).id;
    expect(services.groups.isMemberOf(alice.id, id)).toBe(true);
    expect(services.groups.ownerOf(id)).toBe(alice.id);
    expect(JSON.stringify(db.query("SELECT * FROM groups").all())).not.toContain("Mökki");
  });

  test("an owner can have only so many groups", () => {
    const { services, alice } = world();
    for (let i = 0; i < MAX_WEB_GROUPS_PER_OWNER; i += 1) expect(services.groups.createWeb(alice.id, `g${i}`)).not.toBe("limit");
    expect(services.groups.createWeb(alice.id, "one too many")).toBe("limit");
  });

  test("invites: join once, expire, rotate, and are single-group", () => {
    const { services, clock, alice, bob, carol } = world();
    const g = services.groups.createWeb(alice.id, "Bileet") as { id: string };
    const { code } = services.groups.createInvite(g.id, alice.id);

    expect(services.groups.redeemInvite(code, bob.id)).toEqual({ ok: true, groupId: g.id });
    expect(services.groups.redeemInvite(code, bob.id)).toEqual({ ok: false, reason: "already_member" });
    expect(services.groups.redeemInvite("garbage", carol.id)).toEqual({ ok: false, reason: "invalid" });

    const rotated = services.groups.createInvite(g.id, alice.id).code; // replaces the old code
    expect(services.groups.redeemInvite(code, carol.id)).toEqual({ ok: false, reason: "invalid" });
    clock.now += INVITE_TTL_MS + 1;
    expect(services.groups.redeemInvite(rotated, carol.id)).toEqual({ ok: false, reason: "invalid" });
    expect(services.groups.hasInvite(g.id)).toBeNull();
  });

  test("invite codes are stored hashed", () => {
    const { services, db, alice } = world();
    const g = services.groups.createWeb(alice.id, "x") as { id: string };
    const { code } = services.groups.createInvite(g.id, alice.id);
    expect(JSON.stringify(db.query("SELECT * FROM group_invites").all())).not.toContain(code);
  });

  test("a full group takes no more members", () => {
    const { services, alice, user } = world();
    const g = services.groups.createWeb(alice.id, "Iso") as { id: string };
    const { code } = services.groups.createInvite(g.id, alice.id);
    for (let i = 0; i < MAX_WEB_GROUP_MEMBERS - 1; i += 1) expect(services.groups.redeemInvite(code, user(100 + i, `u${i}`).id).ok).toBe(true);
    expect(services.groups.redeemInvite(code, user(999, "late").id)).toEqual({ ok: false, reason: "full" });
  });

  test("leaving: the owner role moves to the earliest member; the last one out deletes the group", () => {
    const { services, clock, alice, bob, carol } = world();
    const g = services.groups.createWeb(alice.id, "Porukka") as { id: string };
    const { code } = services.groups.createInvite(g.id, alice.id);
    clock.now += 1000;
    services.groups.redeemInvite(code, bob.id);
    clock.now += 1000;
    services.groups.redeemInvite(code, carol.id);

    services.accounts.delete(alice.id); // the creator's account goes away
    expect(services.groups.ownerOf(g.id)).toBe(bob.id); // earliest remaining member
    expect(services.groups.leaveGroup(bob.id, g.id)).toBe(true);
    expect(services.groups.ownerOf(g.id)).toBe(carol.id);
    expect(services.groups.leaveGroup(carol.id, g.id)).toBe(true);
    expect(services.groups.get(g.id)).toBeNull();
    expect(services.groups.leaveGroup(carol.id, g.id)).toBe(false);
  });

  test("rename and delete only touch web groups; deleting tells the members", () => {
    const { services, alice, bob } = world();
    const g = services.groups.createWeb(alice.id, "Vanha") as { id: string };
    services.groups.redeemInvite(services.groups.createInvite(g.id, alice.id).code, bob.id);
    expect(services.groups.rename(g.id, "Uusi")).toBe(true);
    expect(services.groups.rename(g.id, "  ")).toBe(false);
    expect(services.groups.get(g.id)!.name).toBe("Uusi");

    services.groups.join(alice.id, -100, "Telegram-porukka");
    const tgId = services.groups.listFor(alice.id).find((x) => x.kind === "telegram")!.id;
    expect(services.groups.rename(tgId, "Hijack")).toBe(false);
    expect(services.groups.deleteWeb(tgId)).toBe(false);
    expect(services.groups.get(tgId)!.name).toBe("Telegram-porukka");

    const told: (string | undefined)[] = [];
    services.bus.subscribe((c) => told.push(c.accountId));
    expect(services.groups.deleteWeb(g.id)).toBe(true);
    expect(told).toContain(alice.id);
    expect(told).toContain(bob.id);
    expect(services.groups.listFor(bob.id).some((x) => x.id === g.id)).toBe(false);
  });

  test("prune removes expired invites and empty web groups, never Telegram groups", () => {
    const { services, db, clock, alice } = world();
    const g = services.groups.createWeb(alice.id, "Tyhjä") as { id: string };
    services.groups.createInvite(g.id, alice.id);
    services.groups.join(alice.id, -5); // a Telegram group
    services.groups.leave(alice.id, -5);
    db.query("DELETE FROM group_members WHERE group_id = ?").run(g.id); // emptied behind the service's back (e.g. account deletion)
    clock.now += INVITE_TTL_MS + 1;
    expect(services.groups.prune()).toBeGreaterThanOrEqual(2);
    expect(services.groups.get(g.id)).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM groups WHERE kind = 'telegram'").get()).toEqual({ n: 1 });
  });
});

describe("Telegram groups keep working", () => {
  test("the chat title becomes the name; histories include only people who drank", () => {
    const { services, clock, alice, bob } = world();
    services.groups.join(alice.id, -100, "  Perjantai ");
    services.groups.join(bob.id, -100);
    services.groups.join(bob.id, -100, ""); // an empty title doesn't erase the name
    const id = services.groups.listFor(alice.id)[0]!.id;
    expect(services.groups.get(id)).toMatchObject({ name: "Perjantai", kind: "telegram", memberCount: 2 });
    expect(services.groups.ownerOf(id)).toBeNull();

    services.drinks.add(alice.id, findPreset("b50")!.mg, "x", { at: clock.now - HOUR_MS });
    expect(services.groups.memberHistories(-100).map((m) => m.userId)).toEqual([alice.id]);
    expect(services.groups.members(id).map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort()); // everyone, for the website
  });

  test("the chat id is kept encrypted, only for chats the bot already knows", () => {
    const { services, db, alice } = world();
    services.groups.rememberChat(-1009876543210); // nobody has joined: nothing is stored
    expect(db.query("SELECT count(*) AS n FROM groups").get()).toEqual({ n: 0 });

    services.groups.join(alice.id, -1009876543210, "Kerava");
    const id = services.groups.listFor(alice.id)[0]!.id;
    expect(services.groups.telegramChatId(id)).toBeNull(); // joining alone doesn't keep it
    services.groups.rememberChat(-1009876543210);
    expect(services.groups.telegramChatId(id)).toBe(-1009876543210);
    const raw = db.query("SELECT chat_enc FROM groups WHERE id = ?").get(id) as { chat_enc: string };
    expect(raw.chat_enc).not.toContain("9876543210");

    const web = services.groups.createWeb(alice.id, "Verkko");
    if (web === "limit") throw new Error("unexpected");
    expect(services.groups.telegramChatId(web.id)).toBeNull();
  });

  test("hiding on screens is per member and per group", () => {
    const { services, alice } = world();
    services.groups.join(alice.id, -100);
    const id = services.groups.listFor(alice.id)[0]!.id;
    expect(services.groups.listFor(alice.id)[0]!.hideOnScreen).toBe(false);
    expect(services.groups.setHidden(alice.id, id, true)).toBe(true);
    expect(services.groups.members(id)[0]!.hideOnScreen).toBe(true);
    expect(services.groups.setHidden(alice.id, "nope", true)).toBe(false);
  });
});

describe("screen links", () => {
  test("work for a group or a person, hashed, expiring, limited", () => {
    const { services, db, clock, alice } = world();
    const g = services.groups.createWeb(alice.id, "Näyttö") as { id: string };

    const made = services.screens.create({ groupId: g.id }, alice.id) as { token: string; expiresAt: number };
    expect(services.screens.authenticate(made.token)).toMatchObject({ groupId: g.id, accountId: null });
    expect(JSON.stringify(db.query("SELECT * FROM screen_tokens").all())).not.toContain(made.token);

    const mine = services.screens.create({ accountId: alice.id }, alice.id) as { token: string };
    expect(services.screens.authenticate(mine.token)).toMatchObject({ groupId: null, accountId: alice.id });
    expect(services.screens.authenticate("nonsense")).toBeNull();

    clock.now += 25 * HOUR_MS;
    expect(services.screens.authenticate(made.token)).toBeNull(); // 24 h by default

    for (let i = 0; i < MAX_SCREENS_PER_TARGET; i += 1) expect(services.screens.create({ groupId: g.id }, alice.id)).not.toBe("limit");
    expect(services.screens.create({ groupId: g.id }, alice.id)).toBe("limit");
    expect(services.screens.prune()).toBe(2);
  });

  test("the lifetime is clamped between an hour and a week", () => {
    const { services, clock, alice } = world();
    const g = services.groups.createWeb(alice.id, "x") as { id: string };
    const short = services.screens.create({ groupId: g.id }, alice.id, 1000) as { expiresAt: number };
    expect(short.expiresAt - clock.now).toBe(HOUR_MS);
    const long = services.screens.create({ groupId: g.id }, alice.id, 365 * DAY_MS) as { expiresAt: number };
    expect(long.expiresAt - clock.now).toBe(SCREEN_MAX_TTL_MS);
  });

  test("revoking one link ends only that link and announces it", () => {
    const { services, alice } = world();
    const g = services.groups.createWeb(alice.id, "x") as { id: string };
    const a = services.screens.create({ groupId: g.id }, alice.id) as { token: string };
    const b = services.screens.create({ groupId: g.id }, alice.id) as { token: string };
    const [first, second] = services.screens.list({ groupId: g.id });
    expect(first!.ref).toHaveLength(16);
    const hash = services.screens.authenticate(a.token)!.hash;

    const told: (string | undefined)[] = [];
    services.bus.subscribe((c) => told.push(c.screenHash));
    expect(services.screens.revoke({ accountId: alice.id }, first!.ref)).toBe(false); // wrong target
    expect(services.screens.revoke({ groupId: g.id }, "not-a-ref")).toBe(false);
    expect(services.screens.revoke({ groupId: g.id }, first!.ref)).toBe(true);
    expect(told).toEqual([hash]);
    expect(services.screens.authenticate(a.token)).toBeNull();
    expect(services.screens.authenticate(b.token)).not.toBeNull();
    expect(services.screens.list({ groupId: g.id }).map((l) => l.ref)).toEqual([second!.ref]);
  });

  test("deleting the group or the creator removes the links", () => {
    const { services, alice, bob } = world();
    const g = services.groups.createWeb(alice.id, "x") as { id: string };
    services.groups.redeemInvite(services.groups.createInvite(g.id, alice.id).code, bob.id);
    const t = services.screens.create({ groupId: g.id }, bob.id) as { token: string };
    services.accounts.delete(bob.id); // created_by cascades
    expect(services.screens.authenticate(t.token)).toBeNull();
    const t2 = services.screens.create({ groupId: g.id }, alice.id) as { token: string };
    services.groups.deleteWeb(g.id);
    expect(services.screens.authenticate(t2.token)).toBeNull();
  });
});
