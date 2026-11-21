// The website without an account (LOCAL_ACCOUNTS): the browser's own copy of the drink handlers
// (web/src/lib/local/core.ts) must give the server's numbers, and the server's side: catalogue for
// visitors, and moving a local account's data online.

import { afterEach, describe, expect, test } from "bun:test";
import { docsHtml } from "../src/bot/context.ts";
import { findPreset } from "../src/lib/catalog.ts";
import { HOUR_MS, MINUTE_MS } from "../src/lib/units.ts";
import { Products } from "../src/services/products.ts";
import * as core from "../web/src/lib/local/core.ts";
import { catalogJson } from "./fixtures.ts";
import { serveTestApp, setup, testConfig, tg } from "./helpers.ts";

const ORIGIN = "https://kili.test";
const apps: ReturnType<typeof serveTestApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

async function world(local = true) {
  const products = new Products();
  products.load(catalogJson());
  const w = setup(undefined, [], products);
  const alice = w.services.accounts.register(tg(1), { name: "alice", weight: 70, height: 170, gender: "nainen" }).profile;
  const app = serveTestApp({ services: w.services, botToken: "123:TEST", botUsername: "kili_bot", origin: ORIGIN, auth: { passkeys: false, local } });
  apps.push(app);
  const cookie = `__Host-kili=${w.services.webSessions.createSession(alice.id, w.services.identities.key(tg(1))).sessionToken}`;
  const call = async (method: string, path: string, opts: { body?: unknown; signedIn?: boolean; ip?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.signedIn) headers.cookie = cookie;
    if (method !== "GET") Object.assign(headers, { origin: ORIGIN, "x-kili": "1" });
    return app(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), opts.ip);
  };
  return { ...w, alice, products, call };
}

describe("the local account computes what the server would", () => {
  test("dashboard, logbook and a past session's chart", async () => {
    const w = await world();
    const now = w.clock.now;
    const data = core.newLocalData({ name: "alice", weight: 70, height: 170, gender: "nainen" }, now);
    // Two evenings: one 3 days back (another session), and tonight.
    const plan: [number, string][] = [
      [-74 * HOUR_MS, "b33a"],
      [-73 * HOUR_MS, "s40"],
      [-200 * MINUTE_MS, "b33a"],
      [-140 * MINUTE_MS, "b50"],
      [-85 * MINUTE_MS, "s40"],
      [-30 * MINUTE_MS, "w16"],
    ];
    for (const [ago, id] of plan) {
      const p = findPreset(id)!;
      w.services.drinks.add(w.alice.id, p.mg, p.name, { at: now + ago, kcal: p.kcal });
      core.addDrink(data, { alcoholMg: p.mg, description: p.name, productId: null, kcal: p.kcal }, now + ago);
    }
    const server = (await (await w.call("GET", "/api/dashboard", { signedIn: true })).json()) as ReturnType<typeof core.dashboard>;
    const local = core.dashboard(data, now);
    // chartName differs by design: a local account has no Telegram full name, so it's always the name.
    const withoutIds = (d: typeof local) => ({
      ...d,
      me: { ...d.me, chartName: null },
      session: { ...d.session, drinks: d.session.drinks.map(({ id: _i, ...x }) => x) },
      chart: { ...d.chart, lines: d.chart.lines.map(({ id: _i, slot: _s, ...l }) => l) },
    });
    expect(withoutIds(local)).toEqual(withoutIds(server));
    expect(local.permille).toBeGreaterThan(0);

    const strip = (l: ReturnType<typeof core.logbook>) => ({ ...l, drinks: l.drinks.map(({ id: _i, ...x }) => x), next: l.next?.split(".")[0] ?? null });
    for (const q of ["", "?q=OLUT", "?limit=2", `?from=${now - 10 * HOUR_MS}&to=${now}`]) {
      const s = (await (await w.call("GET", `/api/drinks${q}`, { signedIn: true })).json()) as ReturnType<typeof core.logbook>;
      const params = new URLSearchParams(q.slice(1));
      const f = Object.fromEntries([...params].map(([k, v]) => [k, k === "q" ? v : Number(v)]));
      expect({ q, log: strip(core.logbook(data, f)) }).toEqual({ q, log: strip(s) });
    }

    const from = now - 74 * HOUR_MS;
    const to = now - 73 * HOUR_MS;
    const s = (await (await w.call("GET", `/api/drinks/chart?from=${from}&to=${to}`, { signedIn: true })).json()) as ReturnType<typeof core.sessionChart>;
    const l = core.sessionChart(data, from, to, now);
    expect(l.lines.map(({ id: _i, slot: _s, ...x }) => x)).toEqual(s.lines.map(({ id: _i, slot: _s, ...x }) => x));
  });

  test("logging, undo, favourites and the checks", async () => {
    const t = Date.parse("2026-11-06T20:00:00Z");
    const data = core.newLocalData({ name: "kalle", weight: 80, height: 180, gender: "mies" }, t);
    const noServing = async () => {
      throw new Error("not asked");
    };
    const beer = await core.logDrink(data, { kind: "preset", id: "b33a" }, t, noServing);
    expect(beer.description).toBe(findPreset("b33a")!.name);
    const same = await core.logDrink(data, { kind: "repeat" }, t, noServing);
    expect(same.createdAt).toBe(t + 1); // the same drink in the same millisecond is nudged, as on the server
    await expect(core.logDrink(data, { kind: "custom", cl: 0, percent: 5 }, t, noServing)).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(core.logDrink(data, { kind: "preset", id: "b33a", at: t - 8 * 24 * HOUR_MS }, t, noServing)).rejects.toMatchObject({ code: "invalid_time" });
    const product = await core.logDrink(data, { kind: "product", productId: "123", serving: "x" }, t, async () => ({ description: "Tuote 0,33 l", alcoholMg: 13000, kcal: 140, productId: "123" }));
    expect(product).toMatchObject({ description: "Tuote 0,33 l", productId: "123", kcal: 140 });
    expect(core.pinFavorite(data, beer.id, t).result).toBe("added");
    expect(core.pinFavorite(data, same.id, t).result).toBe("exists");
    const fav = data.favorites[0]!;
    expect((await core.logDrink(data, { kind: "favorite", id: fav.id }, t, noServing)).description).toBe(beer.description);
    expect(core.undo(data).description).toBe(beer.description);
    expect(data.drinks).toHaveLength(3);
    expect(() => core.checkProfile({ name: "@x", weight: 80, height: 180, gender: "mies" })).toThrow();
    expect(() => core.updateProfile(data, { weight: 5 })).toThrow();
    expect(core.updateProfile(data, { name: " Kalle  K " }).name).toBe("Kalle K");
    expect(core.isLocalData(JSON.parse(JSON.stringify(data)))).toBe(true);
    expect(core.isLocalData({ version: 2 })).toBe(false);
  });
});

describe("catalogue for visitors", () => {
  test("only with LOCAL_ACCOUNTS; a serving resolves to what logging it stores", async () => {
    const off = await world(false);
    expect((await off.call("GET", "/api/products?q=a")).status).toBe(401);
    expect(((await (await off.call("GET", "/api/config")).json()) as { localAccounts: boolean }).localAccounts).toBe(false);

    const w = await world(true);
    expect(((await (await w.call("GET", "/api/config")).json()) as { localAccounts: boolean }).localAccounts).toBe(true);
    const found = (await (await w.call("GET", "/api/products?q=a")).json()) as { products: { id: string; servings: { key: string }[] }[] };
    expect(found.products.length).toBeGreaterThan(0);
    const p = found.products[0]!;
    const res = await w.call("GET", `/api/products/${p.id}/servings/${p.servings[0]!.key}`);
    const serving = (await res.json()) as { description: string; alcoholMg: number };
    expect(res.status).toBe(200);
    // The same as logging it on the server.
    const logged = (await (await w.call("POST", "/api/drinks", { signedIn: true, body: { kind: "product", productId: p.id, serving: p.servings[0]!.key } })).json()) as { description: string; alcoholMg: number };
    expect(serving).toMatchObject({ description: logged.description, alcoholMg: logged.alcoholMg });
    expect((await w.call("GET", `/api/products/${p.id}/servings/nope`)).status).toBe(404);
    // Visitors are limited per address.
    let last = 0;
    for (let i = 0; i < 130; i++) last = (await w.call("GET", "/api/products?q=a", { ip: "9.9.9.9" })).status;
    expect(last).toBe(429);
  });

  test("the privacy text describes local use only when it's on", () => {
    const base = testConfig();
    const web = { ...base, web: { ...base.web, enabled: true } };
    expect(docsHtml({ ...web, auth: { passkeys: false, local: true } }).privacy).toContain("ilman tunnusta");
    expect(docsHtml({ ...web, auth: { passkeys: false, local: false } }).privacy).not.toContain("ilman tunnusta");
  });
});

describe("moving a local account online", () => {
  test("drinks and favourites join the account; again adds nothing; bad rows are skipped", async () => {
    const w = await world();
    const t = w.clock.now;
    const drinks = [
      { alcoholMg: 13000, description: "Olut", createdAt: t - HOUR_MS, productId: null, kcal: 140 },
      { alcoholMg: 12000, description: "Lonkero", createdAt: t - 30 * MINUTE_MS, productId: "123456", kcal: null },
      { alcoholMg: 0, description: "nolla", createdAt: t, productId: null, kcal: null },
      { alcoholMg: 13000, description: "tulevaisuus", createdAt: t + HOUR_MS, productId: null, kcal: null },
      { alcoholMg: 13000, description: "x", createdAt: t, productId: "../etc", kcal: null },
    ];
    const body = { drinks, favorites: [{ alcoholMg: 13000, description: "Olut", productId: null, kcal: 140 }] };
    const first = await (await w.call("POST", "/api/account/local-import", { signedIn: true, body })).json();
    expect(first).toEqual({ inserted: 2, duplicates: 0, invalid: 3, favorites: 1 });
    const again = await (await w.call("POST", "/api/account/local-import", { signedIn: true, body })).json();
    expect(again).toEqual({ inserted: 0, duplicates: 2, invalid: 3, favorites: 0 });
    expect(w.services.drinks.since(w.alice.id, 0).map((d) => d.description)).toEqual(["Olut", "Lonkero"]);

    expect((await w.call("POST", "/api/account/local-import", { body })).status).toBe(401);
    expect((await w.call("POST", "/api/account/local-import", { signedIn: true, body: { drinks: Array(501).fill(drinks[0]) } })).status).toBe(400);
  });
});
