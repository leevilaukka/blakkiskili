// The Alko catalogue: search and product photos.

import { fail, json, photoResponse } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { limitByAccount, signedIn, user } from "./guards.ts";
import { toProduct } from "./views.ts";

export function productRoutes({ services, photos }: Api): Routes {
  const { products } = services;

  return {
    "/api/products": {
      GET: user((c) => {
        if (!products.ready) return json({ products: [] });
        const q = (c.url.searchParams.get("q") ?? "").slice(0, 80).trim();
        const recent = services.drinks.recentProductIds(c.user.id, 20);
        const found = q ? products.search(q, 8, recent) : products.drinksFor(recent, 8);
        return json({ products: found.map(toProduct) });
      }),
    },

    // Thumbnails have their own rate limit rather than the general one.
    "/api/products/:id/photo": {
      GET: signedIn(
        limitByAccount("photo")(async (c) => {
          const id = c.param("id", /^[0-9A-Za-z]{1,16}$/);
          if (!id || !products.get(id)) return fail(404, "not_found"); // catalogue products only: not an open proxy
          return photoResponse(await photos.get(id), 7 * 24 * 3600);
        }),
      ),
    },
  };
}
