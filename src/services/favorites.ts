import type { Deps } from "./index.ts";
import type { Drink } from "./drinks.ts";

/** A pinned drink: logging it again adds the same amount, description, product and energy. */
export interface Favorite {
  id: number;
  description: string;
  alcoholMg: number;
  productId: string | null;
  kcal: number | null;
}

interface FavoriteRow {
  id: number;
  description: string;
  alcohol_mg: number;
  product_id: string | null;
  kcal: number | null;
}

const toFavorite = (r: FavoriteRow): Favorite => ({
  id: r.id,
  description: r.description,
  alcoholMg: r.alcohol_mg,
  productId: r.product_id,
  kcal: r.kcal,
});

/** Few enough to fit as buttons in the Juo menu. */
export const MAX_FAVORITES = 8;

export type AddFavoriteResult = "added" | "exists" | "full";

export class Favorites {
  constructor(private readonly deps: Deps) {}

  list(userId: string): Favorite[] {
    return (this.deps.db.query("SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at, id").all(userId) as FavoriteRow[]).map(toFavorite);
  }

  get(userId: string, id: number): Favorite | null {
    const row = this.deps.db.query("SELECT * FROM favorites WHERE user_id = ? AND id = ?").get(userId, id) as FavoriteRow | null;
    return row ? toFavorite(row) : null;
  }

  /** Pins a logged drink. The same amount and description is pinned once. */
  add(userId: string, drink: Pick<Drink, "description" | "alcoholMg" | "productId" | "kcal">): AddFavoriteResult {
    return this.deps.db.transaction((): AddFavoriteResult => {
      const { n } = this.deps.db.query("SELECT count(*) AS n FROM favorites WHERE user_id = ?").get(userId) as { n: number };
      const same = this.deps.db
        .query("SELECT 1 FROM favorites WHERE user_id = ? AND description = ? AND alcohol_mg = ?")
        .get(userId, drink.description, drink.alcoholMg);
      if (same) return "exists";
      if (n >= MAX_FAVORITES) return "full";
      this.deps.db
        .query("INSERT INTO favorites (user_id, description, alcohol_mg, product_id, kcal, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(userId, drink.description, drink.alcoholMg, drink.productId, drink.kcal, this.deps.now());
      return "added";
    })();
  }

  remove(userId: string, id: number): boolean {
    return this.deps.db.query("DELETE FROM favorites WHERE user_id = ? AND id = ?").run(userId, id).changes > 0;
  }
}
