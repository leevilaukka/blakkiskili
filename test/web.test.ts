import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { docsHtml } from "../src/bot/context.ts";
import { toCsv } from "../src/lib/csv.ts";
import { legacyHash } from "../src/lib/ids.ts";
import { findPreset } from "../src/lib/catalog.ts";
import { contentSecurityPolicy, inlineScriptHashes, StaticSite } from "../src/web/static.ts";
import { LOGIN_MAX_AGE_S, verifyTelegramLogin } from "../src/web/telegram.ts";
import { HOUR_MS, MINUTE_MS } from "../src/lib/units.ts";
import { LOGIN_LINK_TTL_MS, SESSION_TTL_MS } from "../src/services/websessions.ts";
import { Products } from "../src/services/products.ts";
import { Barcodes } from "../src/services/barcodes.ts";
import { ProductPhotos } from "../src/web/photos.ts";
import { catalogJson } from "./fixtures.ts";
import { serveTestApp, setup, testConfig, tg } from "./helpers.ts";

const BOT_TOKEN = "123:TEST";
const ORIGIN = "https://kili.test";

function signed(fields: Record<string, string | number>, token = BOT_TOKEN) {
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(token).digest();
  return { ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") };
}

const apps: ReturnType<typeof serveTestApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

function world(
  extra: { products?: Products; barcodes?: Barcodes; photos?: ProductPhotos; adminIds?: number[]; notifyAdmins?: (html: string) => Promise<void> } = {},
) {
  const w = setup(undefined, [], extra.products, extra.barcodes);
  const alice = w.services.accounts.register(tg(1), { name: "alice", fullName: "Alice A", weight: 70, height: 170, gender: "nainen" }).profile;
  const bob = w.services.accounts.register(tg(2), { name: "bob", weight: 90, height: 185, gender: "mies" }).profile;
  const app = serveTestApp({ services: w.services, botToken: BOT_TOKEN, botUsername: "kili_bot", origin: ORIGIN, photos: extra.photos, adminIds: extra.adminIds, notifyAdmins: extra.notifyAdmins, docs: docsHtml(testConfig()) });
  apps.push(app);
  apps.push(app);
  const cookieOf = (accountId: string, identityId: string | null = null) =>
    `__Host-kili=${w.services.webSessions.createSession(accountId, identityId).sessionToken}`;
  /** A session signed in with Telegram user `telegramId` (as the widget and /web links make them). */
  const telegramCookie = (accountId: string, telegramId: number) => cookieOf(accountId, w.services.identities.key(tg(telegramId)));
  const call = (method: string, path: string, opts: { cookie?: string; body?: unknown; text?: string; origin?: string | null; csrf?: boolean; ip?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
    if (opts.csrf !== false && method !== "GET") headers["x-kili"] = "1";
    return app(
      new Request(`${ORIGIN}${path}`, { method, headers, body: opts.text ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) }),
      opts.ip ?? "1.2.3.4",
    );
  };
  return { ...w, alice, bob, app, call, cookieOf, telegramCookie };
}

describe("Telegram login widget", () => {
  const now = Date.parse("2026-11-06T20:00:00Z");
  const fields = (over: Record<string, string | number> = {}) => ({ id: 1, first_name: "Alice", username: "alice", auth_date: now / 1000 - 10, ...over });

  test("accepts a correctly signed login", () => {
    expect(verifyTelegramLogin(signed(fields()), BOT_TOKEN, now)).toEqual({ ok: true, telegramId: 1 });
  });

  test("rejects a changed field, a wrong bot token and a missing hash", () => {
    const good = signed(fields());
    expect(verifyTelegramLogin({ ...good, id: 2 }, BOT_TOKEN, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTelegramLogin(signed(fields(), "999:OTHER"), BOT_TOKEN, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyTelegramLogin(fields(), BOT_TOKEN, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTelegramLogin({ ...good, hash: "zz" }, BOT_TOKEN, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTelegramLogin(null, BOT_TOKEN, now)).toEqual({ ok: false, reason: "malformed" });
  });

  test("rejects old and future logins (replay)", () => {
    const old = signed(fields({ auth_date: now / 1000 - LOGIN_MAX_AGE_S - 1 }));
    expect(verifyTelegramLogin(old, BOT_TOKEN, now)).toEqual({ ok: false, reason: "expired" });
    const future = signed(fields({ auth_date: now / 1000 + 3600 }));
    expect(verifyTelegramLogin(future, BOT_TOKEN, now)).toEqual({ ok: false, reason: "expired" });
  });

  test("extra fields the client adds do not take part in the signature or let it through", () => {
    const good = signed(fields());
    expect(verifyTelegramLogin({ ...good, admin: true }, BOT_TOKEN, now)).toEqual({ ok: true, telegramId: 1 });
  });

  test("non-scalar values are malformed", () => {
    expect(verifyTelegramLogin({ ...signed(fields()), username: { a: 1 } }, BOT_TOKEN, now)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("web sessions", () => {
  test("a login link works once and then gives a session", () => {
    const { services, alice } = world();
    const { token } = services.webSessions.createLoginLink(alice.id, null);
    const s = services.webSessions.redeemLoginLink(token);
    expect(s).not.toBeNull();
    expect(services.webSessions.authenticate(s!.sessionToken)?.accountId).toBe(alice.id);
    expect(services.webSessions.redeemLoginLink(token)).toBeNull();
  });

  test("a login link expires, and a new one replaces the old", () => {
    const { services, clock, alice } = world();
    const first = services.webSessions.createLoginLink(alice.id, null).token;
    const second = services.webSessions.createLoginLink(alice.id, null).token;
    expect(services.webSessions.redeemLoginLink(first)).toBeNull();
    clock.now += LOGIN_LINK_TTL_MS + 1;
    expect(services.webSessions.redeemLoginLink(second)).toBeNull();
  });

  test("only hashes are stored", () => {
    const { services, db, alice } = world();
    const { token } = services.webSessions.createLoginLink(alice.id, null);
    const { sessionToken } = services.webSessions.redeemLoginLink(token)!;
    const stored = JSON.stringify(db.query("SELECT * FROM web_sessions").all()) + JSON.stringify(db.query("SELECT * FROM web_login_links").all());
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(sessionToken);
  });

  test("sessions slide while used and expire when idle", () => {
    const { services, clock, alice } = world();
    const { sessionToken } = services.webSessions.createSession(alice.id, null);
    clock.now += SESSION_TTL_MS - HOUR_MS;
    expect(services.webSessions.authenticate(sessionToken)).not.toBeNull(); // renews
    clock.now += SESSION_TTL_MS - HOUR_MS;
    expect(services.webSessions.authenticate(sessionToken)).not.toBeNull(); // still alive thanks to the renewal
    clock.now += SESSION_TTL_MS + 1;
    expect(services.webSessions.authenticate(sessionToken)).toBeNull();
  });

  test("revoke, revokeAll, prune and account deletion end sessions", () => {
    const { services, clock, alice, bob } = world();
    const a = services.webSessions.createSession(alice.id, null).sessionToken;
    const a2 = services.webSessions.createSession(alice.id, null).sessionToken;
    const b = services.webSessions.createSession(bob.id, null).sessionToken;
    services.webSessions.revoke(a);
    expect(services.webSessions.authenticate(a)).toBeNull();
    expect(services.webSessions.authenticate(a2)).not.toBeNull();
    services.webSessions.revokeAll(alice.id);
    expect(services.webSessions.authenticate(a2)).toBeNull();
    clock.now += SESSION_TTL_MS + 1;
    expect(services.webSessions.prune()).toBe(1);
    const c = services.webSessions.createSession(bob.id, null).sessionToken;
    services.accounts.delete(bob.id);
    expect(services.webSessions.authenticate(c)).toBeNull();
    expect(services.webSessions.authenticate(b)).toBeNull();
  });

  test("garbage tokens are just unknown", () => {
    const { services } = world();
    expect(services.webSessions.authenticate("nope")).toBeNull();
    expect(services.webSessions.authenticate("")).toBeNull();
  });
});

describe("API: sign-in", () => {
  test("Telegram login creates a session cookie with safe flags", async () => {
    const { call, clock } = world();
    const res = await call("POST", "/api/auth/telegram", { body: signed({ id: 1, first_name: "Alice", auth_date: Math.floor(clock.now / 1000) }) });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-kili=[\w-]{40,};/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(flag);
    expect(cookie).not.toContain("Domain");
  });

  test("an unregistered Telegram user is told to start the bot", async () => {
    const { call, clock } = world();
    const res = await call("POST", "/api/auth/telegram", { body: signed({ id: 999, auth_date: Math.floor(clock.now / 1000) }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_registered" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a forged or expired Telegram login is refused", async () => {
    const { call, clock } = world();
    const forged = await call("POST", "/api/auth/telegram", { body: { ...signed({ id: 1, auth_date: Math.floor(clock.now / 1000) }), id: 2 } });
    expect(forged.status).toBe(400);
    const old = await call("POST", "/api/auth/telegram", { body: signed({ id: 1, auth_date: Math.floor(clock.now / 1000) - 3600 }) });
    expect(old.status).toBe(401);
  });

  test("login links from /web redeem once", async () => {
    const { call, services, alice } = world();
    const { token } = services.webSessions.createLoginLink(alice.id, null);
    const ok = await call("POST", "/api/auth/link", { body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("__Host-kili=");
    const again = await call("POST", "/api/auth/link", { body: { token } });
    expect(again.status).toBe(401);
  });

  test("sign-in attempts are rate limited per address", async () => {
    const { call } = world();
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = (await call("POST", "/api/auth/link", { body: { token: "x" }, ip: "9.9.9.9" })).status;
    expect(last).toBe(429);
    expect((await call("POST", "/api/auth/link", { body: { token: "x" }, ip: "8.8.8.8" })).status).toBe(401);
  });

  test("logout ends the session", async () => {
    const { call, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    expect((await call("GET", "/api/me", { cookie })).status).toBe(200);
    const out = await call("POST", "/api/auth/logout", { cookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
  });

  test("logging out everywhere ends every session of the account, and no one else's", async () => {
    const { call, alice, bob, cookieOf } = world();
    const phone = cookieOf(alice.id);
    const laptop = cookieOf(alice.id);
    const other = cookieOf(bob.id);
    expect(await (await call("GET", "/api/auth/sessions", { cookie: phone })).json()).toEqual({ count: 2 });

    const out = await call("POST", "/api/auth/logout-all", { cookie: phone });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true, sessions: 2 });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/api/me", { cookie: phone })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: laptop })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: other })).status).toBe(200);
  });

  test("logging out everywhere needs a session and the CSRF checks", async () => {
    const { call, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    expect((await call("POST", "/api/auth/logout-all", { cookie, csrf: false })).status).toBe(403);
    expect((await call("POST", "/api/auth/logout-all", { cookie, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("POST", "/api/auth/logout-all")).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie })).status).toBe(200);
  });
});

describe("API: admin", () => {
  test("only a session signed in with a Telegram login in ADMIN_IDS is an admin", async () => {
    const { call, alice, bob, cookieOf, telegramCookie } = world({ adminIds: [1] });
    const admin = telegramCookie(alice.id, 1);
    expect(((await (await call("GET", "/api/me", { cookie: admin })).json()) as any).admin).toBe(true);
    expect((await call("GET", "/api/admin", { cookie: admin })).status).toBe(200);

    // Not admins: another user, the admin's account without a known login, and no session.
    for (const cookie of [telegramCookie(bob.id, 2), cookieOf(alice.id)]) {
      expect(((await (await call("GET", "/api/me", { cookie })).json()) as any).admin).toBe(false);
      expect((await call("GET", "/api/admin", { cookie })).status).toBe(404);
      expect((await call("DELETE", "/api/admin/products/4006381333931", { cookie })).status).toBe(404);
    }
    expect((await call("GET", "/api/admin")).status).toBe(401);
  });

  test("a session whose admin login now belongs to another account is not an admin", async () => {
    const { call, bob, services } = world({ adminIds: [1] });
    const forged = `__Host-kili=${services.webSessions.createSession(bob.id, services.identities.key(tg(1))).sessionToken}`;
    expect((await call("GET", "/api/admin", { cookie: forged })).status).toBe(404);
  });

  test("with no ADMIN_IDS nobody is an admin", async () => {
    const { call, alice, telegramCookie } = world();
    expect((await call("GET", "/api/admin", { cookie: telegramCookie(alice.id, 1) })).status).toBe(404);
  });

  test("shows the numbers and lets an admin remove any user-added product", async () => {
    const { call, alice, bob, services, telegramCookie } = world({ adminIds: [1] });
    const cookie = telegramCookie(alice.id, 1);
    services.drinks.add(bob.id, findPreset("b33a")!.mg, "beer");
    const saved = services.customProducts.save({ ean: "4006381333931", kind: "olut", name: "Bob's lager", sizeL: 0.33, abv: 4.7, kcal100: null }, bob.id, false);
    expect(saved.ok).toBe(true);

    const view = (await (await call("GET", "/api/admin", { cookie })).json()) as any;
    expect(view.bot).toMatchObject({ users: 2, drinks: 1, drinks24h: 1 });
    expect(view.bot.top).toEqual([{ name: "bob", value: 1 }]);
    expect(view.web).toMatchObject({ sessions: 1, accounts: 1 });
    expect(view.customProducts.total).toBe(1);
    expect(view.customProducts.items[0]).toMatchObject({ ean: "4006381333931", name: "Bob's lager", orphan: false });

    expect((await call("DELETE", "/api/admin/products/4006381333931", { cookie, csrf: false })).status).toBe(403);
    expect((await call("DELETE", "/api/admin/products/4006381333931", { cookie })).status).toBe(200);
    expect(services.customProducts.get("4006381333931")).toBeNull();
    expect((await call("DELETE", "/api/admin/products/4006381333931", { cookie })).status).toBe(404);
  });
});

describe("API: request checks", () => {
  test("state-changing requests need our origin and the custom header", async () => {
    const { call, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const body = { kind: "preset", id: "b33a" };
    expect((await call("POST", "/api/drinks", { cookie, body, origin: "https://evil.test" })).status).toBe(403);
    expect((await call("POST", "/api/drinks", { cookie, body, origin: null })).status).toBe(403);
    expect((await call("POST", "/api/drinks", { cookie, body, csrf: false })).status).toBe(403);
    expect((await call("POST", "/api/drinks", { cookie, body })).status).toBe(201);
  });

  test("sign-in is covered by the origin check too (login CSRF)", async () => {
    const { call } = world();
    expect((await call("POST", "/api/auth/link", { body: { token: "x" }, origin: "https://evil.test" })).status).toBe(403);
  });

  test("data needs a session", async () => {
    const { call } = world();
    for (const path of ["/api/me", "/api/dashboard", "/api/products?q=karhu"]) expect((await call("GET", path)).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: "__Host-kili=forged" })).status).toBe(401);
    expect((await call("GET", "/api/config")).status).toBe(200); // public
  });

  test("oversized or malformed bodies are rejected", async () => {
    const { call, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    expect((await call("POST", "/api/drinks", { cookie, body: { kind: "custom", pad: "x".repeat(10_000) } })).status).toBe(400);
    expect((await call("POST", "/api/drinks", { cookie, body: [1, 2] })).status).toBe(400);
    expect((await call("POST", "/api/drinks", { cookie, body: { kind: "nonsense" } })).status).toBe(400);
  });

  test("unknown routes are 404 JSON", async () => {
    const { call, alice, cookieOf } = world();
    const res = await call("GET", "/api/nope", { cookie: cookieOf(alice.id) });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("API: drinks", () => {
  test("presets, custom drinks and repeat are logged like the bot logs them", async () => {
    const { call, services, alice, bob, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const preset = findPreset("b33a")!;

    const a = await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a" } });
    expect(await a.json()).toMatchObject({ description: preset.name, alcoholMg: preset.mg, kcal: preset.kcal });

    const b = await call("POST", "/api/drinks", { cookie, body: { kind: "custom", cl: 33, percent: 5.1 } });
    expect(await b.json()).toMatchObject({ description: "Oma juoma - 33cl 5.1%", kcal: null });

    // What the repeat button says it will log.
    expect(((await (await call("GET", "/api/drinks/last", { cookie })).json()) as any).drink).toMatchObject({ description: "Oma juoma - 33cl 5.1%" });
    expect(await (await call("GET", "/api/drinks/last", { cookie: cookieOf(bob.id) })).json()).toEqual({ drink: null });

    const c = await call("POST", "/api/drinks", { cookie, body: { kind: "repeat" } });
    expect(await c.json()).toMatchObject({ description: "Oma juoma - 33cl 5.1%" });
    expect(services.drinks.since(alice.id, 0)).toHaveLength(3);
  });

  test("invalid presets and amounts are refused", async () => {
    const { call, services, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    expect((await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "nope" } })).status).toBe(404);
    expect((await call("POST", "/api/drinks", { cookie, body: { kind: "repeat" } })).status).toBe(404);
    for (const bad of [{ cl: 0, percent: 5 }, { cl: -3, percent: 5 }, { cl: 33, percent: 0 }, { cl: 33, percent: 100 }, { cl: 500, percent: 5 }, { cl: "33", percent: 5 }, { cl: Number.NaN, percent: 5 }]) {
      const res = await call("POST", "/api/drinks", { cookie, body: { kind: "custom", ...bad } });
      expect([400, 422]).toContain(res.status);
    }
    expect((await call("POST", "/api/drinks", { cookie, body: { kind: "custom", cl: 200, percent: 95 } })).status).toBe(422); // more than a bottle of strong wine
    expect(services.drinks.since(alice.id, 0)).toHaveLength(0);
  });

  test("undo removes the latest; delete removes only your own drink", async () => {
    const { call, services, alice, bob, cookieOf } = world();
    const mine = services.drinks.add(alice.id, 10_000, "a");
    const latest = services.drinks.add(alice.id, 10_000, "b", { at: services.deps.now() + 1000 });
    const bobs = services.drinks.add(bob.id, 10_000, "c");
    const cookie = cookieOf(alice.id);

    expect((await call("DELETE", `/api/drinks/${bobs.id}`, { cookie })).status).toBe(404);
    expect(services.drinks.get(bob.id, bobs.id)).not.toBeNull();

    expect(await (await call("POST", "/api/drinks/undo", { cookie })).json()).toMatchObject({ id: latest.id });
    expect((await call("DELETE", `/api/drinks/${mine.id}`, { cookie })).status).toBe(200);
    expect((await call("DELETE", `/api/drinks/${mine.id}`, { cookie })).status).toBe(404);
    expect((await call("POST", "/api/drinks/undo", { cookie })).status).toBe(404);
  });

  test("you only ever see and change your own account", async () => {
    const { call, services, alice, bob, cookieOf } = world();
    services.drinks.add(bob.id, 20_000, "bob's beer");
    const res = await call("GET", "/api/dashboard", { cookie: cookieOf(alice.id) });
    const d = (await res.json()) as any;
    expect(d.me.name).toBe("alice");
    expect(d.session.drinks).toHaveLength(0);
    expect(JSON.stringify(d)).not.toContain("bob");
    // an account id in the request is ignored
    await call("POST", "/api/drinks", { cookie: cookieOf(alice.id), body: { kind: "preset", id: "b33a", accountId: bob.id, userId: bob.id } });
    expect(services.drinks.since(bob.id, 0)).toHaveLength(1);
  });
});

describe("API: logbook", () => {
  test("filters by time and description, pages newest first, and totals the whole range", async () => {
    const { call, services, clock, alice, bob, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const t0 = clock.now - 10 * 24 * HOUR_MS;
    // Two evenings ten days ago and one today, plus one of Bob's that must never show.
    const old1 = services.drinks.add(alice.id, 10_000, "Karhu III 0,33 l", { at: t0, kcal: 100 });
    const old2 = services.drinks.add(alice.id, 10_000, "Karhu III 0,33 l", { at: t0 + HOUR_MS, kcal: 100 });
    const today1 = services.drinks.add(alice.id, 20_000, "Oma juoma - 4cl 40%", { at: clock.now - HOUR_MS });
    const today2 = services.drinks.add(alice.id, 10_000, "Lonkero 100%_x", { at: clock.now - MINUTE_MS, kcal: 150 });
    services.drinks.add(bob.id, 10_000, "Karhu III 0,33 l", { at: clock.now });

    const all = (await (await call("GET", "/api/drinks", { cookie })).json()) as any;
    expect(all.drinks.map((d: any) => d.id)).toEqual([today2.id, today1.id, old2.id, old1.id]);
    expect(all.totals).toMatchObject({ count: 4, kcal: 350, unknownKcal: 1, sessions: 2 });
    expect(all.totals.standardDrinks).toBeCloseTo(all.drinks.reduce((s: number, d: any) => s + d.standardDrinks, 0), 10);
    expect(all.next).toBeNull();

    // from is inclusive, to exclusive
    const recent = (await (await call("GET", `/api/drinks?from=${today1.createdAt}`, { cookie })).json()) as any;
    expect(recent.drinks.map((d: any) => d.id)).toEqual([today2.id, today1.id]);
    const older = (await (await call("GET", `/api/drinks?to=${today1.createdAt}`, { cookie })).json()) as any;
    expect(older.drinks.map((d: any) => d.id)).toEqual([old2.id, old1.id]);
    expect(older.totals).toMatchObject({ count: 2, sessions: 1 });

    // Search is a substring, case-insensitive, and % and _ are literal.
    const karhu = (await (await call("GET", "/api/drinks?q=KARHU", { cookie })).json()) as any;
    expect(karhu.totals.count).toBe(2);
    expect(((await (await call("GET", "/api/drinks?q=100%25_", { cookie })).json()) as any).drinks.map((d: any) => d.id)).toEqual([today2.id]);
    expect(((await (await call("GET", "/api/drinks?q=a%25r", { cookie })).json()) as any).totals.count).toBe(0); // not K-a-r-hu

    // Pages: limit, then the cursor continues where the last one ended; totals stay whole.
    const p1 = (await (await call("GET", "/api/drinks?limit=3", { cookie })).json()) as any;
    expect(p1.drinks).toHaveLength(3);
    expect(p1.totals.count).toBe(4);
    expect(p1.next).toBe(`${old2.createdAt}.${old2.id}`);
    const p2 = (await (await call("GET", `/api/drinks?limit=3&before=${p1.next}`, { cookie })).json()) as any;
    expect(p2.drinks.map((d: any) => d.id)).toEqual([old1.id]);
    expect(p2.next).toBeNull();
  });

  test("drinks logged in the same millisecond page without gaps or repeats", async () => {
    const { call, services, clock, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const ids = ["a", "b", "c", "d", "e"].map((x) => services.drinks.add(alice.id, 10_000, x, { at: clock.now }).id);
    const seen: number[] = [];
    let before = "";
    for (let i = 0; i < 5; i += 1) {
      const page = (await (await call("GET", `/api/drinks?limit=2${before ? `&before=${before}` : ""}`, { cookie })).json()) as any;
      seen.push(...page.drinks.map((d: any) => d.id));
      if (!page.next) break;
      before = page.next;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  test("a past session's curve has no forecast and ends at the last drink's burn-off", async () => {
    const { call, services, clock, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const a = services.drinks.add(alice.id, findPreset("b50")!.mg, "beer", { at: clock.now - 30 * 3_600_000 }).createdAt;
    const b = services.drinks.add(alice.id, findPreset("b50")!.mg, "beer", { at: clock.now - 29 * 3_600_000 }).createdAt;
    const res = await call("GET", `/api/drinks/chart?from=${a}&to=${b}`, { cookie });
    expect(res.status).toBe(200);
    const chart = (await res.json()) as any;
    expect(chart.history).toBe(true);
    expect(chart.now).toBe(chart.to);
    expect(chart.to).toBeLessThanOrEqual(clock.now + 3_600_000);
    expect(chart.lines).toHaveLength(1);
    expect(chart.lines[0].peak).toBeGreaterThan(0.1);
    for (const q of ["from=1", `from=${b}&to=${a}`, "from=x&to=2", `from=${a}&to=${a + 8 * 24 * 3_600_000}`]) {
      expect((await call("GET", `/api/drinks/chart?${q}`, { cookie })).status).toBe(400);
    }
    expect((await call("GET", `/api/drinks/chart?from=${a}&to=${b}`)).status).toBe(401);
  });

  test("bad parameters are refused and a session is needed", async () => {
    const { call, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    for (const q of ["from=abc", "to=-5", "from=1.5", "limit=x", "before=12", "before=a.b", "from=1e3"]) {
      expect((await call("GET", `/api/drinks?${q}`, { cookie })).status).toBe(400);
    }
    expect((await call("GET", "/api/drinks?limit=100000", { cookie })).status).toBe(200); // clamped
    expect((await call("GET", "/api/drinks")).status).toBe(401);
  });
});

describe("API: dashboard and profile", () => {
  test("shows the estimate, sober time, session and chart data", async () => {
    const { call, services, clock, alice, cookieOf } = world();
    services.drinks.add(alice.id, findPreset("b50")!.mg, "beer", { at: clock.now - 30 * MINUTE_MS, kcal: 200 });
    services.drinks.add(alice.id, findPreset("b50")!.mg, "beer 2", { at: clock.now - 10 * MINUTE_MS });
    const d = (await (await call("GET", "/api/dashboard", { cookie: cookieOf(alice.id) })).json()) as any;
    expect(d.now).toBe(clock.now);
    expect(d.permille).toBeCloseTo(services.drinks.ebac(alice.id).permilles, 10);
    expect(d.permille).toBeGreaterThan(0);
    expect(d.soberAt).toBeGreaterThan(clock.now);
    expect(d.session.drinks.map((x: any) => x.description)).toEqual(["beer", "beer 2"]);
    expect(d.session).toMatchObject({ kcal: 200, unknownKcal: 1 });
    expect(d.chart.lines).toHaveLength(1);
    expect(d.chart.lines[0].current).toBeCloseTo(d.permille, 2);
    expect(d.chart.lines[0].name).toBe("Alice A");
  });

  test("a sober user has no sober time and an empty chart", async () => {
    const { call, alice, cookieOf } = world();
    const d = (await (await call("GET", "/api/dashboard", { cookie: cookieOf(alice.id) })).json()) as any;
    expect(d.permille).toBe(0);
    expect(d.soberAt).toBeNull();
    expect(d.chart.lines).toEqual([]);
  });

  test("chart name and body data can be changed, validated as a whole", async () => {
    const { call, services, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const ok = await call("PATCH", "/api/me", { cookie, body: { chartName: "username", weight: 72 } });
    expect(await ok.json()).toMatchObject({ chartName: "username", chartLabel: "alice", weight: 72 });
    const bad = await call("PATCH", "/api/me", { cookie, body: { weight: 75, height: 5 } });
    expect(bad.status).toBe(422);
    expect(services.accounts.get(alice.id)!.weight).toBe(72); // nothing from the failed request was applied
    for (const body of [{ weight: "80" }, { weight: 19 }, { gender: "x" }, { chartName: "other" }]) {
      expect((await call("PATCH", "/api/me", { cookie, body })).status).toBe(422);
    }
  });
});

describe("API: catalogue", () => {
  test("search returns nothing while the catalogue is not loaded", async () => {
    const { call, alice, cookieOf } = world();
    expect(await (await call("GET", "/api/products?q=karhu", { cookie: cookieOf(alice.id) })).json()).toEqual({ products: [] });
  });

  test("the help, terms and privacy texts are public and come as blocks", async () => {
    const { call } = world();
    for (const page of ["help", "terms", "privacy"]) {
      const res = await call("GET", `/api/docs/${page}`);
      expect(res.status).toBe(200);
      const { blocks } = (await res.json()) as { blocks: { type: string; inline: { text: string; href?: string }[] }[] };
      const text = blocks.flatMap((b) => b.inline.map((i) => i.text)).join("");
      expect(blocks.length).toBeGreaterThan(2);
      expect(text).not.toMatch(/[<>{}]/); // no markup or unfilled placeholders reach the browser
    }
    const privacy = (await (await call("GET", "/api/docs/privacy")).json()) as any;
    expect(privacy.blocks[0]).toMatchObject({ type: "heading", inline: [{ text: "Mitä tietoja kerätään?" }] });
    expect(privacy.blocks.some((b: any) => b.type === "item")).toBe(true);
    const help = (await (await call("GET", "/api/docs/help")).json()) as any;
    expect(help.blocks.some((b: any) => b.type === "section")).toBe(true);
    // Links come from <a> and from bare URLs, and only http(s) ones.
    expect(help.blocks.flatMap((b: any) => b.inline).some((i: any) => i.href === "https://alkometriikka.fi")).toBe(true);
    expect((await call("GET", "/api/docs/nonsense")).status).toBe(404);
  });

  test("config lists the presets and the bot name", async () => {
    const { call } = world();
    const c = (await (await call("GET", "/api/config")).json()) as any;
    expect(c.botUsername).toBe("kili_bot");
    expect(c.botId).toBe(Number(BOT_TOKEN.split(":")[0]));
    expect(c.presets.find((p: any) => p.id === "b33a")).toMatchObject({ category: "miedot" });
  });
});

describe("API: product photos", () => {
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
  function photoWorld(answer: (url: string) => Response = () => new Response(WEBP, { headers: { "content-type": "image/webp" } })) {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return answer(String(input));
    }) as typeof fetch;
    const products = new Products();
    products.load(catalogJson());
    const w = world({ products, photos: new ProductPhotos({ fetch: fakeFetch }) });
    return { ...w, requests, cookie: w.cookieOf(w.alice.id) };
  }

  test("are fetched by the server with nothing about the visitor, and cached", async () => {
    const { call, cookie, requests } = photoWorld();
    const res = await call("GET", "/api/products/700022/photo", { cookie, ip: "9.9.9.9" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=604800");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://images.alko.fi/images/t_products/cdn/700022/kuva.webp");
    const sent = JSON.stringify(requests[0]!.init);
    for (const leak of [cookie.split("=")[1]!, "9.9.9.9", ORIGIN, "cookie", "forwarded"]) expect(sent.toLowerCase()).not.toContain(leak.toLowerCase());
    expect(requests[0]!.init?.referrerPolicy).toBe("no-referrer");
    expect(requests[0]!.init?.credentials).toBe("omit");

    expect((await call("GET", "/api/products/700022/photo", { cookie })).status).toBe(200);
    expect(requests).toHaveLength(1); // from memory
  });

  test("only for catalogue products and signed-in visitors", async () => {
    const { call, cookie, requests } = photoWorld();
    expect((await call("GET", "/api/products/999999/photo", { cookie })).status).toBe(404);
    expect((await call("GET", "/api/products/..%2F..%2Fx/photo", { cookie })).status).toBe(404);
    expect((await call("GET", "/api/products/700022/photo")).status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  test("a product without a photo is a 404 that is remembered; non-images are refused", async () => {
    const missing = photoWorld(() => new Response(null, { status: 400 }));
    expect((await missing.call("GET", "/api/products/700022/photo", { cookie: missing.cookie })).status).toBe(404);
    expect((await missing.call("GET", "/api/products/700022/photo", { cookie: missing.cookie })).status).toBe(404);
    expect(missing.requests).toHaveLength(1);

    const html = photoWorld(() => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }));
    expect((await html.call("GET", "/api/products/700022/photo", { cookie: html.cookie })).status).toBe(502);
  });
});

describe("API: barcodes", () => {
  const BEER_EAN = "4006381333931"; // Karjala, in the catalogue's EAN column
  const WORKER_EAN = "96385074"; // not in the catalogue: the API Worker knows it (Karjala again)
  const ALCOHOL_FREE_EAN = "4006381334013"; // Karhu 0,0, which can't be logged
  const UNKNOWN_EAN = "4006381333948"; // Alko doesn't know it
  const GONE_EAN = "4006381333979"; // an Alko product no longer in the catalogue
  const LIMITED_EAN = "4006381333955";
  const DOWN_EAN = "4006381333962";
  const ADMIN_TG = 77;

  function barcodeWorld() {
    const requests: string[] = [];
    const notices: string[] = [];
    const fakeWorker = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      const ean = url.pathname.split("/").pop()!;
      const id = { [ALCOHOL_FREE_EAN]: "700040", [WORKER_EAN]: "700004", [GONE_EAN]: "999999" }[ean];
      if (id) return new Response(JSON.stringify({ id }));
      if (ean === LIMITED_EAN) return new Response("{}", { status: 429 });
      if (ean === DOWN_EAN) return new Response("{}", { status: 502 });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as typeof fetch;
    const products = new Products();
    products.load(catalogJson());
    const w = world({ products, barcodes: new Barcodes({ url: "https://api.test", fetch: fakeWorker }), adminIds: [ADMIN_TG], notifyAdmins: async (html) => void notices.push(html) });
    return { ...w, requests, notices, alice: w.cookieOf(w.alice.id), bob: w.cookieOf(w.bob.id), aliceId: w.alice.id, bobId: w.bob.id };
  }
  const beer = { kind: "olut", name: "Kaupan Olut", sizeL: 0.33, abv: 4.7, kcal100: 43 };

  test("are looked up like in the bot: the catalogue, then the Worker, which gets only the number", async () => {
    const { call, alice, requests } = barcodeWorld();
    expect(((await (await call("GET", "/api/config")).json()) as any).barcodes).toBe(true);

    const hit = await call("GET", `/api/barcodes/${BEER_EAN}`, { cookie: alice });
    expect(hit.status).toBe(200);
    const found = await hit.json();
    expect(found).toMatchObject({ status: "found", ean: BEER_EAN, custom: null, product: { id: "700004", photo: true } });
    expect(requests).toEqual([]);

    expect(await (await call("GET", `/api/barcodes/${WORKER_EAN}`, { cookie: alice })).json()).toMatchObject({ status: "found", product: { id: "700004" } });
    expect(requests).toEqual([`/gtin/${WORKER_EAN}`]);
  });

  test("other answers and errors", async () => {
    const { call, alice } = barcodeWorld();
    const get = async (ean: string) => {
      const res = await call("GET", `/api/barcodes/${ean}`, { cookie: alice });
      return { status: res.status, body: await res.json() };
    };
    expect(await get(UNKNOWN_EAN)).toEqual({ status: 200, body: { status: "unknown", ean: UNKNOWN_EAN } });
    expect(await get(GONE_EAN)).toEqual({ status: 200, body: { status: "gone", ean: GONE_EAN } });
    expect((await get(ALCOHOL_FREE_EAN)).body).toMatchObject({ status: "alcohol_free", ean: ALCOHOL_FREE_EAN });
    expect(await get(LIMITED_EAN)).toEqual({ status: 429, body: { error: "barcode_rate_limited" } });
    expect(await get(DOWN_EAN)).toEqual({ status: 503, body: { error: "barcode_unavailable" } });
    expect(await get("4006381333932")).toEqual({ status: 422, body: { error: "invalid_barcode" } }); // bad checksum
    expect(await get("123")).toEqual({ status: 422, body: { error: "invalid_barcode" } });
    expect((await call("GET", `/api/barcodes/${BEER_EAN}`)).status).toBe(401);
  });

  test("a user-added product opens for everyone, can be logged, and only its adder may change it", async () => {
    const { call, alice, bob, bobId, services } = barcodeWorld();
    const put = (cookie: string, body: unknown) => call("PUT", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie, body });

    const made = await put(alice, beer);
    expect(made.status).toBe(201);
    const result = await made.json();
    expect(result).toMatchObject({ status: "found", ean: UNKNOWN_EAN, product: { id: `e${UNKNOWN_EAN}`, name: "Kaupan Olut", photo: false }, custom: { kind: "olut", sizeL: 0.33, kcal100: 43, canEdit: true } });

    const seen = await (await call("GET", `/api/barcodes/${UNKNOWN_EAN}`, { cookie: bob })).json() as any;
    expect(seen.custom.canEdit).toBe(false);
    const serving = seen.product.servings[0].key;
    const logged = await call("POST", "/api/drinks", { cookie: bob, body: { kind: "product", productId: `e${UNKNOWN_EAN}`, serving } });
    expect(logged.status).toBe(201);
    expect(((await logged.json()) as any).description).toContain("Kaupan Olut");
    expect(services.drinks.last(bobId)!.productId).toBeNull(); // only Alko numbers go into product_id

    expect((await put(bob, { ...beer, name: "Bobin olut" })).status).toBe(403);
    expect((await call("DELETE", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: bob })).status).toBe(403);

    const edited = await put(alice, { ...beer, name: "Kaupan Olut IVA", kcal100: null });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as any).custom).toMatchObject({ name: "Kaupan Olut IVA", kcal100: null });

    expect((await call("DELETE", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: alice })).status).toBe(200);
    expect(await (await call("GET", `/api/barcodes/${UNKNOWN_EAN}`, { cookie: alice })).json()).toEqual({ status: "unknown", ean: UNKNOWN_EAN });
    expect((await call("DELETE", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: alice })).status).toBe(404);
  });

  test("admins may change anyone's product", async () => {
    const w = barcodeWorld();
    expect((await w.call("PUT", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: w.bob, body: beer })).status).toBe(201);
    const admin = w.telegramCookie(w.aliceId, 1); // signed in with Telegram, but not an admin's id
    expect((await w.call("DELETE", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: admin })).status).toBe(403);

    const carol = w.services.accounts.register(tg(ADMIN_TG), { name: "carol", weight: 60, height: 165, gender: "nainen" }).profile;
    const adminCookie = w.telegramCookie(carol.id, ADMIN_TG);
    const seen = await (await w.call("GET", `/api/barcodes/${UNKNOWN_EAN}`, { cookie: adminCookie })).json() as any;
    expect(seen.custom.canEdit).toBe(true);
    expect((await w.call("DELETE", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: adminCookie })).status).toBe(200);
  });

  test("anyone can report an error in a user-added product; admins see and clear the reports", async () => {
    const w = barcodeWorld();
    const report = (cookie: string, message: unknown, ean = UNKNOWN_EAN) => w.call("POST", `/api/barcodes/${ean}/report`, { cookie, body: { message } });
    expect((await report(w.bob, "Väärä prosentti")).status).toBe(404); // no product yet
    expect((await w.call("PUT", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: w.alice, body: beer })).status).toBe(201);

    expect(((await (await report(w.bob, "   ")).json()) as any).error).toBe("invalid_report");
    expect(((await (await report(w.bob, 5)).json()) as any).error).toBe("invalid_report");
    expect(((await (await report(w.bob, "x".repeat(301))).json()) as any).error).toBe("invalid_report");
    expect((await w.call("POST", `/api/barcodes/${UNKNOWN_EAN}/report`, { cookie: w.bob, body: { message: "x" }, csrf: false })).status).toBe(403);
    expect(w.notices).toEqual([]);

    expect((await report(w.bob, "Prosentti on <5,5>")).status).toBe(200);
    expect(w.notices.length).toBe(1);
    expect(w.notices[0]).toContain("Prosentti on &lt;5,5&gt;");
    expect(w.notices[0]).toContain("Kaupan Olut");
    expect(w.notices[0]).not.toContain("bob");
    expect((await report(w.bob, "Ja koko on 50 cl")).status).toBe(200); // replaces; no second notice
    expect(w.notices.length).toBe(1);

    const carol = w.services.accounts.register(tg(ADMIN_TG), { name: "carol", weight: 60, height: 165, gender: "nainen" }).profile;
    const admin = w.telegramCookie(carol.id, ADMIN_TG);
    const view = (await (await w.call("GET", "/api/admin", { cookie: admin })).json()) as any;
    expect(view.reported).toHaveLength(1);
    expect(view.reported[0]).toMatchObject({ ean: UNKNOWN_EAN, name: "Kaupan Olut", reports: [{ message: "Ja koko on 50 cl" }] });
    expect(JSON.stringify(view.reported)).not.toContain(w.bobId);

    // Only admins clear them.
    expect((await w.call("DELETE", `/api/admin/products/${UNKNOWN_EAN}/reports`, { cookie: w.bob })).status).toBe(404);
    expect((await w.call("DELETE", `/api/admin/products/${UNKNOWN_EAN}/reports`, { cookie: admin })).status).toBe(200);
    expect(((await (await w.call("GET", "/api/admin", { cookie: admin })).json()) as any).reported).toEqual([]);

    // Deleting the product takes its reports with it.
    await report(w.bob, "Taas väärin");
    expect((await w.call("DELETE", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: w.alice })).status).toBe(200);
    expect(w.services.customProducts.reported()).toEqual([]);
  });

  test("one account can't flood the admins with reports", () => {
    const w = barcodeWorld();
    for (let i = 0; i < 21; i++) {
      const ean = String(40063813000 + i).padStart(12, "0");
      const sum = [...ean].reduce((s, d, j) => s + Number(d) * (j % 2 ? 3 : 1), 0);
      const full = ean + ((10 - (sum % 10)) % 10);
      expect(w.services.customProducts.save({ ...beer, kind: "olut", ean: full }, w.aliceId, false).ok).toBe(true);
      const r = w.services.customProducts.report(full, w.bobId, "väärin");
      expect(r.ok ? "ok" : r.reason).toBe(i < 20 ? "ok" : "too_many");
    }
  });

  test("products are validated, and barcodes Alko knows can't be given one", async () => {
    const { call, alice } = barcodeWorld();
    const put = async (body: unknown, ean = UNKNOWN_EAN) => {
      const res = await call("PUT", `/api/barcodes/${ean}/product`, { cookie: alice, body });
      return [res.status, ((await res.json()) as any).error];
    };
    expect(await put(beer, BEER_EAN)).toEqual([409, "in_catalogue"]);
    expect(await put({ ...beer, kind: "mehu" })).toEqual([422, "invalid_kind"]);
    expect(await put({ ...beer, name: "   " })).toEqual([422, "invalid_product_name"]);
    expect(await put({ ...beer, name: "x".repeat(61) })).toEqual([422, "invalid_product_name"]);
    expect(await put({ ...beer, sizeL: 6 })).toEqual([422, "invalid_size"]);
    expect(await put({ ...beer, sizeL: "0.33" })).toEqual([422, "invalid_size"]);
    expect(await put({ ...beer, abv: 0.5 })).toEqual([422, "invalid_abv"]);
    expect(await put({ ...beer, kcal100: -1 })).toEqual([422, "invalid_kcal"]);
    expect((await call("PUT", `/api/barcodes/${UNKNOWN_EAN}/product`, { cookie: alice, body: beer, csrf: false })).status).toBe(403);
  });

  test("are off without the catalogue and the Worker", async () => {
    const w = world();
    expect(((await (await w.call("GET", "/api/config")).json()) as any).barcodes).toBe(false);
    const res = await w.call("GET", `/api/barcodes/${BEER_EAN}`, { cookie: w.cookieOf(w.alice.id) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("barcodes_off");
  });

  test("lookups have their own rate limit, since the Worker's is shared", async () => {
    const { call, alice } = barcodeWorld();
    for (let i = 0; i < 30; i++) expect((await call("GET", `/api/barcodes/${BEER_EAN}`, { cookie: alice })).status).toBe(200);
    expect((await call("GET", `/api/barcodes/${BEER_EAN}`, { cookie: alice })).status).toBe(429);
  });
});

describe("static site", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  // root/dist is the build; root/secret.txt is next to it and must never be served.
  function site(html = "<html><body><script>window.x=1</script></body></html>") {
    const root = mkdtempSync(join(tmpdir(), "kili-web-"));
    roots.push(root);
    const dir = join(root, "dist");
    mkdirSync(join(dir, "_app", "immutable"), { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    writeFileSync(join(dir, "_app", "immutable", "a.js"), "export {}");
    writeFileSync(join(dir, "service-worker.js"), "");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
    writeFileSync(join(root, "secret.txt"), "top secret");
    return { dir, site: new StaticSite(dir) };
  }

  test("serves files, falls back to the app for routes and sets security headers", async () => {
    const { site: s } = site();
    const page = await s.serve("/groups/abc");
    expect(await page.text()).toContain("window.x=1");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self' 'sha256-");
    // The barcode scanner: its WebAssembly decoder compiles, and our own pages may use the camera.
    expect(page.headers.get("content-security-policy")).toMatch(/script-src [^;]*'wasm-unsafe-eval'/);
    expect(page.headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
    expect(page.headers.get("permissions-policy")).toContain("camera=(self)");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("content-security-policy")).not.toContain("alko"); // photos come through /api
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    const asset = await s.serve("/_app/immutable/a.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await s.serve("/missing.js")).status).toBe(404);
    // PWA: a new service worker is noticed on the next visit; the manifest has its own type.
    expect((await s.serve("/service-worker.js")).headers.get("cache-control")).toBe("no-cache");
    expect((await s.serve("/manifest.webmanifest")).headers.get("content-type")).toContain("application/manifest+json");
  });

  test("no page may load Telegram's widget (sign-in is a redirect)", async () => {
    const { site: s } = site();
    for (const p of ["/login", "/"]) {
      const csp = (await s.serve(p)).headers.get("content-security-policy")!;
      expect(csp).not.toContain("telegram");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).not.toContain("'unsafe-eval'");
    }
  });

  test("path traversal never leaves the build directory", async () => {
    const { site: s } = site();
    expect(await (await s.serve("/secret.txt")).text()).not.toContain("top secret"); // not in dist at all
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/_app/../../secret.txt", "/_app/immutable/../../../secret.txt", "//etc/passwd", "/%00"]) {
      const res = await s.serve(p);
      expect(await res.text()).not.toContain("top secret");
      expect(res.status === 404 || res.status === 400 || res.headers.get("content-type")?.includes("text/html")).toBe(true);
    }
  });

  test("inline script hashes are computed, external scripts are not hashed", () => {
    const hashes = inlineScriptHashes(`<script src="/a.js"></script><script>alert(1)</script>`);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(contentSecurityPolicy(hashes)).toContain(hashes[0]!);
  });

  test("without a build there is a clear 503", async () => {
    const res = await new StaticSite(join(tmpdir(), "does-not-exist-kili")).serve("/");
    expect(res.status).toBe(503);
  });
});

describe("WEB_* config", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const load = (env: Record<string, string>) => {
    process.env = { ...saved, BOT_TOKEN: "1:x", APP_SECRET: "x".repeat(32), ...env };
    return testConfig();
  };

  test("off by default, and the origin is not needed then", () => {
    expect(load({ WEB_ENABLED: "", WEB_ORIGIN: "" }).web.enabled).toBe(false);
  });

  test("needs an https origin without a path", () => {
    expect(load({ WEB_ENABLED: "1", WEB_ORIGIN: "https://kili.example.com/" }).web.origin).toBe("https://kili.example.com");
    expect(load({ WEB_ENABLED: "1", WEB_ORIGIN: "http://localhost:5173" }).web.origin).toBe("http://localhost:5173");
    for (const origin of ["", "kili.example.com", "http://kili.example.com", "https://kili.example.com/app", "javascript:alert(1)"]) {
      expect(() => load({ WEB_ENABLED: "1", WEB_ORIGIN: origin })).toThrow(/WEB_ORIGIN/);
    }
  });
});

describe("API: favourites", () => {
  test("pin a logged drink, log it again, remove it", async () => {
    const { call, alice, cookieOf, services } = world();
    const cookie = cookieOf(alice.id);
    const logged = (await (await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a" } })).json()) as any;

    const pinned = (await (await call("POST", "/api/favorites", { cookie, body: { drinkId: logged.id } })).json()) as any;
    expect(pinned.result).toBe("added");
    expect(pinned.favorites).toHaveLength(1);
    const again = (await (await call("POST", "/api/favorites", { cookie, body: { drinkId: logged.id } })).json()) as any;
    expect(again.result).toBe("exists");

    const fav = pinned.favorites[0];
    const second = await call("POST", "/api/drinks", { cookie, body: { kind: "favorite", id: fav.id } });
    expect(second.status).toBe(201);
    expect(((await second.json()) as any).description).toBe(logged.description);
    expect(services.drinks.since(alice.id, 0)).toHaveLength(2);

    expect((await call("DELETE", `/api/favorites/${fav.id}`, { cookie })).status).toBe(200);
    expect((await call("DELETE", `/api/favorites/${fav.id}`, { cookie })).status).toBe(404);
    expect((await call("POST", "/api/drinks", { cookie, body: { kind: "favorite", id: fav.id } })).status).toBe(404);
  });

  test("are one's own: another account can neither pin nor log them", async () => {
    const { call, alice, bob, cookieOf } = world();
    const a = cookieOf(alice.id);
    const b = cookieOf(bob.id);
    const logged = (await (await call("POST", "/api/drinks", { cookie: a, body: { kind: "preset", id: "b33a" } })).json()) as any;
    const fav = ((await (await call("POST", "/api/favorites", { cookie: a, body: { drinkId: logged.id } })).json()) as any).favorites[0];
    expect((await call("POST", "/api/favorites", { cookie: b, body: { drinkId: logged.id } })).status).toBe(404);
    expect((await call("POST", "/api/drinks", { cookie: b, body: { kind: "favorite", id: fav.id } })).status).toBe(404);
    expect((await call("DELETE", `/api/favorites/${fav.id}`, { cookie: b })).status).toBe(404);
  });

  test("at most eight", async () => {
    const { call, alice, cookieOf, services } = world();
    const cookie = cookieOf(alice.id);
    for (let i = 0; i < 9; i++) {
      const d = services.drinks.add(alice.id, 10_000 + i, `Juoma ${i}`);
      const r = (await (await call("POST", "/api/favorites", { cookie, body: { drinkId: d.id } })).json()) as any;
      expect(r.result).toBe(i < 8 ? "added" : "full");
    }
  });
});

describe("API: backdated drinks", () => {
  test("a drink can be dated up to a week back, not further and not ahead", async () => {
    const { call, alice, cookieOf, clock } = world();
    const cookie = cookieOf(alice.id);
    const log = (at: unknown) => call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a", at } });
    const ok = await log(clock.now - 2 * HOUR_MS);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).createdAt).toBe(clock.now - 2 * HOUR_MS);
    expect((await log(clock.now - 8 * 24 * HOUR_MS)).status).toBe(422);
    expect((await log(clock.now + HOUR_MS)).status).toBe(422);
    expect((await log("yesterday")).status).toBe(422);
    expect((await log(1.5)).status).toBe(422);
    // a few seconds ahead (clock drift between browser and server) is the present
    expect(((await (await log(clock.now + 5_000)).json()) as any).createdAt).toBe(clock.now);
  });

  test("works for repeat and favourites too", async () => {
    const { call, alice, cookieOf, clock } = world();
    const cookie = cookieOf(alice.id);
    const first = (await (await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a" } })).json()) as any;
    const fav = ((await (await call("POST", "/api/favorites", { cookie, body: { drinkId: first.id } })).json()) as any).favorites[0];
    const at = clock.now - 3 * HOUR_MS;
    expect(((await (await call("POST", "/api/drinks", { cookie, body: { kind: "repeat", at } })).json()) as any).createdAt).toBe(at);
    expect(((await (await call("POST", "/api/drinks", { cookie, body: { kind: "favorite", id: fav.id, at: at - 1 } })).json()) as any).createdAt).toBe(at - 1);
  });
});

describe("API: the account's data", () => {
  const unzip = (bytes: Uint8Array) => {
    // Reads the stored entries of our own zip: name → text.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: Record<string, string> = {};
    let at = 0;
    while (view.getUint32(at, true) === 0x04034b50) {
      const size = view.getUint32(at + 18, true);
      const nameLength = view.getUint16(at + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
      const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
      expect(Bun.hash.crc32(data)).toBe(view.getUint32(at + 14, true));
      out[name] = new TextDecoder().decode(data);
      at += 30 + nameLength + size;
    }
    return out;
  };

  test("export is a zip of the CSV files, importable again", async () => {
    const { call, alice, cookieOf, services } = world();
    const cookie = cookieOf(alice.id);
    await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a" } });
    const res = await call("GET", "/api/account/export", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="blakkiskili-\d{4}-\d\d-\d\d\.zip"$/);
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["user.csv", "drinks.csv", "groups.csv"]));
    expect(files["user.csv"]).toContain(legacyHash(1));
    expect(files["drinks.csv"]).toContain(legacyHash(1));

    // the same files go back in (drinks are already there)
    const back = (await (await call("POST", "/api/account/import", { cookie, text: files["drinks.csv"]! })).json()) as any;
    expect(back.ok).toBe(true);
    expect(back.message).toContain("1 oli jo tallessa");
    expect(services.drinks.since(alice.id, 0)).toHaveLength(1);
  });

  test("export needs a session", async () => {
    const { call } = world();
    expect((await call("GET", "/api/account/export")).status).toBe(401);
  });

  test("import takes the old bot's files, and only the person's own", async () => {
    const { call, alice, cookieOf, services } = world();
    const cookie = cookieOf(alice.id);
    const drinks = (userid: string) =>
      toCsv(["id", "userid", "alcohol", "description", "created"], [{ id: 1, userid, alcohol: 12379, description: "🍺 33cl 4.7%", created: new Date("2024-05-01T18:30:00Z") }]);

    const foreign = (await (await call("POST", "/api/account/import", { cookie, text: drinks(legacyHash(2)) })).json()) as any;
    expect(foreign.ok).toBe(false);
    expect(foreign.message).toContain("ei ole sinun");
    expect(services.drinks.since(alice.id, 0)).toHaveLength(0);

    const mine = (await (await call("POST", "/api/account/import", { cookie, text: drinks(legacyHash(1)) })).json()) as any;
    expect(mine).toMatchObject({ ok: true });
    expect(mine.message).toContain("1 juomaa lisätty");
    expect(services.drinks.since(alice.id, 0)).toHaveLength(1);

    const junk = (await (await call("POST", "/api/account/import", { cookie, text: "a,b\n1,2\n" })).json()) as any;
    expect(junk.ok).toBe(false);
  });

  test("import rejects an oversized file", async () => {
    const { call, alice, cookieOf } = world();
    const res = await call("POST", "/api/account/import", { cookie: cookieOf(alice.id), text: "x".repeat(10 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  test("deleting the account removes everything and signs out", async () => {
    const { call, alice, bob, cookieOf, services } = world();
    const cookie = cookieOf(alice.id);
    await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a" } });
    expect((await call("DELETE", "/api/account", { cookie })).status).toBe(400); // no confirmation
    expect(services.accounts.get(alice.id)).not.toBeNull();

    const res = await call("DELETE", "/api/account", { cookie, body: { confirm: true } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(services.accounts.get(alice.id)).toBeNull();
    expect(services.drinks.since(alice.id, 0)).toHaveLength(0);
    expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
    expect(services.accounts.get(bob.id)).not.toBeNull();
  });
});
