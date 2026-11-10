// Event screens: read-only views for a TV or OBS, opened with a link's token (kept in a cookie
// after /api/screen/open) rather than a session. Group screens are made in groups.ts; personal
// ones here.

import { HOUR_MS } from "../../lib/units.ts";
import { SCREEN_DEFAULT_TTL_MS } from "../../services/screens.ts";
import { fail, json, photoResponse } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { limitByIp, screen, user } from "./guards.ts";

/** A screen link's lifetime from the request's `hours`. */
export const lifetime = (hours: unknown) => (typeof hours === "number" && Number.isFinite(hours) ? hours * HOUR_MS : SCREEN_DEFAULT_TTL_MS);

export function screenRoutes({ services, views, live, cookies, groupPhotos }: Api): Routes {
  const { screens } = services;

  return {
    "/api/screen/open": {
      POST: limitByIp("signIn")(async (c) => {
        const data = await c.body();
        if (!data || typeof data.token !== "string" || data.token.length > 200) return fail(400, "bad_request");
        const access = screens.authenticate(data.token);
        if (!access) return fail(404, "invalid_screen");
        return json({ ok: true }, 200, { "set-cookie": cookies.set(cookies.screen, data.token, access.expiresAt) });
      }),
    },

    "/api/screen": { GET: screen((_c, access) => json(views.screenView(access))) },
    "/api/screen/events": { GET: screen((c, access) => live.stream(c, `s:${access.hash}`, access.hash)) },
    "/api/screen/photo": {
      GET: screen(async (_c, { groupId }) => {
        const chatId = groupId ? services.groups.telegramChatId(groupId) : null;
        if (!groupId || chatId === null) return fail(404, "no_photo");
        return photoResponse(await groupPhotos.get(groupId, chatId), 3600);
      }),
    },

    // The signed-in person's own screens.
    "/api/screens": {
      GET: user((c) => json({ screens: views.screenItems(screens.list({ accountId: c.user.id }), c.user) })),
      POST: user(async (c) => {
        const made = screens.create({ accountId: c.user.id }, c.user.id, lifetime((await c.body())?.hours));
        return made === "limit" ? fail(409, "too_many_screens") : json(made, 201);
      }),
    },
    "/api/screens/:ref": {
      DELETE: user((c) => {
        const ref = c.param("ref", /^[0-9a-f]{16}$/);
        return ref && screens.revoke({ accountId: c.user.id }, ref) ? json({ ok: true }) : fail(404, "not_found");
      }),
    },
  };
}
