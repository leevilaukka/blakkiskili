import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { findPreset } from "../src/lib/catalog.ts";
import { createWebApp } from "../src/web/app.ts";
import { contentSecurityPolicy, inlineScriptHashes, StaticSite } from "../src/web/static.ts";
import { LOGIN_MAX_AGE_S, verifyTelegramLogin } from "../src/web/telegram.ts";
import { HOUR_MS, MINUTE_MS } from "../src/lib/units.ts";
import { LOGIN_LINK_TTL_MS, SESSION_TTL_MS } from "../src/services/websessions.ts";
import { setup, tg } from "./helpers.ts";

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

function world() {
  const w = setup();
  const alice = w.services.accounts.register(tg(1), { name: "alice", fullName: "Alice A", weight: 70, height: 170, gender: "nainen" }).profile;
  const bob = w.services.accounts.register(tg(2), { name: "bob", weight: 90, height: 185, gender: "mies" }).profile;
  const app = createWebApp({ services: w.services, botToken: BOT_TOKEN, botUsername: "kili_bot", origin: ORIGIN });
  const cookieOf = (accountId: string) => `__Host-kili=${w.services.webSessions.createSession(accountId, null).sessionToken}`;
  const call = (method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null; csrf?: boolean; ip?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
    if (opts.csrf !== false && method !== "GET") headers["x-kili"] = "1";
    return app(
      new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
      opts.ip ?? "1.2.3.4",
    );
  };
  return { ...w, alice, bob, app, call, cookieOf };
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
    const { call, services, alice, cookieOf } = world();
    const cookie = cookieOf(alice.id);
    const preset = findPreset("b33a")!;

    const a = await call("POST", "/api/drinks", { cookie, body: { kind: "preset", id: "b33a" } });
    expect(await a.json()).toMatchObject({ description: preset.name, alcoholMg: preset.mg, kcal: preset.kcal });

    const b = await call("POST", "/api/drinks", { cookie, body: { kind: "custom", cl: 33, percent: 5.1 } });
    expect(await b.json()).toMatchObject({ description: "Oma juoma - 33cl 5.1%", kcal: null });

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

  test("config lists the presets and the bot name", async () => {
    const { call } = world();
    const c = (await (await call("GET", "/api/config")).json()) as any;
    expect(c.botUsername).toBe("kili_bot");
    expect(c.presets.find((p: any) => p.id === "b33a")).toMatchObject({ category: "miedot" });
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
    writeFileSync(join(root, "secret.txt"), "top secret");
    return { dir, site: new StaticSite(dir) };
  }

  test("serves files, falls back to the app for routes and sets security headers", async () => {
    const { site: s } = site();
    const page = await s.serve("/groups/abc");
    expect(await page.text()).toContain("window.x=1");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self' 'sha256-");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    const asset = await s.serve("/_app/immutable/a.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await s.serve("/missing.js")).status).toBe(404);
  });

  test("only the sign-in page may load Telegram's widget", async () => {
    const { site: s } = site();
    expect((await s.serve("/login")).headers.get("content-security-policy")).toContain("https://telegram.org");
    expect((await s.serve("/")).headers.get("content-security-policy")).not.toContain("telegram");
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
    expect(contentSecurityPolicy(hashes, false)).toContain(hashes[0]!);
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
    return loadConfig();
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
