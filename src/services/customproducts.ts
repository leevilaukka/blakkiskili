// Products users add for barcodes Alko doesn't know (grocery-store beers, imports). Stored in the
// bot's own database only: nothing here is sent to Alkometriikka. Shared by everyone: once one
// user adds a barcode, it opens the product for all. The adder (and admins) can fix or remove it;
// everyone else can report an error to the admins (custom_product_reports).

import { normalizeEan } from "../lib/ean.ts";
import { customCatalogDrink, isCustomKind, type CatalogDrink, type CustomKind, type CustomProductData } from "../lib/servings.ts";
import type { Deps } from "./index.ts";
import type { Barcodes } from "./barcodes.ts";
import type { Products } from "./products.ts";

export interface CustomProduct extends CustomProductData {
  addedBy: string | null; // account id; null once that account is deleted
  createdAt: number;
  updatedAt: number;
}

interface Row {
  ean: string;
  kind: string;
  name: string;
  size_l: number;
  abv: number;
  kcal100: number | null;
  added_by: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Row): CustomProduct => ({
  ean: r.ean,
  kind: isCustomKind(r.kind) ? r.kind : "olut",
  name: r.name,
  sizeL: r.size_l,
  abv: r.abv,
  kcal100: r.kcal100,
  addedBy: r.added_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const NAME_MAX = 60;
export const SIZE_MIN_L = 0.01;
export const SIZE_MAX_L = 5;
export const ABV_MIN = 1;
export const ABV_MAX = 99;

/** Trimmed, single-spaced, without control characters; null if empty or too long. */
export function cleanProductName(input: string): string | null {
  const name = input.replace(/\p{Cc}|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
  return name.length >= 1 && [...name].length <= NAME_MAX ? name : null;
}

export const REPORT_MAX = 300;
/** Open reports one account may have at a time, so nobody can flood the admins. */
export const REPORTS_PER_ACCOUNT = 20;

/** Like a name, but longer; null if empty or too long. */
export function cleanReportMessage(input: string): string | null {
  const message = input.replace(/\p{Cc}|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
  return message.length >= 1 && [...message].length <= REPORT_MAX ? message : null;
}

/** A user-added product with its open error reports (for the admin page). */
export interface ReportedProduct {
  product: CustomProduct;
  reports: { message: string; createdAt: number }[];
}

export type ReportResult =
  | { ok: true; created: boolean; product: CustomProduct; message: string }
  | { ok: false; reason: "gone" | "invalid" | "too_many" };

export type SaveResult =
  | { ok: true; created: boolean; product: CustomProduct }
  | { ok: false; reason: "invalid" | "not_allowed" | "too_many" | "full" };

/**
 * Products one account may have added, and in all. Shared data, so capped; admins and the adders
 * they have verified have no limit.
 */
export const PRODUCTS_PER_ACCOUNT = 30;
export const PRODUCTS_MAX = 5000;
/** The admins hear about one person (or the total cap) being at the limit at most this often. */
export const LIMIT_NOTICE_EVERY_MS = 24 * 3600_000;

/**
 * Whether Alko sells (or sold as alcohol-free) the product behind a barcode, asking the API Worker
 * when the catalogue doesn't know the code. A user-added product would hide Alko's from everyone
 * (lookups find user-added ones before asking the Worker), so new ones are only allowed for "no":
 * codes nobody knows, or products Alko has discontinued. "unavailable" when the Worker can't
 * answer now.
 */
export async function alkoKnows(ean: string, products: Products, barcodes: Barcodes): Promise<"yes" | "no" | "unavailable"> {
  let id = products.productIdByEan(ean) ?? null;
  if (!id) {
    const hit = await barcodes.resolve(ean);
    if (!hit.ok) return hit.reason === "invalid" ? "no" : "unavailable";
    id = hit.productId;
  }
  return id && (products.get(id) || products.notDrinkable(id)) ? "yes" : "no";
}

/** An account that has added products, for the admin page. */
export interface ProductAdder {
  accountId: string;
  name: string;
  fullName: string | null;
  products: number;
  /** Open "Ilmoita virheestä" reports on their products. */
  openReports: number;
  lastAddedAt: number | null;
  /** Verified by an admin (no limit on adding): since when, or null. */
  trustedSince: number | null;
}

export class CustomProducts {
  private readonly limitNoticed = new Map<string, number>();

  constructor(private readonly deps: Deps) {}

  /**
   * Whether to tell the admins that `key` (an account, or "full" for the total cap) hit the limit:
   * true at most once per LIMIT_NOTICE_EVERY_MS, so retrying doesn't spam them. In memory only.
   */
  limitNotice(key: string): boolean {
    const now = this.deps.now();
    const last = this.limitNoticed.get(key);
    if (last !== undefined && now - last < LIMIT_NOTICE_EVERY_MS) return false;
    this.limitNoticed.set(key, now);
    return true;
  }

  get(input: string): CustomProduct | null {
    const ean = normalizeEan(input);
    if (!ean) return null;
    const row = this.deps.db.query("SELECT * FROM custom_products WHERE ean = ?").get(ean) as Row | null;
    return row ? fromRow(row) : null;
  }

  /** Who may change or remove a product: the account that added it, or an admin. */
  canEdit(p: CustomProduct, accountId: string, isAdmin: boolean): boolean {
    return isAdmin || (p.addedBy !== null && p.addedBy === accountId);
  }

  /**
   * Adds the product, or updates it when `accountId` may edit the existing one. Validates
   * everything, including that the product gives at least one loggable serving.
   */
  save(
    data: { ean: string; kind: CustomKind; name: string; sizeL: number; abv: number; kcal100: number | null },
    accountId: string,
    isAdmin: boolean,
  ): SaveResult {
    const ean = normalizeEan(data.ean);
    const name = cleanProductName(data.name);
    const valid =
      ean !== null &&
      name !== null &&
      isCustomKind(data.kind) &&
      data.sizeL >= SIZE_MIN_L &&
      data.sizeL <= SIZE_MAX_L &&
      data.abv >= ABV_MIN &&
      data.abv <= ABV_MAX &&
      (data.kcal100 === null || (data.kcal100 >= 0 && data.kcal100 < 1000));
    if (!valid) return { ok: false, reason: "invalid" };
    const clean = { ...data, ean, name };
    if (customCatalogDrink(clean).servings.length === 0) return { ok: false, reason: "invalid" };

    const now = this.deps.now();
    const existing = this.get(ean);
    if (existing) {
      if (!this.canEdit(existing, accountId, isAdmin)) return { ok: false, reason: "not_allowed" };
      this.deps.db
        .query("UPDATE custom_products SET kind = ?, name = ?, size_l = ?, abv = ?, kcal100 = ?, updated_at = ? WHERE ean = ?")
        .run(clean.kind, name, clean.sizeL, clean.abv, clean.kcal100, now, ean);
      return { ok: true, created: false, product: this.get(ean)! };
    }
    if (!isAdmin && !this.isTrusted(accountId)) {
      const mine = this.deps.db.query("SELECT count(*) AS n FROM custom_products WHERE added_by = ?").get(accountId) as { n: number };
      if (mine.n >= PRODUCTS_PER_ACCOUNT) return { ok: false, reason: "too_many" };
      if (this.count() >= PRODUCTS_MAX) return { ok: false, reason: "full" };
    }
    this.deps.db
      .query(
        `INSERT INTO custom_products (ean, kind, name, size_l, abv, kcal100, added_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ean, clean.kind, name, clean.sizeL, clean.abv, clean.kcal100, accountId, now, now);
    return { ok: true, created: true, product: this.get(ean)! };
  }

  /** Removes the product if `accountId` may edit it. Drinks already logged keep their description. */
  delete(input: string, accountId: string, isAdmin: boolean): boolean {
    const p = this.get(input);
    if (!p || !this.canEdit(p, accountId, isAdmin)) return false;
    return this.deps.db.query("DELETE FROM custom_products WHERE ean = ?").run(p.ean).changes > 0;
  }

  // ---------- verified adders (the admin page) ----------

  isTrusted(accountId: string): boolean {
    return !!this.deps.db.query("SELECT 1 FROM trusted_product_adders WHERE user_id = ?").get(accountId);
  }

  /**
   * Verifies the account (no limit on adding products), or takes it back. Returns whether that
   * changed anything (false when it already was so, or there is no such account).
   */
  setTrusted(accountId: string, trusted: boolean): boolean {
    if (!trusted) return this.deps.db.query("DELETE FROM trusted_product_adders WHERE user_id = ?").run(accountId).changes > 0;
    if (!this.deps.db.query("SELECT 1 FROM users WHERE id = ?").get(accountId)) return false;
    return this.deps.db.query("INSERT OR IGNORE INTO trusted_product_adders (user_id, granted_at) VALUES (?, ?)").run(accountId, this.deps.now()).changes > 0;
  }

  /**
   * Everyone who has added a product, or has been verified, with how their products have fared:
   * how many, and how many open error reports they have. Most products first.
   */
  adders(): ProductAdder[] {
    const rows = this.deps.db
      .query(
        `SELECT u.id, u.name_enc, u.full_name_enc, t.granted_at,
                (SELECT count(*) FROM custom_products p WHERE p.added_by = u.id) AS products,
                (SELECT max(created_at) FROM custom_products p WHERE p.added_by = u.id) AS last_added_at,
                (SELECT count(*) FROM custom_product_reports r JOIN custom_products p ON p.ean = r.ean WHERE p.added_by = u.id) AS reports
         FROM users u LEFT JOIN trusted_product_adders t ON t.user_id = u.id
         WHERE t.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM custom_products p WHERE p.added_by = u.id)
         ORDER BY products DESC, last_added_at DESC`,
      )
      .all() as { id: string; name_enc: string; full_name_enc: string | null; granted_at: number | null; products: number; last_added_at: number | null; reports: number }[];
    return rows.map((r) => ({
      accountId: r.id,
      name: this.deps.crypto.decrypt(r.name_enc),
      fullName: r.full_name_enc === null ? null : this.deps.crypto.decrypt(r.full_name_enc),
      products: r.products,
      openReports: r.reports,
      lastAddedAt: r.last_added_at,
      trustedSince: r.granted_at,
    }));
  }

  /** All user-added products, newest change first (for the admin page). */
  list(limit = 200): CustomProduct[] {
    return (
      this.deps.db.query("SELECT * FROM custom_products ORDER BY updated_at DESC, ean LIMIT ?").all(limit) as Row[]
    ).map(fromRow);
  }

  /** Every user-added product as a catalogue drink, for searching alongside the Alko catalogue. */
  drinks(): CatalogDrink[] {
    return (this.deps.db.query("SELECT * FROM custom_products LIMIT 5000").all() as Row[]).map((r) => customCatalogDrink(fromRow(r)));
  }

  count(): number {
    return (this.deps.db.query("SELECT count(*) AS n FROM custom_products").get() as { n: number }).n;
  }

  /**
   * "Ilmoita virheestä": stores the account's report on the product. Reporting the same product
   * again replaces the message (`created: false`), so admins are only notified once.
   */
  report(input: string, accountId: string, rawMessage: string): ReportResult {
    const product = this.get(input);
    if (!product) return { ok: false, reason: "gone" };
    const message = cleanReportMessage(rawMessage);
    if (!message) return { ok: false, reason: "invalid" };
    const db = this.deps.db;
    const existing = db
      .query("SELECT 1 FROM custom_product_reports WHERE ean = ? AND reported_by = ?")
      .get(product.ean, accountId);
    if (!existing) {
      const { n } = db.query("SELECT count(*) AS n FROM custom_product_reports WHERE reported_by = ?").get(accountId) as { n: number };
      if (n >= REPORTS_PER_ACCOUNT) return { ok: false, reason: "too_many" };
    }
    db.query(
      `INSERT INTO custom_product_reports (ean, reported_by, message, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (ean, reported_by) DO UPDATE SET message = excluded.message, created_at = excluded.created_at`,
    ).run(product.ean, accountId, message, this.deps.now());
    return { ok: true, created: !existing, product, message };
  }

  /** Products with open reports, the most recently reported first (for the admin page). */
  reported(): ReportedProduct[] {
    const rows = this.deps.db
      .query("SELECT ean, message, created_at FROM custom_product_reports ORDER BY created_at DESC")
      .all() as { ean: string; message: string; created_at: number }[];
    const byEan = new Map<string, ReportedProduct>();
    for (const r of rows) {
      let entry = byEan.get(r.ean);
      if (!entry) {
        const product = this.get(r.ean);
        if (!product) continue;
        entry = { product, reports: [] };
        byEan.set(r.ean, entry);
      }
      entry.reports.push({ message: r.message, createdAt: r.created_at });
    }
    return [...byEan.values()];
  }

  /** An admin has handled the product's reports. Returns how many were cleared. */
  clearReports(input: string): number {
    const ean = normalizeEan(input);
    if (!ean) return 0;
    return this.deps.db.query("DELETE FROM custom_product_reports WHERE ean = ?").run(ean).changes;
  }

  /** The products an account has added (for /data). */
  addedBy(accountId: string): CustomProduct[] {
    return (
      this.deps.db.query("SELECT * FROM custom_products WHERE added_by = ? ORDER BY created_at").all(accountId) as Row[]
    ).map(fromRow);
  }
}
