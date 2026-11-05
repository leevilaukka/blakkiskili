// Deletes accounts that haven't used the bot for `deleteAfterDays`, after warning them by
// private message `warnDaysBefore` days earlier. Any use of the bot (Accounts.touch) resets
// the clock and cancels the warning.

import { DAY_MS } from "../lib/units.ts";
import type { Accounts } from "./accounts.ts";
import type { Deps } from "./index.ts";

export interface InactivityPolicy {
  deleteAfterDays: number; // 0 disables warnings and deletion
  warnDaysBefore: number;
}

export interface WarningTarget {
  userId: string;
  telegramId: number;
}

export class Inactivity {
  constructor(
    private readonly deps: Deps,
    private readonly accounts: Accounts,
  ) {}

  /** Inactive users who should be warned now and haven't been yet. */
  dueForWarning(policy: InactivityPolicy): WarningTarget[] {
    if (policy.deleteAfterDays <= 0) return [];
    const cutoff = this.deps.now() - (policy.deleteAfterDays - policy.warnDaysBefore) * DAY_MS;
    const rows = this.deps.db
      .query(
        `SELECT id, tg_id_enc FROM users
         WHERE last_active_at < ? AND inactivity_warned_at IS NULL AND tg_id_enc IS NOT NULL`,
      )
      .all(cutoff) as { id: string; tg_id_enc: string }[];
    return rows.map((r) => ({ userId: r.id, telegramId: Number(this.deps.crypto.decrypt(r.tg_id_enc)) }));
  }

  /** Call after the warning was delivered, or when it can never be (bot blocked, account gone). */
  markWarned(userId: string) {
    this.deps.db.query("UPDATE users SET inactivity_warned_at = ? WHERE id = ?").run(this.deps.now(), userId);
  }

  /**
   * Deletes accounts inactive for `deleteAfterDays` whose warning went out at least
   * `warnDaysBefore` days ago. Accounts with no stored Telegram id can't be warned and are
   * deleted once inactive. Returns the number of deleted accounts.
   */
  purge(policy: InactivityPolicy): number {
    if (policy.deleteAfterDays <= 0) return 0;
    const now = this.deps.now();
    const rows = this.deps.db
      .query(
        `SELECT id FROM users
         WHERE last_active_at < ?
           AND (tg_id_enc IS NULL OR (inactivity_warned_at IS NOT NULL AND inactivity_warned_at <= ?))`,
      )
      .all(now - policy.deleteAfterDays * DAY_MS, now - policy.warnDaysBefore * DAY_MS) as { id: string }[];
    for (const r of rows) this.accounts.delete(r.id);
    return rows.length;
  }
}
