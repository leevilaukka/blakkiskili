// The website's JSON API, as routes for Bun.serve (see server.ts).
//
// The routes are in api/, one module per area, each a table of path → method → handler. A handler
// is wrapped in the guards it needs (api/guards.ts, which also describes the security model):
//
//   "/api/drinks/undo": { POST: user((c) => …) }

import type { BunRequest, Server } from "bun";
import { RateLimiter } from "../bot/ratelimit.ts";
import type { WebSession } from "../services/websessions.ts";
import { adminRoutes } from "./api/admin.ts";
import { authRoutes } from "./api/auth.ts";
import { barcodeRoutes } from "./api/barcodes.ts";
import { Ctx, type Api, type Handler, type Routes, type WebAppOptions } from "./api/context.ts";
import { drinkRoutes } from "./api/drinks.ts";
import { groupRoutes } from "./api/groups.ts";
import { sameOrigin } from "./api/guards.ts";
import { createLive } from "./api/live.ts";
import { meRoutes } from "./api/me.ts";
import { productRoutes } from "./api/products.ts";
import { screenRoutes } from "./api/screens.ts";
import { createViews } from "./api/views.ts";
import { cookieJar, fail } from "./http.ts";
import { GroupPhotos, ProductPhotos } from "./photos.ts";
import { withSecurityHeaders } from "./static.ts";

export type { WebAppOptions } from "./api/context.ts";

const MODULES = [authRoutes, meRoutes, drinkRoutes, productRoutes, barcodeRoutes, groupRoutes, screenRoutes, adminRoutes];

type BunHandler = (req: BunRequest, server: Server<unknown>) => Promise<Response>;

export function createWebApp(opts: WebAppOptions) {
  const { services } = opts;
  const now = () => services.deps.now();
  const views = createViews(services, now);
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
    isAdmin: (s: WebSession) =>
      s.identityId !== null && adminIdentities.has(s.identityId) && services.identities.accountOf(s.identityId) === s.accountId,
    limits: {
      signIn: new RateLimiter(10, 60_000, now),
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
  // Unknown paths and methods (Bun falls through to here when a route lacks the method).
  routes["/api/*"] = async () => withSecurityHeaders(fail(404, "not_found"));

  return { routes, close: () => api.live.close(), viewers: () => api.live.viewers() };
}

export type WebApp = ReturnType<typeof createWebApp>;
