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
import { cleanGroupName, type GroupInfo, type Member } from "../services/groups.ts";
import { SCREEN_DEFAULT_TTL_MS, type ScreenAccess } from "../services/screens.ts";
import type {
  Config as ApiConfig,
  Dashboard,
  DrinkItem,
  GroupSummary,
  GroupView,
  LogDrinkRequest,
  Me,
  ProductItem,
  ScreenLinkItem,
  ScreenView,
} from "../../shared/api.ts";
import { buildBoard, memberRef, type Board } from "./boards.ts";
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
  const screenCookieName = secure ? "__Host-kili-screen" : "kili-screen";
  const screenCookie = (token: string, expiresAt: number) =>
    `${screenCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expiresAt - now()) / 1000))}${secure ? "; Secure" : ""}`;
  const clearCookie = () => `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

  function readCookie(req: Request, name = cookieName): string | null {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
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

  // ---------- groups and screens: views ----------

  // The same board is shown to everyone watching a group, so it is built once for a moment and
  // shared; any change announced on the bus drops it.
  const boards = new Map<string, { at: number; board: Board }>();
  services.bus.subscribe(() => boards.clear());
  function board(key: string, groupId: string, members: () => Member[], anonymize: boolean): Board {
    const t = now();
    const hit = boards.get(key);
    if (hit && Math.abs(t - hit.at) < 2000) return hit.board;
    const built = buildBoard(services, groupId, members(), t, { anonymize });
    boards.set(key, { at: t, board: built });
    return built;
  }

  const summary = (info: GroupInfo, p: Profile, hideOnScreen: boolean): GroupSummary => ({
    id: info.id,
    name: info.name ?? "Telegram-ryhmä",
    kind: info.kind,
    memberCount: info.memberCount,
    isOwner: services.groups.ownerOf(info.id) === p.id,
    hideOnScreen,
  });

  const screenItems = (links: ReturnType<typeof services.screens.list>, p: Profile): ScreenLinkItem[] =>
    links.map((l) => ({ ref: l.ref, createdAt: l.createdAt, expiresAt: l.expiresAt, mine: l.createdBy === p.id }));

  function groupView(p: Profile, groupId: string): GroupView | null {
    const info = services.groups.get(groupId);
    const mine = services.groups.listFor(p.id).find((g) => g.id === groupId);
    if (!info || !mine) return null;
    const b = board(`g:${groupId}`, groupId, () => services.groups.members(groupId), false);
    const me = memberRef(services, groupId, p.id);
    const isOwner = services.groups.ownerOf(groupId) === p.id;
    return {
      now: now(),
      group: summary(info, p, mine.hideOnScreen),
      chart: b.chart,
      members: b.rows.map((r) => ({ ...r, isMe: r.ref === me })),
      inviteExpiresAt: isOwner ? services.groups.hasInvite(groupId) : null,
      screens: screenItems(services.screens.list({ groupId }), p),
    };
  }

  /** The account as a one-person group, for the personal screen. */
  function personAsMember(p: Profile): Member {
    return { userId: p.id, name: p.name, fullName: p.fullName, chartName: p.chartName, body: p, drinks: services.drinks.since(p.id, now() - EBAC_WINDOW_MS), joinedAt: 0, hideOnScreen: false };
  }

  function screenView(access: ScreenAccess): ScreenView | null {
    if (access.groupId) {
      const info = services.groups.get(access.groupId);
      if (!info) return null;
      const b = board(`s:${access.groupId}`, access.groupId, () => services.groups.members(access.groupId!), true);
      return {
        now: now(),
        title: info.name ?? "Ryhmä",
        kind: "group",
        chart: b.chart,
        members: b.rows.map(({ name, permille, standardDrinks12h }) => ({ name, permille, standardDrinks12h })),
        expiresAt: access.expiresAt,
      };
    }
    const p = access.accountId ? services.accounts.get(access.accountId) : null;
    if (!p) return null;
    const b = board(`p:${p.id}`, p.id, () => [personAsMember(p)], false);
    return { now: now(), title: chartLabel(p), kind: "person", chart: b.chart, members: [], expiresAt: access.expiresAt };
  }

  // ---------- live updates ----------

  // Channels: "u:<account>" a person's dashboard, "g:<group>:<account>" a group page as one of its
  // members sees it, "s:<token hash>" an event screen.
  const hub = new Hub({
    bus: services.bus,
    ...opts.live,
    channelsFor(change, watched) {
      const groupIds = new Set<string>(change.groupId ? [change.groupId] : []);
      if (change.accountId && watched.some((w) => !w.startsWith("u:"))) for (const g of services.groups.groupIdsOf(change.accountId)) groupIds.add(g);
      const out: string[] = [];
      for (const w of watched) {
        if (w.startsWith("u:")) {
          if (w === `u:${change.accountId}`) out.push(w);
        } else if (w.startsWith("g:")) {
          const [, groupId, accountId] = w.split(":");
          if (groupIds.has(groupId!) || accountId === change.accountId) out.push(w);
        } else if (w.startsWith("s:")) {
          if (w === `s:${change.screenHash}`) {
            out.push(w);
            continue;
          }
          const access = services.screens.byHash(w.slice(2));
          if (access && ((access.groupId && groupIds.has(access.groupId)) || (access.accountId && access.accountId === change.accountId))) out.push(w);
        }
      }
      return out;
    },
    render(channel) {
      if (channel.startsWith("u:")) {
        const p = services.accounts.get(channel.slice(2));
        return p ? dashboard(p) : null;
      }
      if (channel.startsWith("g:")) {
        const [, groupId, accountId] = channel.split(":");
        const p = accountId ? services.accounts.get(accountId) : null;
        return p && groupId ? groupView(p, groupId) : null;
      }
      if (channel.startsWith("s:")) {
        const access = services.screens.byHash(channel.slice(2));
        return access ? screenView(access) : null;
      }
      return null;
    },
  });

  function stream(channel: string, owner: string): Response {
    if (!hub.hasRoom(owner)) return fail(429, "too_many_streams");
    const encoder = new TextEncoder();
    let stop: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stop = hub.subscribe(channel, owner, (text) => controller.enqueue(encoder.encode(text)));
      },
      cancel() {
        stop?.();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  // ---------- groups and screens: handlers ----------

  const GROUP_PATH = /^\/api\/groups\/([0-9a-f]{32,64})(?:\/([a-z]+)(?:\/([0-9a-f]{1,64}))?)?$/;
  const lifetime = (hours: unknown) => (typeof hours === "number" && Number.isFinite(hours) ? hours * HOUR_MS : SCREEN_DEFAULT_TTL_MS);

  async function createGroup(p: Profile, req: Request) {
    const data = await body(req);
    const name = cleanGroupName(data?.name);
    if (!name) return fail(422, "invalid_name");
    const made = services.groups.createWeb(p.id, name);
    if (made === "limit") return fail(409, "too_many_groups");
    return json(summary(made, p, false), 201);
  }

  async function joinGroup(p: Profile, req: Request) {
    const data = await body(req);
    if (!data || typeof data.code !== "string" || data.code.length > 100) return fail(400, "bad_request");
    const r = services.groups.redeemInvite(data.code, p.id);
    if (r.ok) return json({ id: r.groupId });
    if (r.reason === "invalid") return fail(404, "invalid_invite");
    return fail(409, r.reason === "full" ? "group_full" : "already_member");
  }

  async function groupAction(p: Profile, req: Request, groupId: string, action: string | undefined, sub: string | undefined) {
    const method = req.method;
    const info = services.groups.get(groupId);
    // Non-members get the same answer as for a group that doesn't exist.
    if (!info || !services.groups.isMemberOf(p.id, groupId)) return fail(404, "not_found");
    const owner = services.groups.ownerOf(groupId) === p.id;
    const needOwner = () => (owner ? null : fail(403, "not_owner"));

    if (!action) {
      if (method === "GET") return json(groupView(p, groupId));
      if (method === "PATCH") {
        const denied = needOwner();
        if (denied) return denied;
        const data = await body(req);
        if (!cleanGroupName(data?.name)) return fail(422, "invalid_name");
        services.groups.rename(groupId, data!.name as string);
        return json(groupView(p, groupId));
      }
      if (method === "DELETE") {
        const denied = needOwner();
        if (denied) return denied;
        return services.groups.deleteWeb(groupId) ? json({ ok: true }) : fail(409, "telegram_group");
      }
    }
    if (action === "me" && method === "PATCH") {
      const data = await body(req);
      if (typeof data?.hideOnScreen !== "boolean") return fail(400, "bad_request");
      services.groups.setHidden(p.id, groupId, data.hideOnScreen);
      return json(groupView(p, groupId));
    }
    if (action === "leave" && method === "POST") {
      services.groups.leaveGroup(p.id, groupId);
      return json({ ok: true });
    }
    if (action === "members" && sub && method === "DELETE") {
      const denied = needOwner();
      if (denied) return denied;
      const target = services.groups.members(groupId).find((m) => memberRef(services, groupId, m.userId) === sub);
      if (!target) return fail(404, "not_found");
      if (target.userId === p.id) return fail(400, "use_leave");
      services.groups.leaveGroup(target.userId, groupId);
      return json({ ok: true });
    }
    if (action === "invite") {
      if (info.kind !== "web") return fail(409, "telegram_group"); // people join those by saying /moro in the chat
      const denied = needOwner();
      if (denied) return denied;
      if (method === "POST") return json(services.groups.createInvite(groupId, p.id));
      if (method === "DELETE") {
        services.groups.revokeInvite(groupId);
        return json({ ok: true });
      }
    }
    if (action === "screens") {
      if (method === "POST" && !sub) {
        const data = await body(req);
        const made = services.screens.create({ groupId }, p.id, lifetime(data?.hours));
        return made === "limit" ? fail(409, "too_many_screens") : json(made, 201);
      }
      if (method === "DELETE" && sub) {
        const link = services.screens.list({ groupId }).find((l) => l.ref === sub);
        if (!link) return fail(404, "not_found");
        if (!owner && link.createdBy !== p.id) return fail(403, "not_owner");
        services.screens.revoke({ groupId }, sub);
        return json({ ok: true });
      }
    }
    if (action === "events" && method === "GET") return stream(`g:${groupId}:${p.id}`, p.id);
    return fail(404, "not_found");
  }

  async function personalScreens(p: Profile, req: Request, ref: string | undefined) {
    if (req.method === "GET" && !ref) return json({ screens: screenItems(services.screens.list({ accountId: p.id }), p) });
    if (req.method === "POST" && !ref) {
      const data = await body(req);
      const made = services.screens.create({ accountId: p.id }, p.id, lifetime(data?.hours));
      return made === "limit" ? fail(409, "too_many_screens") : json(made, 201);
    }
    if (req.method === "DELETE" && ref) return services.screens.revoke({ accountId: p.id }, ref) ? json({ ok: true }) : fail(404, "not_found");
    return fail(404, "not_found");
  }

  /** Event screens: authorised by the link's token (kept in a cookie after /api/screen/open), not a session. */
  async function screenRoutes(req: Request, path: string, clientIp: string): Promise<Response | null> {
    if (path === "/api/screen/open" && req.method === "POST") {
      if (signInLimiter.hit(clientIp) !== "ok") return fail(429, "rate_limited");
      const data = await body(req);
      if (!data || typeof data.token !== "string" || data.token.length > 200) return fail(400, "bad_request");
      const access = services.screens.authenticate(data.token);
      if (!access) return fail(404, "invalid_screen");
      return json({ ok: true }, 200, { "set-cookie": screenCookie(data.token, access.expiresAt) });
    }
    if (path !== "/api/screen" && path !== "/api/screen/events") return null;
    if (req.method !== "GET") return fail(405, "method_not_allowed");
    if (apiLimiter.hit(`screen:${clientIp}`) !== "ok") return fail(429, "rate_limited");
    const token = readCookie(req, screenCookieName);
    const access = token ? services.screens.authenticate(token) : null;
    if (!access) return fail(401, "unauthorized");
    if (path === "/api/screen/events") return stream(`s:${access.hash}`, access.hash);
    return json(screenView(access));
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

    const screen = await screenRoutes(req, path, clientIp);
    if (screen) return screen;

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
    if (path === "/api/events" && method === "GET") return stream(`u:${p.id}`, p.id);
    if (path === "/api/groups" && method === "GET") return json({ groups: services.groups.listFor(p.id).map((g) => summary(g, p, g.hideOnScreen)) });
    if (path === "/api/groups" && method === "POST") return createGroup(p, req);
    if (path === "/api/groups/join" && method === "POST") return joinGroup(p, req);
    const screens = /^\/api\/screens(?:\/([0-9a-f]{16}))?$/.exec(path);
    if (screens) return personalScreens(p, req, screens[1]);
    const group = GROUP_PATH.exec(path);
    if (group) return groupAction(p, req, group[1]!, group[2], group[3]);
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
