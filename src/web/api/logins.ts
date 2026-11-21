// Sign-in methods besides Telegram, and the logins of an account.
//
//   Google / Microsoft (only when configured, see Config.auth; otherwise the routes don't exist):
//     POST /api/auth/<p>/start      → { url }: the provider's page; the browser goes there
//     POST /api/auth/<p>/link       → the same, to add the login to the signed-in account
//     GET  /api/auth/<p>/callback   ← the provider sends the browser back here; we redirect to
//                                     /login#signedin, /signup (a new person), /settings#linked=<p>,
//                                     or #error=<code> on the page it came from
//   Sign-up (a login that worked but has no account yet, or a new passkey):
//     GET  /api/auth/signup         → { method } while a sign-up is waiting
//     POST /api/auth/signup         ← SignupRequest
//   The account's logins (Settings):
//     GET    /api/auth/logins       → LoginsView
//     DELETE /api/auth/logins/:platform
//     POST   /api/auth/telegram/link  ← Telegram's sign-in data, to add Telegram to the account
//
// The OAuth state, nonce and PKCE verifier stay on the server (authflows.ts) under a random key in
// an HttpOnly cookie, so the callback only works in the browser that started it. Linking keeps the
// session that asked for it (its hash) and checks it is still signed in to that account when the
// provider sends the browser back. Accounts are never merged, and an email address never links
// anything: see Identities.link.

import { isGender, isValidHeight, isValidWeight, webName, type NewProfile } from "../../services/accounts.ts";
import { isPlatform, type Platform } from "../../lib/ids.ts";
import type { LoginPlatform, LoginsView } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { OidcPlatform } from "../oidc.ts";
import { verifyTelegramLogin } from "../telegram.ts";
import type { Api, Ctx, Handler, Routes } from "./context.ts";
import { limitByIp, user } from "./guards.ts";
import { finishPasskeySignup, PASSKEY_BODY_MAX } from "./passkeys.ts";

/** A 303 to a page of the site, setting and clearing cookies on the way. */
function redirect(path: string, cookies: string[] = []): Response {
  const headers = new Headers({ location: path, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** The body of a sign-up, checked; or the error code to answer with. */
export function readSignup(data: Record<string, unknown> | null): { profile: NewProfile } | { error: string } {
  if (!data) return { error: "bad_request" };
  if (data.acceptTerms !== true) return { error: "terms_not_accepted" };
  const name = webName(data.name);
  if (!name) return { error: "invalid_user_name" };
  const { weight, height, gender } = data;
  if (!(typeof weight === "number" && isValidWeight(weight))) return { error: "invalid_weight" };
  if (!(typeof height === "number" && isValidHeight(height))) return { error: "invalid_height" };
  if (!(typeof gender === "string" && isGender(gender))) return { error: "invalid_gender" };
  return { profile: { name, weight, height, gender } };
}

export function loginRoutes(api: Api): Routes {
  const { services, cookies, auth, now, opts } = api;
  const { flows } = auth;
  const signInLimit = limitByIp("signIn");
  const signUpLimit = limitByIp("signUp");
  const usable = (p: Platform) => (auth.providers as readonly string[]).includes(p);

  const sessionCookie = (accountId: string, identityId: string) => {
    const { sessionToken, expiresAt } = services.webSessions.createSession(accountId, identityId);
    return cookies.set(cookies.session, sessionToken, expiresAt);
  };
  const flowCookie = (name: string, key: string, ttlMs: number) => cookies.set(name, key, now() + ttlMs);

  // ---------- Google and Microsoft ----------

  const start =
    (platform: OidcPlatform, link: boolean): Handler =>
    (c) => {
      const client = auth.oidc[platform]!;
      const s = client.start();
      const key = flows.oauth.put({
        platform,
        state: s.state,
        nonce: s.nonce,
        verifier: s.verifier,
        link: link ? { accountId: c.session.accountId, sessionHash: services.webSessions.tokenHash(c.sessionToken!) } : null,
      });
      return json({ url: s.url }, 200, { "set-cookie": flowCookie(cookies.oauth, key, flows.oauth.ttlMs) });
    };

  const callback =
    (platform: OidcPlatform): Handler =>
    async (c) => {
      const flow = flows.oauth.take(c.req.cookies.get(cookies.oauth));
      const clear = [cookies.clear(cookies.oauth)];
      const back = flow?.link ? "/settings" : "/login";
      const failed = (code: string) => redirect(`${back}#error=${code}`, clear);
      const q = c.url.searchParams;
      const code = q.get("code");
      if (!flow || flow.platform !== platform || q.get("state") !== flow.state) return failed("invalid_state");
      if (q.get("error") || !code || code.length > 2048) return failed("cancelled");

      const result = await auth.oidc[platform]!.finish(code, flow.verifier, flow.nonce);
      if (!result.ok) return failed("provider_failed");
      const ref = { platform, platformUserId: result.sub };

      if (flow.link) {
        const session = services.webSessions.byHash(flow.link.sessionHash);
        if (session?.accountId !== flow.link.accountId) return failed("unauthorized");
        const r = services.identities.link(session.accountId, ref);
        return r === "ok" ? redirect(`/settings#linked=${platform}`, clear) : failed(r);
      }

      const identityId = services.identities.key(ref);
      const accountId = services.identities.accountOf(identityId);
      if (accountId) return redirect("/login#signedin", [...clear, sessionCookie(accountId, identityId)]);
      // Signed in fine, but nobody has this login yet: the sign-up form may create an account for it.
      const ticket = flows.signup.put({ ref });
      return redirect("/signup", [...clear, flowCookie(cookies.signup, ticket, flows.signup.ttlMs)]);
    };

  const oauthRoutes: Routes = {};
  for (const platform of Object.keys(auth.oidc) as OidcPlatform[]) {
    oauthRoutes[`/api/auth/${platform}/start`] = { POST: signInLimit(start(platform, false)) };
    oauthRoutes[`/api/auth/${platform}/link`] = { POST: user(start(platform, true)) };
    oauthRoutes[`/api/auth/${platform}/callback`] = { GET: signInLimit(callback(platform)) };
  }

  // ---------- Sign-up ----------

  const signup = async (c: Ctx): Promise<Response> => {
    const data = await c.body(PASSKEY_BODY_MAX);
    const checked = readSignup(data);
    if ("error" in checked) return fail(checked.error === "bad_request" ? 400 : 422, checked.error);

    if (data!.passkey !== undefined) {
      if (!auth.providers.includes("passkey")) return fail(404, "not_found");
      const r = await finishPasskeySignup(api, c, data!.passkey, checked.profile);
      if (!r.ok) return fail(r.status, r.error);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(r.accountId, r.identityId) });
    }

    const ticket = flows.signup.take(c.req.cookies.get(cookies.signup));
    if (!ticket) return fail(401, "no_signup");
    const identityId = services.identities.key(ticket.ref);
    // Two tabs: the other one made the account already. Sign in to it as it is.
    const existing = services.identities.accountOf(identityId);
    const accountId = existing ?? services.accounts.register(ticket.ref, checked.profile).profile.id;
    const headers = new Headers();
    headers.append("set-cookie", sessionCookie(accountId, identityId));
    headers.append("set-cookie", cookies.clear(cookies.signup));
    return withHeaders(json({ ok: true }), headers);
  };

  // ---------- Logins ----------

  const loginsView = (c: Ctx): LoginsView => ({
    logins: services.identities.list(c.user.id).map((i) => ({
      platform: i.platform as LoginPlatform,
      createdAt: i.createdAt,
      current: i.id === c.session.identityId,
      usable: usable(i.platform),
    })),
    passkeys: services.passkeys.list(c.user.id).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
  });

  return {
    ...oauthRoutes,

    "/api/auth/signup": {
      GET: signInLimit((c) => {
        const ticket = flows.signup.peek(c.req.cookies.get(cookies.signup));
        return ticket ? json({ method: ticket.ref.platform }) : fail(404, "no_signup");
      }),
      POST: signUpLimit(signup),
    },

    "/api/auth/logins": {
      GET: user((c) => json(loginsView(c))),
    },

    // Removing a login. Not the one this browser is signed in with (that would sign it out
    // mid-click; sign in another way first), never the last one, and never so that only logins
    // the site can't currently sign in with are left.
    "/api/auth/logins/:platform": {
      DELETE: user((c) => {
        const platform = c.param("platform", /^[a-z]{1,16}$/);
        if (!platform || !isPlatform(platform)) return fail(404, "not_found");
        const all = services.identities.list(c.user.id);
        const target = all.find((i) => i.platform === platform);
        if (!target) return fail(404, "not_found");
        if (target.id === c.session.identityId) return fail(409, "current_login");
        if (!all.some((i) => i.id !== target.id && usable(i.platform))) return fail(409, "last_login");
        const r = services.identities.unlink(c.user.id, platform);
        if (r === "last") return fail(409, "last_login");
        return json(loginsView(c));
      }),
    },

    // Adds Telegram to an account made on the website. The browser went to Telegram's login page
    // and came back to /settings#tgAuthResult=…, like signing in (see auth.ts).
    "/api/auth/telegram/link": {
      POST: user(async (c) => {
        const data = await c.body();
        if (!data) return fail(400, "bad_request");
        const check = verifyTelegramLogin(data, opts.botToken, now());
        if (!check.ok) return fail(check.reason === "expired" ? 401 : 400, check.reason);
        const r = services.identities.link(c.user.id, { platform: "telegram", platformUserId: check.telegramId });
        return r === "ok" ? json(loginsView(c)) : fail(409, r);
      }),
    },
  };
}

/** `res` with these extra headers (Set-Cookie may repeat). */
export function withHeaders(res: Response, extra: Headers): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of extra) headers.append(k, v);
  return new Response(res.body, { status: res.status, headers });
}
