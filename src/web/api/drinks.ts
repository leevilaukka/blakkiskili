// Logging drinks, the logbook, undo and delete.

import { findPreset } from "../../lib/catalog.ts";
import { customCatalogDrink, eanOfCustomDrinkId, isAlkoProductId, resolveServing, servingDescription, type CatalogDrink } from "../../lib/servings.ts";
import { buildChartData } from "../../lib/chart.ts";
import { alcoholMgFromClPercent, HOUR_MS, isAlcoholAmountOutOfLimits, MINUTE_MS, toStandardDrinks } from "../../lib/units.ts";
import { chartLabel } from "../../services/accounts.ts";
import { EBAC_WINDOW_MS, type DrinkCursor, type DrinkFilter } from "../../services/drinks.ts";
import type { DrinkLog, LogDrinkRequest } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Ctx, Routes } from "./context.ts";
import { user } from "./guards.ts";
import { toItem } from "./views.ts";

const LOG_PAGE = 100;
/** A session is a run of drinks with pauses under 6 h; this keeps a request from asking for months of samples. */
const MAX_SESSION_CHART_MS = 7 * 24 * HOUR_MS;
const LOG_PAGE_MAX = 200;
/** How far back a forgotten drink may be dated (the estimate only looks 3 days back anyway). */
const MAX_BACKDATE_MS = 7 * 24 * HOUR_MS;

export function drinkRoutes({ services }: Api): Routes {
  const { drinks, favorites } = services;

  return {
    "/api/drinks": { GET: user(logbook), POST: user(logDrink) },

    // What "repeat" would log (the last drink of any time, not only this session).
    "/api/drinks/last": {
      GET: user((c) => {
        const last = drinks.last(c.user.id);
        return json({ drink: last ? toItem(last) : null });
      }),
    },

    // The estimate over one past drinking session (from its first to its last drink).
    "/api/drinks/chart": { GET: user(sessionChart) },

    "/api/drinks/undo": {
      POST: user((c) => {
        const undone = drinks.undoLast(c.user.id);
        return undone ? json(toItem(undone)) : fail(404, "nothing_to_undo");
      }),
    },

    "/api/drinks/:id": {
      DELETE: user((c) => {
        const id = c.param("id", /^\d{1,15}$/);
        return id && drinks.delete(c.user.id, Number(id)) ? json({ ok: true }) : fail(404, "not_found");
      }),
    },
  };

  /** A drink by id: an Alko product, or a user-added barcode product ("e<ean>"), as findDrink in the bot's menu. */
  function findDrink(id: string): CatalogDrink | undefined {
    const ean = eanOfCustomDrinkId(id);
    if (!ean) return services.products.get(id);
    const custom = services.customProducts.get(ean);
    return custom ? customCatalogDrink(custom) : undefined;
  }

  async function logDrink(c: Ctx) {
    const data = await c.body();
    if (!data) return fail(400, "bad_request");
    const id = c.user.id;
    const r = data as unknown as LogDrinkRequest;
    // A forgotten drink: dated now by default, at most a week back, never ahead of the clock.
    let at: number | undefined;
    if (r.at !== undefined) {
      const t = services.deps.now();
      if (typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.at < t - MAX_BACKDATE_MS || r.at > t + MINUTE_MS) {
        return fail(422, "invalid_time");
      }
      at = Math.min(r.at, t);
    }
    switch (r.kind) {
      case "preset": {
        const preset = typeof r.id === "string" ? findPreset(r.id) : undefined;
        if (!preset) return fail(404, "unknown_preset");
        return json(toItem(drinks.add(id, preset.mg, preset.name, { at, kcal: preset.kcal })), 201);
      }
      case "product": {
        const drink = typeof r.productId === "string" ? findDrink(r.productId) : undefined;
        const serving = drink && typeof r.serving === "string" ? resolveServing(drink, r.serving) : undefined;
        if (!drink || !serving) return fail(404, "unknown_product");
        const added = drinks.add(id, serving.mg, servingDescription(drink, serving), {
          // drinks.product_id is an Alko product number; user-added products have none.
          at,
          productId: isAlkoProductId(serving.productId) ? serving.productId : null,
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
        return json(toItem(drinks.add(id, mg, `Oma juoma - ${cl}cl ${percent}%`, { at })), 201);
      }
      case "repeat": {
        const last = drinks.last(id);
        if (!last) return fail(404, "nothing_to_repeat");
        const added = drinks.add(id, last.alcoholMg, last.description, { at, productId: last.productId, kcal: last.kcal });
        return json(toItem(added), 201);
      }
      case "favorite": {
        const fav = typeof r.id === "number" ? favorites.get(id, r.id) : null;
        if (!fav) return fail(404, "not_found");
        return json(toItem(drinks.add(id, fav.alcoholMg, fav.description, { at, productId: fav.productId, kcal: fav.kcal })), 201);
      }
      default:
        return fail(400, "bad_request");
    }
  }

  /** A session's curve: from an hour before the first drink until the estimate is long gone (at most 12 h after the last), never past now. */
  function sessionChart(c: Ctx) {
    const num = (name: string) => {
      const v = c.url.searchParams.get(name) ?? "";
      return /^\d{1,15}$/.test(v) ? Number(v) : null;
    };
    const first = num("from");
    const last = num("to");
    if (first === null || last === null || last < first || last - first > MAX_SESSION_CHART_MS) return fail(400, "bad_request");
    const t = services.deps.now();
    const body = c.user;
    const history = { from: first - HOUR_MS, to: Math.min(last + 12 * HOUR_MS, t) };
    const samples = drinks.since(body.id, first - EBAC_WINDOW_MS).filter((d) => d.createdAt <= history.to);
    return json(buildChartData([{ id: body.id, name: chartLabel(body), body, drinks: samples }], t, history));
  }

  /** The logbook. Bad parameters are a 400: the site never sends them. */
  function logbook(c: Ctx) {
    const params = c.url.searchParams;
    const time = (name: string): number | undefined | null => {
      const v = params.get(name);
      if (v === null || v === "") return undefined;
      const n = Number(v);
      return /^\d{1,15}$/.test(v) && Number.isSafeInteger(n) ? n : null;
    };
    const from = time("from");
    const to = time("to");
    const limitParam = time("limit");
    if (from === null || to === null || limitParam === null) return fail(400, "bad_request");
    const limit = Math.min(Math.max(limitParam ?? LOG_PAGE, 1), LOG_PAGE_MAX);
    let before: DrinkCursor | undefined;
    const b = params.get("before");
    if (b) {
      const m = /^(\d{1,15})\.(\d{1,15})$/.exec(b);
      if (!m) return fail(400, "bad_request");
      before = { at: Number(m[1]), id: Number(m[2]) };
    }
    const filter: DrinkFilter = { from, to, q: (params.get("q") ?? "").slice(0, 80).trim() || undefined };
    // One extra row tells whether there is another page.
    const rows = drinks.page(c.user.id, filter, limit + 1, before);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const t = drinks.totals(c.user.id, filter);
    const log: DrinkLog = {
      drinks: page.map(toItem),
      totals: {
        count: t.count,
        standardDrinks: toStandardDrinks(t.alcoholMg / 1000),
        kcal: t.energy.kcal,
        unknownKcal: t.energy.unknown,
        sessions: t.sessions,
      },
      next: more && last ? `${last.createdAt}.${last.id}` : null,
    };
    return json(log);
  }
}
