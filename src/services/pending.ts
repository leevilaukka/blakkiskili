// Multi-step input state ("the next text message is a weight"), persisted in SQLite so a
// restart mid-flow doesn't lose it. One flow per user at a time.

import type { Gender } from "../lib/alcomath.ts";
import { DAY_MS } from "../lib/units.ts";
import type { Deps } from "./index.ts";

export type PendingState =
  | { kind: "register"; step: "weight" | "height" | "gender" | "terms"; weight?: number; height?: number; gender?: Gender }
  | { kind: "customDrink" }
  | { kind: "late"; hours?: number; drinks: { cl: number; vol: number }[] }
  | { kind: "editWeight" }
  | { kind: "editHeight" }
  | { kind: "consumptionDays" }
  | { kind: "productSearch" }
  | { kind: "productAmount"; drinkId: string }
  | { kind: "import"; step: "terms" | "files"; waitingDrinkFiles?: string[] };

const TTL_MS = DAY_MS;

export class Pending {
  constructor(private readonly deps: Deps) {}

  get(userId: string): PendingState | null {
    const row = this.deps.db
      .query("SELECT state, updated_at FROM pending WHERE user_id = ?")
      .get(userId) as { state: string; updated_at: number } | null;
    if (!row) return null;
    if (row.updated_at < this.deps.now() - TTL_MS) {
      this.clear(userId);
      return null;
    }
    return JSON.parse(row.state) as PendingState;
  }

  set(userId: string, state: PendingState) {
    this.deps.db
      .query(
        `INSERT INTO pending (user_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(state), this.deps.now());
  }

  clear(userId: string) {
    this.deps.db.query("DELETE FROM pending WHERE user_id = ?").run(userId);
  }
}
