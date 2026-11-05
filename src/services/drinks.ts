import { calculateEbac, type Ebac } from "../lib/alcomath.ts";
import { DAY_MS, HOUR_MS } from "../lib/units.ts";
import type { Accounts, Profile } from "./accounts.ts";
import type { Deps } from "./index.ts";

export interface Drink {
  id: number;
  alcoholMg: number;
  description: string;
  createdAt: number;
  productId: string | null;
}

interface DrinkRow {
  id: number;
  alcohol_mg: number;
  description: string;
  created_at: number;
  product_id: string | null;
}

const toDrink = (r: DrinkRow): Drink => ({
  id: r.id,
  alcoholMg: r.alcohol_mg,
  description: r.description,
  createdAt: r.created_at,
  productId: r.product_id,
});

/**
 * How far back drinks are considered for the current estimate. The original summed the
 * whole history; a drinking session that is still not burned after 3 days doesn't exist.
 */
export const EBAC_WINDOW_MS = 3 * DAY_MS;

export interface LateDrink {
  description: string;
  mg: number;
}

export class Drinks {
  constructor(
    private readonly deps: Deps,
    private readonly accounts: Accounts,
  ) {}

  add(userId: string, mg: number, description: string, opts: { at?: number; productId?: string | null } = {}): Drink {
    const insert = this.deps.db.query(
      `INSERT INTO drinks (user_id, alcohol_mg, description, created_at, product_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING *`,
    );
    // The same drink in the same millisecond (e.g. late-logging identical drinks over 0 h)
    // would hit the natural-key constraint; nudge it by a millisecond instead.
    for (let t = opts.at ?? this.deps.now(); ; t += 1) {
      const row = insert.get(userId, mg, description, t, opts.productId ?? null) as DrinkRow | null;
      if (row) return toDrink(row);
    }
  }

  /**
   * Logs forgotten drinks spread evenly over the last `hours`, oldest first, the same way
   * the original drinkBoozeLate did (first drink `hours` ago, last one now).
   */
  addLate(userId: string, drinks: readonly LateDrink[], hours: number) {
    const now = this.deps.now();
    const step = hours / Math.max(drinks.length - 1, 1);
    this.deps.db.transaction(() => {
      drinks.forEach((d, i) => this.add(userId, d.mg, d.description, { at: Math.round(now - (hours - step * i) * HOUR_MS) }));
    })();
  }

  last(userId: string): Drink | null {
    const row = this.deps.db
      .query("SELECT * FROM drinks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(userId) as DrinkRow | null;
    return row ? toDrink(row) : null;
  }

  get(userId: string, drinkId: number): Drink | null {
    const row = this.deps.db
      .query("SELECT * FROM drinks WHERE user_id = ? AND id = ?")
      .get(userId, drinkId) as DrinkRow | null;
    return row ? toDrink(row) : null;
  }

  /** Deletes the most recent drink. Returns it, or null if there was none. */
  undoLast(userId: string): Drink | null {
    const last = this.last(userId);
    if (last) this.deps.db.query("DELETE FROM drinks WHERE id = ?").run(last.id);
    return last;
  }

  /** Drinks since `sinceMs`, ascending. */
  since(userId: string, sinceMs: number): Drink[] {
    return (
      this.deps.db
        .query("SELECT * FROM drinks WHERE user_id = ? AND created_at > ? ORDER BY created_at, id")
        .all(userId, sinceMs) as DrinkRow[]
    ).map(toDrink);
  }

  /** Latest `n` drinks with distinct descriptions, newest first (quick buttons). */
  recentUnique(userId: string, n: number, excludeDescriptionPrefix?: string): Drink[] {
    return (
      this.deps.db
        .query(
          `SELECT d.* FROM drinks d
           JOIN (SELECT description, max(created_at) AS latest FROM drinks
                 WHERE user_id = ?1 AND (?2 IS NULL OR substr(description, 1, length(?2)) != ?2)
                 GROUP BY description) u
             ON d.description = u.description AND d.created_at = u.latest
           WHERE d.user_id = ?1
           ORDER BY d.created_at DESC LIMIT ?3`,
        )
        .all(userId, excludeDescriptionPrefix ?? null, n) as DrinkRow[]
    ).map(toDrink);
  }

  /** Catalogue products the user logged most recently, newest first. */
  recentProductIds(userId: string, n: number): string[] {
    return (
      this.deps.db
        .query(
          `SELECT product_id FROM drinks WHERE user_id = ? AND product_id IS NOT NULL
           GROUP BY product_id ORDER BY max(created_at) DESC LIMIT ?`,
        )
        .all(userId, n) as { product_id: string }[]
    ).map((r) => r.product_id);
  }

  ebacFor(profile: Profile, now = this.deps.now()): Ebac {
    return calculateEbac(profile, this.since(profile.id, now - EBAC_WINDOW_MS), now);
  }

  ebac(userId: string): Ebac {
    const profile = this.accounts.get(userId);
    return profile ? this.ebacFor(profile) : calculateEbac({ weight: 80, height: 175, gender: "mies" }, []);
  }

  /** Total consumption over the last `days` (or all time). */
  consumption(userId: string, days?: number) {
    const now = this.deps.now();
    const since = days ? now - days * DAY_MS : 0;
    const row = this.deps.db
      .query(
        "SELECT coalesce(sum(alcohol_mg), 0) AS mg, min(created_at) AS first, count(*) AS count FROM drinks WHERE user_id = ? AND created_at > ?",
      )
      .get(userId, since) as { mg: number; first: number | null; count: number };
    const dayCount = days ?? Math.max(1, Math.ceil((now - (row.first ?? now)) / DAY_MS));
    return { grams: row.mg / 1000, count: row.count, dayCount: Math.max(1, dayCount) };
  }
}
