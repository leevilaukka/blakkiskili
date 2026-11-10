// Logging drinks, the logbook, undo and delete.

import { findPreset } from "../../lib/catalog.ts";
import { customCatalogDrink, eanOfCustomDrinkId, isAlkoProductId, resolveServing, servingDescription, type CatalogDrink } from "../../lib/servings.ts";
import { alcoholMgFromClPercent, isAlcoholAmountOutOfLimits, toStandardDrinks } from "../../lib/units.ts";
import type { DrinkCursor, DrinkFilter } from "../../services/drinks.ts";
import type { DrinkLog, LogDrinkRequest } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Ctx, Routes } from "./context.ts";
import { user } from "./guards.ts";
import { toItem } from "./views.ts";

const LOG_PAGE = 100;
const LOG_PAGE_MAX = 200;

export function drinkRoutes({ services }: Api): Routes {
  const { drinks } = services;

  return {
    "/api/drinks": { GET: user(logbook), POST: user(logDrink) },

    // What "repeat" would log (the last drink of any time, not only this session).
    "/api/drinks/last": {
      GET: user((c) => {
        const last = drinks.last(c.user.id);
        return json({ drink: last ? toItem(last) : null });
      }),
    },

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
    switch (r.kind) {
      case "preset": {
        const preset = typeof r.id === "string" ? findPreset(r.id) : undefined;
        if (!preset) return fail(404, "unknown_preset");
        return json(toItem(drinks.add(id, preset.mg, preset.name, { kcal: preset.kcal })), 201);
      }
      case "product": {
        const drink = typeof r.productId === "string" ? findDrink(r.productId) : undefined;
        const serving = drink && typeof r.serving === "string" ? resolveServing(drink, r.serving) : undefined;
        if (!drink || !serving) return fail(404, "unknown_product");
        const added = drinks.add(id, serving.mg, servingDescription(drink, serving), {
          // drinks.product_id is an Alko product number; user-added products have none.
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
        return json(toItem(drinks.add(id, mg, `Oma juoma - ${cl}cl ${percent}%`)), 201);
      }
      case "repeat": {
        const last = drinks.last(id);
        if (!last) return fail(404, "nothing_to_repeat");
        const added = drinks.add(id, last.alcoholMg, last.description, { productId: last.productId, kcal: last.kcal });
        return json(toItem(added), 201);
      }
      default:
        return fail(400, "bad_request");
    }
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
