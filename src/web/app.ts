// The website's JSON API, as routes for Bun.serve (see server.ts).
//
// The routes are in api/, one module per area, each a table of path → method → handler. A handler
// is wrapped in the guards it needs (api/guards.ts, which also describes the security model):
//
//   "/api/drinks/undo": { POST: user((c) => …) }

import type { BunRequest, Server } from "bun";
import { RateLimiter } from "../bot/ratelimit.ts";
import type { WebSession } from "../services/websessions.ts";
import { accountRoutes } from "./api/account.ts";
import { adminRoutes } from "./api/admin.ts";
import { authRoutes } from "./api/auth.ts";
import { barcodeRoutes } from "./api/barcodes.ts";
import { Ctx, type Api, type Handler, type Routes, type WebAppOptions } from "./api/context.ts";
import { docsRoutes } from "./api/docs.ts";
import { drinkRoutes } from "./api/drinks.ts";
import { favoriteRoutes } from "./api/favorites.ts";
import { groupRoutes } from "./api/groups.ts";
import { sameOrigin } from "./api/guards.ts";
import { createLive } from "./api/live.ts";
import { createOg } from "./api/og.ts";
import { loginRoutes } from "./api/logins.ts";
import { passkeyRoutes } from "./api/passkeys.ts";
import { FlowStore } from "./authflows.ts";
import { OidcClient, type OidcPlatform } from "./oidc.ts";
import type { LoginProvider } from "../../shared/api.ts";
import { MINUTE_MS } from "../lib/units.ts";
import { meRoutes } from "./api/me.ts";
import { productRoutes } from "./api/products.ts";
import { screenRoutes } from "./api/screens.ts";
import { createViews } from "./api/views.ts";
import { cookieJar, fail } from "./http.ts";
import { GroupAdmins } from "./groupadmins.ts";
import { GroupPhotos, ProductPhotos } from "./photos.ts";
import { withSecurityHeaders } from "./static.ts";

export type { WebAppOptions } from "./api/context.ts";

const MODULES = [authRoutes, loginRoutes, passkeyRoutes, meRoutes, accountRoutes, docsRoutes, favoriteRoutes, drinkRoutes, productRoutes, barcodeRoutes, groupRoutes, screenRoutes, adminRoutes];

type BunHandler = (req: BunRequest, server: Server<unknown>) => Promise<Response>;

export function createWebApp(opts: WebAppOptions) {
  const { services } = opts;
  const now = () => services.deps.now();
  const groupAdmins = opts.groupAdmins ?? new GroupAdmins(services, { botToken: opts.botToken });
  const views = createViews(services, now, (groupId, accountId) => groupAdmins.wasAdmin(groupId, accountId));
  const auth = opts.auth ?? { passkeys: false, local: false };
  const oidc: Partial<Record<OidcPlatform, OidcClient>> = {};
  for (const platform of ["google", "microsoft"] as const) {
    const client = auth[platform];
    if (client) oidc[platform] = new OidcClient(platform, client, `${opts.origin}/api/auth/${platform}/callback`, now, opts.oidcFetch);
  }
  const providers: LoginProvider[] = ["telegram", ...(Object.keys(oidc) as OidcPlatform[]), ...(auth.passkeys ? (["passkey"] as const) : [])];
  const adminIdentities = new Set((opts.adminIds ?? []).map((id) => services.identities.key({ platform: "telegram", platformUserId: id })));
  const api: Api = {
    services,
    opts,
    now,
    cookies: cookieJar(opts.origin.startsWith("https:"), now),
    views,
    live: createLive(services, views, opts.live),
    photos: opts.photos ?? new ProductPhotos(),
    groupPhotos: opts.groupPhotos ?? new GroupPhotos({ botToken: opts.botToken }),
    groupAdmins,
    auth: {
      providers,
      oidc,
      local: auth.local,
      rpId: new URL(opts.origin).hostname,
      flows: {
        oauth: new FlowStore(10 * MINUTE_MS, now),
        passkey: new FlowStore(5 * MINUTE_MS, now),
        signup: new FlowStore(30 * MINUTE_MS, now),
      },
    },
    isAdmin: (s: WebSession) =>
      s.identityId !== null && adminIdentities.has(s.identityId) && services.identities.accountOf(s.identityId) === s.accountId,
    limits: {
      signIn: new RateLimiter(10, 60_000, now),
      signUp: new RateLimiter(5, 60 * 60_000, now),
      api: new RateLimiter(120, 60_000, now),
      photo: new RateLimiter(600, 60_000, now),
      barcode: new RateLimiter(30, 60_000, now),
    },
  };

  // Every request: same-origin check for writes, then the route's own guards; security headers on the way out.
  const toBun =
    (h: Handler): BunHandler =>
    async (req, server) =>
      withSecurityHeaders(await sameOrigin(h)(new Ctx(api, req, server)));

  const routes: Record<string, BunHandler | Partial<Record<string, BunHandler>>> = {};
  for (const module of MODULES) {
    for (const [path, methods] of Object.entries(module(api) satisfies Routes)) {
      if (path in routes) throw new Error(`Route ${path} is defined twice`);
      routes[path] = Object.fromEntries(Object.entries(methods).map(([method, h]) => [method, toBun(h)]));
    }
  }
  const og = createOg(api);
  for (const [path, methods] of Object.entries(og.routes)) {
    routes[path] = Object.fromEntries(Object.entries(methods).map(([method, h]) => [method, toBun(h)]));
  }
  // Unknown paths and methods (Bun falls through to here when a route lacks the method).
  routes["/api/*"] = async () => withSecurityHeaders(fail(404, "not_found"));

  return { routes, meta: og.meta, close: () => api.live.close(), viewers: () => api.live.viewers() };
}

export type WebApp = ReturnType<typeof createWebApp>;
