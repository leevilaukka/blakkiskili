// The Alko catalogue: search, product photos, and what a serving logs. Signed-out visitors may use
// them too when local accounts are on (LOCAL_ACCOUNTS): a local account searches here and logs the
// drink in the browser. Nothing a visitor sends is tied to a person.

import { customCatalogDrink, eanOfCustomDrinkId, isAlkoProductId, resolveServing, servingDescription, type CatalogDrink } from "../../lib/servings.ts";
import type { Services } from "../../services/index.ts";
import type { ServingDrink } from "../../../shared/api.ts";
import { fail, json, photoResponse } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { limitByAccount, signedIn, userOrVisitor } from "./guards.ts";
import { toProduct } from "./views.ts";

/** A drink by id: an Alko product, or a user-added barcode product ("e<ean>"), as findDrink in the bot's menu. */
export function findDrink(services: Services, id: string): CatalogDrink | undefined {
  const ean = eanOfCustomDrinkId(id);
  if (!ean) return services.products.get(id);
  const custom = services.customProducts.get(ean);
  return custom ? customCatalogDrink(custom) : undefined;
}

/** What logging `servingKey` of drink `id` stores, or null when there is no such serving. */
export function servingDrink(services: Services, id: string, servingKey: string): ServingDrink | null {
  const drink = findDrink(services, id);
  const serving = drink ? resolveServing(drink, servingKey) : undefined;
  if (!drink || !serving) return null;
  return {
    description: servingDescription(drink, serving),
    alcoholMg: serving.mg,
    kcal: serving.kcal,
    // drinks.product_id is an Alko product number; user-added products have none.
    productId: isAlkoProductId(serving.productId) ? serving.productId : null,
  };
}

export function productRoutes({ services, photos, auth }: Api): Routes {
  const { products } = services;
  const visitors = userOrVisitor(auth.local);

  return {
    "/api/products": {
      GET: visitors((c) => {
        if (!products.ready) return json({ products: [] });
        const q = (c.url.searchParams.get("q") ?? "").slice(0, 80).trim();
        const recent = c.hasUser ? services.drinks.recentProductIds(c.user.id, 20) : [];
        const found = q ? products.search(q, 8, recent, services.customProducts.drinks()) : products.drinksFor(recent, 8);
        return json({ products: found.map(toProduct) });
      }),
    },

    "/api/products/:id/servings/:key": {
      GET: visitors((c) => {
        const id = c.param("id", /^[0-9A-Za-z]{1,20}$/);
        const key = c.param("key", /^[0-9A-Za-z_.-]{1,40}$/);
        const drink = id && key ? servingDrink(services, id, key) : null;
        return drink ? json(drink) : fail(404, "unknown_product");
      }),
    },

    // Thumbnails have their own rate limit rather than the general one.
    "/api/products/:id/photo": {
      GET: (auth.local ? userOrVisitor(true, "photo") : (h: Parameters<typeof signedIn>[0]) => signedIn(limitByAccount("photo")(h)))(async (c) => {
        const id = c.param("id", /^[0-9A-Za-z]{1,16}$/);
        if (!id || !products.get(id)) return fail(404, "not_found"); // catalogue products only: not an open proxy
        return photoResponse(await photos.get(id), 7 * 24 * 3600);
      }),
    },
  };
}
