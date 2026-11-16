// The admin page: statistics, moderating user-added barcode products, and verifying the people
// who add good ones (no limit on adding).

import { PRODUCTS_PER_ACCOUNT, type CustomProduct } from "../../services/customproducts.ts";
import type { Services } from "../../services/index.ts";
import type { AdminAdder, AdminProduct, AdminView } from "../../../shared/api.ts";
import { S } from "../../strings.ts";
import { fail, json } from "../http.ts";
import type { Api, Ctx, Routes } from "./context.ts";
import { admin } from "./guards.ts";

/** Adders show up on the admin page from this many products (80 % of the limit), to be verified. */
export const ADDERS_SHOWN_FROM = Math.ceil(PRODUCTS_PER_ACCOUNT * 0.8);

/** An adder's handle on the admin page: the account id stays on the server. */
const adderRef = (services: Services, accountId: string) => services.deps.crypto.webTokenKey(`adder:${accountId}`).slice(0, 16);

const toAdminProduct = (services: Services, names: Map<string, string>, c: CustomProduct): AdminProduct => ({
  ean: c.ean,
  kind: c.kind,
  name: c.name,
  sizeL: c.sizeL,
  abv: c.abv,
  kcal100: c.kcal100,
  orphan: c.addedBy === null,
  adderRef: c.addedBy === null ? null : adderRef(services, c.addedBy),
  adderName: c.addedBy === null ? null : (names.get(c.addedBy) ?? null),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const ean = (c: Ctx) => c.param("ean", /^\d{8,14}$/);

export function adminRoutes({ services, live, now, opts }: Api): Routes {
  const { customProducts } = services;

  return {
    "/api/admin": { GET: admin(overview) },

    "/api/admin/products/:ean": {
      DELETE: admin((c) => {
        const code = ean(c);
        return code && customProducts.delete(code, c.user.id, true) ? json({ ok: true }) : fail(404, "not_found");
      }),
    },

    // Verify an adder (no limit on adding products), or take it back.
    "/api/admin/adders/:ref": {
      PUT: admin(async (c) => {
        const ref = c.param("ref", /^[0-9a-f]{16}$/);
        const trusted = (await c.body())?.trusted;
        if (typeof trusted !== "boolean") return fail(400, "bad_request");
        const adder = ref ? customProducts.adders().find((a) => adderRef(services, a.accountId) === ref) : undefined;
        if (!adder) return fail(404, "not_found");
        // Newly verified: they hear it from the bot, so they know they can add more.
        const changed = customProducts.setTrusted(adder.accountId, trusted);
        const notified = changed && trusted ? ((await opts.messageAccount?.(adder.accountId, S.custom.verified_user)) ?? false) : false;
        return json({ ok: true, notified });
      }),
    },

    // The reports: the admin has handled them (fixed the product, or found nothing wrong).
    "/api/admin/products/:ean/reports": {
      DELETE: admin((c) => {
        const code = ean(c);
        return code ? json({ ok: true, cleared: customProducts.clearReports(code) }) : fail(404, "not_found");
      }),
    },
  };

  function overview() {
    const adders = customProducts.adders();
    const names = new Map(adders.map((a) => [a.accountId, a.name]));
    const g = services.stats.global();
    const w = services.stats.web();
    const view: AdminView = {
      now: now(),
      bot: {
        users: g.users,
        activeUsers7: g.activeUsers7,
        activeUsers14: g.activeUsers14,
        groups: g.groups,
        activeGroups7: g.activeGroups7,
        activeGroups14: g.activeGroups14,
        drinks: g.drinks,
        drinks24h: w.drinks24h,
        top: g.top,
      },
      web: {
        sessions: w.sessions,
        accounts: w.accounts,
        activeAccounts1: w.activeAccounts1,
        liveViewers: live.viewers(),
        webGroups: w.webGroups,
        screenLinks: w.screenLinks,
      },
      catalogue: { ready: services.products.ready, drinks: services.products.count },
      customProducts: {
        total: customProducts.count(),
        items: customProducts.list().map((p) => toAdminProduct(services, names, p)),
      },
      reported: customProducts.reported().map((r) => ({ ...toAdminProduct(services, names, r.product), reports: r.reports })),
      adders: {
        limit: PRODUCTS_PER_ACCOUNT,
        shownFrom: ADDERS_SHOWN_FROM,
        items: adders
          .filter((a) => a.trustedSince !== null || a.products >= ADDERS_SHOWN_FROM)
          .map(
          (a): AdminAdder => ({
            ref: adderRef(services, a.accountId),
            name: a.name,
            fullName: a.fullName,
            products: a.products,
            openReports: a.openReports,
            lastAddedAt: a.lastAddedAt,
            trusted: a.trustedSince !== null,
          }),
        ),
      },
    };
    return json(view);
  }
}
