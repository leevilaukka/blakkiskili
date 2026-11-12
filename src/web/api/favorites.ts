// Favourites: pinned drinks, logged again with one click (log one with POST /api/drinks, kind "favorite").

import { toStandardDrinks } from "../../lib/units.ts";
import { MAX_FAVORITES, type AddFavoriteResult, type Favorite } from "../../services/favorites.ts";
import type { FavoriteItem, Favorites } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { user } from "./guards.ts";

const toFavoriteItem = (f: Favorite): FavoriteItem => ({
  id: f.id,
  description: f.description,
  standardDrinks: toStandardDrinks(f.alcoholMg / 1000),
  kcal: f.kcal,
});

export function favoriteRoutes({ services }: Api): Routes {
  const { favorites, drinks } = services;
  const answer = (userId: string, result?: AddFavoriteResult) =>
    json({ favorites: favorites.list(userId).map(toFavoriteItem), max: MAX_FAVORITES, ...(result ? { result } : {}) } satisfies Favorites);

  return {
    "/api/favorites": {
      GET: user((c) => answer(c.user.id)),

      // Pins a drink from the logbook (any logged drink, as the bot pins the latest).
      POST: user(async (c) => {
        const data = await c.body();
        const id = data?.drinkId;
        if (typeof id !== "number" || !Number.isSafeInteger(id)) return fail(400, "bad_request");
        const drink = drinks.get(c.user.id, id);
        if (!drink) return fail(404, "not_found");
        return answer(c.user.id, favorites.add(c.user.id, drink));
      }),
    },

    "/api/favorites/:id": {
      DELETE: user((c) => {
        const id = c.param("id", /^\d{1,15}$/);
        return id && favorites.remove(c.user.id, Number(id)) ? answer(c.user.id) : fail(404, "not_found");
      }),
    },
  };
}
