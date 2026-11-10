// Barcodes: the same lookup as the bot's barcodeView (src/bot/menu.ts), and the products users add
// for codes nobody knows. The camera image never leaves the browser, which decodes it and sends
// only the number.

import { normalizeEan } from "../../lib/ean.ts";
import { customCatalogDrink, isCustomKind } from "../../lib/servings.ts";
import { ABV_MAX, ABV_MIN, cleanProductName, SIZE_MAX_L, SIZE_MIN_L, type CustomProduct } from "../../services/customproducts.ts";
import { productReportNotice } from "../../bot/admin.ts";
import type { BarcodeResult } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Ctx, Handler, Routes } from "./context.ts";
import { user } from "./guards.ts";
import { toProduct } from "./views.ts";

type EanHandler = (c: Ctx, ean: string) => Response | Promise<Response>;

export function barcodeRoutes({ services, opts, limits }: Api): Routes {
  const { products, barcodes, customProducts } = services;

  /** A signed-in user, barcodes switched on, and :ean a valid code (UPC-A turned into EAN-13). */
  const withEan = (h: EanHandler): Handler =>
    user((c) => {
      if (!barcodes.enabled && !products.enabled) return fail(404, "barcodes_off");
      const ean = normalizeEan(c.param("ean", /^\d{1,20}$/) ?? "");
      return ean ? h(c, ean) : fail(422, "invalid_barcode");
    });

  return {
    "/api/barcodes/:ean": { GET: withEan(lookup) },
    "/api/barcodes/:ean/product": { PUT: withEan(saveProduct), DELETE: withEan(deleteProduct) },
    "/api/barcodes/:ean/report": { POST: withEan(report) },
  };

  function foundCustom(product: CustomProduct, c: Ctx): BarcodeResult {
    const { addedBy: _a, createdAt: _c, updatedAt: _u, ...data } = product;
    return {
      status: "found",
      ean: product.ean,
      product: toProduct(customCatalogDrink(product)),
      custom: { ...data, canEdit: customProducts.canEdit(product, c.user.id, c.admin) },
    };
  }

  async function lookup(c: Ctx, ean: string) {
    if (limits.barcode.hit(c.user.id) !== "ok") return fail(429, "rate_limited");
    // Alkometriikka's catalogue first, then the products users have added here, and only then the
    // API Worker (which asks Alko).
    let productId = products.productIdByEan(ean) ?? null;
    if (!productId) {
      const custom = customProducts.get(ean);
      if (custom) return json(foundCustom(custom, c));
      const hit = await barcodes.resolve(ean);
      if (!hit.ok) {
        if (hit.reason === "invalid") return fail(422, "invalid_barcode");
        return fail(hit.reason === "rate-limited" ? 429 : 503, hit.reason === "rate-limited" ? "barcode_rate_limited" : "barcode_unavailable");
      }
      productId = hit.productId;
    }
    const answer = (r: BarcodeResult) => json(r);
    if (!productId) return answer({ status: "unknown", ean });
    const drink = products.get(productId);
    if (drink) return answer({ status: "found", ean, product: toProduct(drink), custom: null });
    const skipped = products.notDrinkable(productId);
    if (skipped) return answer({ status: "alcohol_free", ean, name: skipped.name });
    return answer({ status: "gone", ean }); // discontinued at Alko, but maybe still sold elsewhere
  }

  async function saveProduct(c: Ctx, ean: string) {
    const data = await c.body();
    if (!data) return fail(400, "bad_request");
    const { kind, name, sizeL, abv } = data;
    const kcal100 = data.kcal100 ?? null;
    if (typeof kind !== "string" || !isCustomKind(kind)) return fail(422, "invalid_kind");
    if (typeof name !== "string" || !cleanProductName(name)) return fail(422, "invalid_product_name");
    if (typeof sizeL !== "number" || !(sizeL >= SIZE_MIN_L && sizeL <= SIZE_MAX_L)) return fail(422, "invalid_size");
    if (typeof abv !== "number" || !(abv >= ABV_MIN && abv <= ABV_MAX)) return fail(422, "invalid_abv");
    if (kcal100 !== null && !(typeof kcal100 === "number" && kcal100 >= 0 && kcal100 < 1000)) return fail(422, "invalid_kcal");
    // The catalogue always wins, as in the bot.
    const alkoId = products.productIdByEan(ean);
    if (alkoId && products.get(alkoId)) return fail(409, "in_catalogue");
    const r = customProducts.save({ ean, kind, name, sizeL, abv, kcal100 }, c.user.id, c.admin);
    if (!r.ok) return r.reason === "not_allowed" ? fail(403, "not_allowed") : fail(422, "no_serving");
    if (r.created) console.log(`Custom barcode product added (web): ${r.product.ean} ${JSON.stringify(r.product.name)}`);
    return json(foundCustom(r.product, c), r.created ? 201 : 200);
  }

  function deleteProduct(c: Ctx, ean: string) {
    const product = customProducts.get(ean);
    if (!product) return fail(404, "not_found");
    if (!customProducts.delete(ean, c.user.id, c.admin)) return fail(403, "not_allowed");
    console.log(`Custom barcode product deleted (web): ${product.ean} ${JSON.stringify(product.name)}`);
    return json({ ok: true });
  }

  async function report(c: Ctx, ean: string) {
    const data = await c.body();
    if (!data) return fail(400, "bad_request");
    if (typeof data.message !== "string") return fail(422, "invalid_report");
    const r = customProducts.report(ean, c.user.id, data.message);
    if (!r.ok) return r.reason === "gone" ? fail(404, "not_found") : r.reason === "invalid" ? fail(422, "invalid_report") : fail(429, "too_many_reports");
    if (r.created) {
      console.log(`Custom barcode product reported (web): ${r.product.ean} ${JSON.stringify(r.product.name)}`);
      void opts.notifyAdmins?.(productReportNotice(r.product, r.message));
    }
    return json({ ok: true });
  }
}
