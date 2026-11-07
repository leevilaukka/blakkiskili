// The website's JSON API. A pure Request → Response handler over the services, so it is tested
// without a socket and does not know about Bun.serve (see server.ts).
//
// Security model:
//   - A session is an opaque random token in an HttpOnly cookie (services/websessions.ts).
//   - Every state-changing request must come from our own origin (Origin header) and carry a
//     custom header, which a cross-site form can't send. Login is covered too (login CSRF).
//   - Rate limits: per client address for sign-in, per account for everything else.
//   - Nothing here takes an account id from the request: the account is always the session's.

import { calculateEbac } from "../lib/alcomath.ts";
import { findPreset, CATALOG } from "../lib/catalog.ts";
import { buildChartData } from "../lib/chart.ts";
import { chartLabel, isGender, isValidHeight, isValidWeight, type Profile } from "../services/accounts.ts";
import {
  emojiFor,
  resolveServing,
  servingDescription,
  type CatalogDrink,
} from "../lib/servings.ts";
import { alcoholMgFromClPercent, HOUR_MS, isAlcoholAmountOutOfLimits, toStandardDrinks } from "../lib/units.ts";
import { RateLimiter } from "../bot/ratelimit.ts";
import { EBAC_WINDOW_MS, type Drink } from "../services/drinks.ts";
import type { Services } from "../services/index.ts";
import type { Config as ApiConfig, Dashboard, DrinkItem, LogDrinkRequest, Me, ProductItem } from "../../shared/api.ts";
import { Hub } from "./sse.ts";
import { verifyTelegramLogin } from "./telegram.ts";

export interface WebAppOptions {
  services: Services;
  botToken: string;
  botUsername: string;
  /** Public origin, e.g. "https://kili.example.com" (no trailing slash). */
  origin: string;
  /** Live-update timing; tests shorten it. */
  live?: { tickMs?: number; minGapMs?: number; maxTotal?: number; maxPerOwner?: number };
}

const MAX_BODY = 4 * 1024;
const CSRF_HEADER = "x-kili";

export function createWebApp(opts: WebAppOptions) {
  const { services, origin } = opts;
  const secure = origin.startsWith("https:");
  const cookieName = secure ? "__Host-kili" : "kili"; // __Host- needs Secure, so not on http://localhost
  const now = () => services.deps.now();
  const signInLimiter = new RateLimiter(10, 60_000, now);
  const apiLimiter = new RateLimiter(120, 60_000, now);

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    });
  const fail = (status: number, error: string) => json({ error }, status);

  const sessionCookie = (token: string, expiresAt: number) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - now()) / 1000)}${secure ? "; Secure" : ""}`;
  const clearCookie = () => `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

  function readCookie(req: Request): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim() || null;
    }
    return null;
  }

  async function body(req: Request): Promise<Record<string, unknown> | null> {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return null;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return null;
      const parsed = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // ---------- views ----------

  const toMe = (p: Profile): Me => ({
    name: p.name,
    chartName: p.chartName,
    chartLabel: chartLabel(p),
    weight: p.weight,
    height: p.height,
    gender: p.gender,
  });

  const toItem = (d: Drink): DrinkItem => ({
    id: d.id,
    description: d.description,
    alcoholMg: d.alcoholMg,
    standardDrinks: toStandardDrinks(d.alcoholMg / 1000),
    kcal: d.kcal,
    createdAt: d.createdAt,
  });

  const toProduct = (d: CatalogDrink): ProductItem => ({
    id: d.id,
    name: d.name,
    maker: d.product.maker,
    abv: d.product.abv,
    type: d.product.type,
    emoji: emojiFor(d.product),
    servings: d.servings.map((s) => ({
      key: s.key,
      label: s.label,
      standardDrinks: s.standardDrinks,
      kcal: s.kcal,
      priceEur: s.priceEur,
    })),
  });

  function dashboard(p: Profile): Dashboard {
    const t = now();
    const recent = services.drinks.since(p.id, t - EBAC_WINDOW_MS);
    const ebac = calculateEbac(p, recent, t);
    const session = services.drinks.session(p.id, t);
    return {
      now: t,
      me: toMe(p),
      permille: ebac.permilles,
      soberAt: ebac.burnHours > 0 ? t + ebac.burnHours * HOUR_MS : null,
      session: {
        drinks: session.map(toItem),
        standardDrinks: toStandardDrinks(session.reduce((sum, d) => sum + d.alcoholMg, 0) / 1000),
        kcal: session.reduce((sum, d) => sum + (d.kcal ?? 0), 0),
        unknownKcal: session.filter((d) => d.kcal === null).length,
      },
      chart: buildChartData([{ id: p.id, name: chartLabel(p), body: p, drinks: recent }], t),
    };
  }

  // ---------- handlers ----------

  function signedIn(accountId: string, identityId: string | null) {
    const { sessionToken, expiresAt } = services.webSessions.createSession(accountId, identityId);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(sessionToken, expiresAt) });
  }

  async function telegramSignIn(req: Request) {
    const data = await body(req);
    if (!data) return fail(400, "bad_request");
    const check = verifyTelegramLogin(data, opts.botToken, now());
    if (!check.ok) return fail(check.reason === "expired" ? 401 : 400, check.reason);
    const identityId = services.identities.key({ platform: "telegram", platformUserId: check.telegramId });
    const accountId = services.identities.accountOf(identityId);
    if (!accountId) return fail(404, "not_registered");
    return signedIn(accountId, identityId);
  }

  async function linkSignIn(req: Request) {
    const data = await body(req);
    if (!data || typeof data.token !== "string" || data.token.length > 200) return fail(400, "bad_request");
    const redeemed = services.webSessions.redeemLoginLink(data.token);
    if (!redeemed) return fail(401, "invalid_link");
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(redeemed.sessionToken, redeemed.expiresAt) });
  }

  async function logDrink(p: Profile, req: Request) {
    const data = await body(req);
    if (!data) return fail(400, "bad_request");
    const r = data as unknown as LogDrinkRequest;
    switch (r.kind) {
      case "preset": {
        const preset = typeof r.id === "string" ? findPreset(r.id) : undefined;
        if (!preset) return fail(404, "unknown_preset");
        return json(toItem(services.drinks.add(p.id, preset.mg, preset.name, { kcal: preset.kcal })), 201);
      }
      case "product": {
        const drink = typeof r.productId === "string" ? services.products.get(r.productId) : undefined;
        const serving = drink && typeof r.serving === "string" ? resolveServing(drink, r.serving) : undefined;
        if (!drink || !serving) return fail(404, "unknown_product");
        const added = services.drinks.add(p.id, serving.mg, servingDescription(drink, serving), {
          productId: serving.productId,
          kcal: serving.kcal,
        });
        return json(toItem(added), 201);
      }
      case "custom": {
        const { cl, percent } = r;
        if (typeof cl !== "number" || typeof percent !== "number") return fail(400, "bad_request");
        if (!Number.isFinite(cl) || cl <= 0 || cl > 250 || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
          return fail(422, "invalid_amount");
        }
        const mg = alcoholMgFromClPercent(cl, percent);
        if (isAlcoholAmountOutOfLimits(mg)) return fail(422, "too_much");
        return json(toItem(services.drinks.add(p.id, mg, `Oma juoma - ${cl}cl ${percent}%`)), 201);
      }
      case "repeat": {
        const last = services.drinks.last(p.id);
        if (!last) return fail(404, "nothing_to_repeat");
        const added = services.drinks.add(p.id, last.alcoholMg, last.description, { productId: last.productId, kcal: last.kcal });
        return json(toItem(added), 201);
      }
      default:
        return fail(400, "bad_request");
    }
  }

  async function patchMe(p: Profile, req: Request) {
    const data = await body(req);
    if (!data) return fail(400, "bad_request");
    const { chartName, weight, height, gender } = data;
    // Validate everything first so a bad field doesn't leave a half-applied update.
    if (chartName !== undefined && chartName !== "full" && chartName !== "username") return fail(422, "invalid_chart_name");
    if (weight !== undefined && !(typeof weight === "number" && isValidWeight(weight))) return fail(422, "invalid_weight");
    if (height !== undefined && !(typeof height === "number" && isValidHeight(height))) return fail(422, "invalid_height");
    if (gender !== undefined && !(typeof gender === "string" && isGender(gender))) return fail(422, "invalid_gender");
    services.deps.db.transaction(() => {
      if (chartName !== undefined) services.accounts.updateChartName(p.id, chartName as "full" | "username");
      if (weight !== undefined) services.accounts.updateWeight(p.id, weight as number);
      if (height !== undefined) services.accounts.updateHeight(p.id, height as number);
      if (gender !== undefined) services.accounts.updateGender(p.id, gender as "mies" | "nainen");
    })();
    return json(toMe(services.accounts.get(p.id)!));
  }

  function search(p: Profile, url: URL) {
    if (!services.products.ready) return json({ products: [] });
    const q = (url.searchParams.get("q") ?? "").slice(0, 80).trim();
    const recent = services.drinks.recentProductIds(p.id, 20);
    const found = q ? services.products.search(q, 8, recent) : services.products.drinksFor(recent, 8);
    return json({ products: found.map(toProduct) });
  }

  const config = (): ApiConfig => ({
    botUsername: opts.botUsername,
    catalogue: services.products.ready,
    presets: CATALOG.flatMap((c) =>
      c.presets.map((pr) => ({
        id: pr.id,
        name: pr.name,
        standardDrinks: toStandardDrinks(pr.mg / 1000),
        kcal: pr.kcal,
        category: c.id as "miedot" | "viinit" | "shotit",
      })),
    ),
  });

  // ---------- live updates ----------

  const hub = new Hub({
    bus: services.bus,
    ...opts.live,
    channelsFor: (change) => (change.accountId ? [`u:${change.accountId}`] : []),
    render(channel) {
      const p = channel.startsWith("u:") ? services.accounts.get(channel.slice(2)) : null;
      return p ? dashboard(p) : null;
    },
  });

  function events(p: Profile): Response {
    if (!hub.hasRoom(p.id)) return fail(429, "too_many_streams");
    const encoder = new TextEncoder();
    let stop: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        stop = hub.subscribe(`u:${p.id}`, p.id, (text) => controller.enqueue(encoder.encode(text)));
      },
      cancel() {
        stop?.();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  // ---------- routing ----------

  async function handle(req: Request, clientIp: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const mutating = method !== "GET" && method !== "HEAD";

    // Same-origin only for anything that changes state.
    if (mutating) {
      if (req.headers.get("origin") !== origin || req.headers.get(CSRF_HEADER) !== "1") return fail(403, "forbidden");
    }

    if (path === "/api/config" && method === "GET") return json(config());

    if (path === "/api/auth/telegram" && method === "POST") {
      if (signInLimiter.hit(clientIp) !== "ok") return fail(429, "rate_limited");
      return telegramSignIn(req);
    }
    if (path === "/api/auth/link" && method === "POST") {
      if (signInLimiter.hit(clientIp) !== "ok") return fail(429, "rate_limited");
      return linkSignIn(req);
    }

    // Everything below needs a session.
    const cookie = readCookie(req);
    const session = cookie ? services.webSessions.authenticate(cookie) : null;
    if (!session) return fail(401, "unauthorized");
    if (apiLimiter.hit(session.accountId) !== "ok") return fail(429, "rate_limited");
    const p = services.accounts.get(session.accountId);
    if (!p) return fail(401, "unauthorized");

    if (path === "/api/auth/logout" && method === "POST") {
      services.webSessions.revoke(cookie!);
      return json({ ok: true }, 200, { "set-cookie": clearCookie() });
    }
    if (path === "/api/me") {
      if (method === "GET") return json(toMe(p));
      if (method === "PATCH") return patchMe(p, req);
    }
    if (path === "/api/dashboard" && method === "GET") return json(dashboard(p));
    if (path === "/api/events" && method === "GET") return events(p);
    if (path === "/api/products" && method === "GET") return search(p, url);
    if (path === "/api/drinks" && method === "POST") return logDrink(p, req);
    if (path === "/api/drinks/undo" && method === "POST") {
      const undone = services.drinks.undoLast(p.id);
      return undone ? json(toItem(undone)) : fail(404, "nothing_to_undo");
    }
    const one = /^\/api\/drinks\/(\d{1,15})$/.exec(path);
    if (one && method === "DELETE") {
      return services.drinks.delete(p.id, Number(one[1])) ? json({ ok: true }) : fail(404, "not_found");
    }
    return fail(404, "not_found");
  }

  return Object.assign(handle, { close: () => hub.close(), viewers: () => hub.viewers });
}

export type WebApp = ReturnType<typeof createWebApp>;
