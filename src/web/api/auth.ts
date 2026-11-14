// The site's config, signing in (Telegram's login page or a /web link) and signing out.

import { CATALOG } from "../../lib/catalog.ts";
import { toStandardDrinks } from "../../lib/units.ts";
import type { Config } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import { verifyTelegramLogin } from "../telegram.ts";
import type { Api, Routes } from "./context.ts";
import { limitByIp, user } from "./guards.ts";

export function authRoutes({ services, opts, cookies, live, now }: Api): Routes {
  const signInLimit = limitByIp("signIn");
  const signedIn = (sessionToken: string, expiresAt: number) =>
    json({ ok: true }, 200, { "set-cookie": cookies.set(cookies.session, sessionToken, expiresAt) });
  const signedOut = (data: object) => json({ ok: true, ...data }, 200, { "set-cookie": cookies.clear(cookies.session) });

  return {
    "/api/config": {
      GET: () =>
        json({
          botUsername: typeof opts.botUsername === "function" ? opts.botUsername() : opts.botUsername,
          botId: Number(opts.botToken.split(":")[0]), // public: the part of the token before the colon
          catalogue: services.products.ready,
          barcodes: services.barcodes.enabled || services.products.enabled,
          presets: CATALOG.flatMap((c) =>
            c.presets.map((pr) => ({
              id: pr.id,
              name: pr.name,
              standardDrinks: toStandardDrinks(pr.mg / 1000),
              kcal: pr.kcal,
              category: c.id as "miedot" | "viinit" | "shotit",
            })),
          ),
        } satisfies Config),
    },

    "/api/auth/telegram": {
      POST: signInLimit(async (c) => {
        const data = await c.body();
        if (!data) return fail(400, "bad_request");
        const check = verifyTelegramLogin(data, opts.botToken, now());
        if (!check.ok) return fail(check.reason === "expired" ? 401 : 400, check.reason);
        const identityId = services.identities.key({ platform: "telegram", platformUserId: check.telegramId });
        const accountId = services.identities.accountOf(identityId);
        if (!accountId) return fail(404, "not_registered");
        const { sessionToken, expiresAt } = services.webSessions.createSession(accountId, identityId);
        return signedIn(sessionToken, expiresAt);
      }),
    },

    "/api/auth/link": {
      POST: signInLimit(async (c) => {
        const data = await c.body();
        if (!data || typeof data.token !== "string" || data.token.length > 200) return fail(400, "bad_request");
        const redeemed = services.webSessions.redeemLoginLink(data.token);
        if (!redeemed) return fail(401, "invalid_link");
        return signedIn(redeemed.sessionToken, redeemed.expiresAt);
      }),
    },

    "/api/auth/logout": {
      POST: user((c) => {
        services.webSessions.revoke(c.sessionToken!);
        return signedOut({});
      }),
    },

    // Every browser signed in to this account, this one included; open live pages are told to stop.
    "/api/auth/logout-all": {
      POST: user((c) => {
        const sessions = services.webSessions.revokeAll(c.user.id);
        live.endOwner(c.user.id);
        return signedOut({ sessions });
      }),
    },

    "/api/auth/sessions": {
      GET: user((c) => json({ count: services.webSessions.count(c.user.id) })),
    },
  };
}
