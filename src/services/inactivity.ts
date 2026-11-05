// Deletes accounts that haven't used the bot for `deleteAfterDays`, after warning them by
// private message `warnDaysBefore` days earlier. Any use of the bot (Accounts.touch) resets
// the clock and cancels the warning.

import { DAY_MS } from "../lib/units.ts";
import type { Accounts } from "./accounts.ts";
import type { Contact, Identities } from "./identities.ts";
import type { Deps } from "./index.ts";

export interface InactivityPolicy {
  deleteAfterDays: number; // 0 disables warnings and deletion
  warnDaysBefore: number;
}

export interface WarningTarget {
  userId: string;
  /** Where the warning can be sent, oldest login first. Never empty. */
  contacts: Contact[];
}

// An account the owner can be messaged about: one of its logins has a stored contact.
const HAS_CONTACT = "EXISTS (SELECT 1 FROM identities i WHERE i.account_id = users.id AND i.contact_enc IS NOT NULL)";

export class Inactivity {
  constructor(
    private readonly deps: Deps,
    private readonly accounts: Accounts,
    private readonly identities: Identities,
  ) {}

  /** Inactive users who should be warned now and haven't been yet. */
  dueForWarning(policy: InactivityPolicy): WarningTarget[] {
    if (policy.deleteAfterDays <= 0) return [];
    const cutoff = this.deps.now() - (policy.deleteAfterDays - policy.warnDaysBefore) * DAY_MS;
    const rows = this.deps.db
      .query(`SELECT id FROM users WHERE last_active_at < ? AND inactivity_warned_at IS NULL AND ${HAS_CONTACT}`)
      .all(cutoff) as { id: string }[];
    return rows.map((r) => ({ userId: r.id, contacts: this.identities.contacts(r.id) }));
  }

  /** Call after the warning was delivered, or when it can never be (bot blocked, account gone). */
  markWarned(userId: string) {
    this.deps.db.query("UPDATE users SET inactivity_warned_at = ? WHERE id = ?").run(this.deps.now(), userId);
  }

  /**
   * Deletes accounts inactive for `deleteAfterDays` whose warning went out at least
   * `warnDaysBefore` days ago. Accounts with no stored contact can't be warned and are
   * deleted once inactive. Returns the number of deleted accounts.
   */
  purge(policy: InactivityPolicy): number {
    if (policy.deleteAfterDays <= 0) return 0;
    const now = this.deps.now();
    const rows = this.deps.db
      .query(
        `SELECT id FROM users
         WHERE last_active_at < ?
           AND (NOT ${HAS_CONTACT} OR (inactivity_warned_at IS NOT NULL AND inactivity_warned_at <= ?))`,
      )
      .all(now - policy.deleteAfterDays * DAY_MS, now - policy.warnDaysBefore * DAY_MS) as { id: string }[];
    for (const r of rows) this.accounts.delete(r.id);
    return rows.length;
  }
}
