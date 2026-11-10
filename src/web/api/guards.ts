// Guards wrap a handler with a check, so what a route needs is written where the route is:
//
//   "/api/drinks": { GET: user(c => …) }
//
// Security model:
//   - A session is an opaque random token in an HttpOnly cookie (services/websessions.ts).
//   - Every state-changing request must come from our own origin (Origin header) and carry a
//     custom header, which a cross-site form can't send. Login is covered too (login CSRF).
//     app.ts applies this to every route.
//   - Rate limits: per client address for sign-in, per account for everything else.
//   - Nothing here takes an account id from the request: the account is always the session's.
//   - Admin: see Api.isAdmin.

import type { ScreenAccess } from "../../services/screens.ts";
import { fail } from "../http.ts";
import type { Api, Ctx, Handler } from "./context.ts";

export type Guard = (h: Handler) => Handler;
type Limit = keyof Api["limits"];

const CSRF_HEADER = "x-kili";

export const sameOrigin: Guard = (h) => (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return h(c);
  const headers = c.req.headers;
  return headers.get("origin") === c.api.opts.origin && headers.get(CSRF_HEADER) === "1" ? h(c) : fail(403, "forbidden");
};

/** Per client address; `prefix` keeps separate budgets in one limiter. */
export const limitByIp =
  (limit: Limit, prefix = ""): Guard =>
  (h) =>
  (c) =>
    c.api.limits[limit].hit(prefix + c.ip) === "ok" ? h(c) : fail(429, "rate_limited");

/** Per account; inside signedIn. */
export const limitByAccount =
  (limit: Limit): Guard =>
  (h) =>
  (c) =>
    c.api.limits[limit].hit(c.session.accountId) === "ok" ? h(c) : fail(429, "rate_limited");

/** A valid session, without the general rate limit (product photos have their own). */
export const signedIn: Guard = (h) => (c) => {
  const token = c.req.cookies.get(c.api.cookies.session);
  const session = token ? c.api.services.webSessions.authenticate(token) : null;
  if (!session) return fail(401, "unauthorized");
  c.session = session;
  c.sessionToken = token;
  return h(c);
};

/** A session and its account, under the general rate limit. Most routes use this. */
export const user: Guard = (h) =>
  signedIn(
    limitByAccount("api")((c) => {
      const p = c.api.services.accounts.get(c.session.accountId);
      if (!p) return fail(401, "unauthorized");
      c.user = p;
      c.admin = c.api.isAdmin(c.session);
      return h(c);
    }),
  );

/** Not an admin: the same answer as for a path that doesn't exist. */
export const admin: Guard = (h) => user((c) => (c.admin ? h(c) : fail(404, "not_found")));

/** Event screens are authorised by the link's token, kept in a cookie after /api/screen/open. */
export const screen = (h: (c: Ctx, access: ScreenAccess) => Response | Promise<Response>): Handler =>
  limitByIp(
    "api",
    "screen:",
  )((c) => {
    const token = c.req.cookies.get(c.api.cookies.screen);
    const access = token ? c.api.services.screens.authenticate(token) : null;
    return access ? h(c, access) : fail(401, "unauthorized");
  });
