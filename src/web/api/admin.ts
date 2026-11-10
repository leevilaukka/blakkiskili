// The admin page: statistics and moderating user-added barcode products.

import type { CustomProduct } from "../../services/customproducts.ts";
import type { AdminProduct, AdminView } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Ctx, Routes } from "./context.ts";
import { admin } from "./guards.ts";

const toAdminProduct = (c: CustomProduct): AdminProduct => ({
  ean: c.ean,
  kind: c.kind,
  name: c.name,
  sizeL: c.sizeL,
  abv: c.abv,
  kcal100: c.kcal100,
  orphan: c.addedBy === null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const ean = (c: Ctx) => c.param("ean", /^\d{8,14}$/);

export function adminRoutes({ services, live, now }: Api): Routes {
  const { customProducts } = services;

  return {
    "/api/admin": { GET: admin(overview) },

    "/api/admin/products/:ean": {
      DELETE: admin((c) => {
        const code = ean(c);
        return code && customProducts.delete(code, c.user.id, true) ? json({ ok: true }) : fail(404, "not_found");
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
        items: customProducts.list().map(toAdminProduct),
      },
      reported: customProducts.reported().map((r) => ({ ...toAdminProduct(r.product), reports: r.reports })),
    };
    return json(view);
  }
}
