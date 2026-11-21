// The signed-in person: their settings, dashboard and its live updates.

import { isGender, isValidHeight, isValidWeight, webName } from "../../services/accounts.ts";
import { fail, json } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { user } from "./guards.ts";
import { toMe } from "./views.ts";

export function meRoutes({ services, views, live }: Api): Routes {
  const hasTelegram = (accountId: string) => services.identities.find(accountId, "telegram") !== null;
  return {
    "/api/me": {
      GET: user((c) => json(toMe(c.user, c.admin, hasTelegram(c.user.id), services.accounts.isGuest(c.user.id)))),

      PATCH: user(async (c) => {
        const data = await c.body();
        if (!data) return fail(400, "bad_request");
        const { chartName, weight, height, gender } = data;
        const telegram = hasTelegram(c.user.id);
        // Validate everything first so a bad field doesn't leave a half-applied update.
        // The name is the website's only for accounts without Telegram: the bot keeps the others'.
        const name = data.name === undefined ? undefined : webName(data.name);
        if (data.name !== undefined && telegram) return fail(409, "telegram_name");
        if (name === null) return fail(422, "invalid_user_name");
        if (chartName !== undefined && chartName !== "full" && chartName !== "username") return fail(422, "invalid_chart_name");
        if (weight !== undefined && !(typeof weight === "number" && isValidWeight(weight))) return fail(422, "invalid_weight");
        if (height !== undefined && !(typeof height === "number" && isValidHeight(height))) return fail(422, "invalid_height");
        if (gender !== undefined && !(typeof gender === "string" && isGender(gender))) return fail(422, "invalid_gender");
        const id = c.user.id;
        services.deps.db.transaction(() => {
          if (name !== undefined) services.accounts.updateName(id, name);
          if (chartName !== undefined) services.accounts.updateChartName(id, chartName as "full" | "username");
          if (weight !== undefined) services.accounts.updateWeight(id, weight as number);
          if (height !== undefined) services.accounts.updateHeight(id, height as number);
          if (gender !== undefined) services.accounts.updateGender(id, gender as "mies" | "nainen");
        })();
        return json(toMe(services.accounts.get(id)!, c.admin, telegram, services.accounts.isGuest(id)));
      }),
    },

    "/api/dashboard": {
      GET: user((c) => json(views.dashboard(c.user))),
    },

    "/api/events": {
      GET: user((c) => live.stream(c, `u:${c.user.id}`, c.user.id)),
    },
  };
}
