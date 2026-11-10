// The signed-in person: their settings, dashboard and its live updates.

import { isGender, isValidHeight, isValidWeight } from "../../services/accounts.ts";
import { fail, json } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { user } from "./guards.ts";
import { toMe } from "./views.ts";

export function meRoutes({ services, views, live }: Api): Routes {
  return {
    "/api/me": {
      GET: user((c) => json(toMe(c.user, c.admin))),

      PATCH: user(async (c) => {
        const data = await c.body();
        if (!data) return fail(400, "bad_request");
        const { chartName, weight, height, gender } = data;
        // Validate everything first so a bad field doesn't leave a half-applied update.
        if (chartName !== undefined && chartName !== "full" && chartName !== "username") return fail(422, "invalid_chart_name");
        if (weight !== undefined && !(typeof weight === "number" && isValidWeight(weight))) return fail(422, "invalid_weight");
        if (height !== undefined && !(typeof height === "number" && isValidHeight(height))) return fail(422, "invalid_height");
        if (gender !== undefined && !(typeof gender === "string" && isGender(gender))) return fail(422, "invalid_gender");
        const id = c.user.id;
        services.deps.db.transaction(() => {
          if (chartName !== undefined) services.accounts.updateChartName(id, chartName as "full" | "username");
          if (weight !== undefined) services.accounts.updateWeight(id, weight as number);
          if (height !== undefined) services.accounts.updateHeight(id, height as number);
          if (gender !== undefined) services.accounts.updateGender(id, gender as "mies" | "nainen");
        })();
        return json(toMe(services.accounts.get(id)!, c.admin));
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
