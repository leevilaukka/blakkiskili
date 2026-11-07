import { randomBytes } from "node:crypto";
import type { Gender } from "../lib/alcomath.ts";
import { legacyHash } from "../lib/ids.ts";
import { toCsv } from "../lib/csv.ts";
import { ChangeBus } from "./changebus.ts";
import type { Deps } from "./index.ts";
import type { Identities, IdentityRef } from "./identities.ts";

export type ChartName = "full" | "username";

export interface Profile {
  id: string;
  name: string;
  /** Telegram first + last name, as shown in charts; null until refreshed. */
  fullName: string | null;
  /** Which name charts show: the Telegram full name (default, like the original bot) or the username. */
  chartName: ChartName;
  weight: number;
  height: number;
  gender: Gender;
  acceptedTerms: boolean;
  createdAt: number;
  announcementsSeenAt: number;
}

interface UserRow {
  id: string;
  name_enc: string;
  full_name_enc: string | null;
  chart_name: ChartName;
  weight: number;
  height: number;
  gender: Gender;
  accepted_terms_at: number | null;
  created_at: number;
  announcements_seen_at: number;
}

export const LIMITS = {
  weight: { min: 20, max: 250 },
  height: { min: 120, max: 240 },
} as const;

export const isValidWeight = (w: number) =>
  Number.isInteger(w) && w >= LIMITS.weight.min && w <= LIMITS.weight.max;
export const isValidHeight = (h: number) =>
  Number.isInteger(h) && h >= LIMITS.height.min && h <= LIMITS.height.max;
export const isGender = (g: string): g is Gender => g === "mies" || g === "nainen";

export interface NewProfile {
  name: string;
  fullName?: string;
  weight: number;
  height: number;
  gender: Gender;
  createdAt?: number;
}

export class Accounts {
  constructor(
    private readonly deps: Deps,
    private readonly identities: Identities,
    private readonly bus = new ChangeBus(),
  ) {}

  private toProfile(row: UserRow): Profile {
    return {
      id: row.id,
      name: this.deps.crypto.decrypt(row.name_enc),
      fullName: row.full_name_enc === null ? null : this.deps.crypto.decrypt(row.full_name_enc),
      chartName: row.chart_name,
      weight: row.weight,
      height: row.height,
      gender: row.gender,
      acceptedTerms: row.accepted_terms_at !== null,
      createdAt: row.created_at,
      announcementsSeenAt: row.announcements_seen_at,
    };
  }

  get(userId: string): Profile | null {
    const row = this.deps.db.query("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | null;
    return row ? this.toProfile(row) : null;
  }

  /** The account a platform login belongs to. */
  byIdentity(identityId: string): Profile | null {
    const row = this.deps.db
      .query("SELECT u.* FROM users u JOIN identities i ON i.account_id = u.id WHERE i.id = ?")
      .get(identityId) as UserRow | null;
    return row ? this.toProfile(row) : null;
  }

  /**
   * Registration from a platform: updates the account the login belongs to, or creates a new
   * account (with a random id) and links the login to it. Accepts terms.
   */
  register(ref: IdentityRef, p: NewProfile): { created: boolean; profile: Profile } {
    return this.deps.db.transaction(() => {
      const existing = this.identities.accountOf(this.identities.key(ref));
      if (existing) {
        this.identities.ensureContact(ref);
        return this.upsert(existing, p);
      }
      const accountId = randomBytes(16).toString("hex");
      const result = this.upsert(accountId, p);
      this.identities.attach(accountId, ref);
      return result;
    })();
  }

  /** Creates the account, or updates body data of an existing one, by account id. Accepts terms. */
  upsert(userId: string, p: NewProfile): { created: boolean; profile: Profile } {
    const now = this.deps.now();
    const existing = this.get(userId);
    const nameEnc = this.deps.crypto.encrypt(p.name);
    const fullNameEnc = p.fullName ? this.deps.crypto.encrypt(p.fullName) : null;
    if (existing) {
      this.deps.db
        .query(
          `UPDATE users SET name_enc = ?, full_name_enc = coalesce(?, full_name_enc), weight = ?, height = ?, gender = ?,
             accepted_terms_at = coalesce(accepted_terms_at, ?),
             created_at = min(created_at, ?),
             last_active_at = ?, inactivity_warned_at = NULL
           WHERE id = ?`,
        )
        .run(nameEnc, fullNameEnc, p.weight, p.height, p.gender, now, p.createdAt ?? existing.createdAt, now, userId);
    } else {
      this.deps.db
        .query(
          `INSERT INTO users (id, name_enc, full_name_enc, weight, height, gender, accepted_terms_at, created_at, last_active_at, announcements_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        // New accounts don't get the backlog of old announcements.
        .run(userId, nameEnc, fullNameEnc, p.weight, p.height, p.gender, now, p.createdAt ?? now, now, now);
    }
    return { created: !existing, profile: this.get(userId)! };
  }

  /**
   * Records that the user used the bot (from any platform): resets the inactivity clock and
   * cancels a pending deletion warning. Writes at most about once an hour per user.
   */
  touch(userId: string) {
    const now = this.deps.now();
    this.deps.db
      .query(
        `UPDATE users SET last_active_at = ?1, inactivity_warned_at = NULL
         WHERE id = ?2 AND (last_active_at < ?1 - 3600000 OR inactivity_warned_at IS NOT NULL)`,
      )
      .run(now, userId);
  }

  updateWeight(userId: string, weight: number) {
    this.deps.db.query("UPDATE users SET weight = ? WHERE id = ?").run(weight, userId);
    this.bus.emit({ accountId: userId });
  }

  updateHeight(userId: string, height: number) {
    this.deps.db.query("UPDATE users SET height = ? WHERE id = ?").run(height, userId);
    this.bus.emit({ accountId: userId });
  }

  updateGender(userId: string, gender: Gender) {
    this.deps.db.query("UPDATE users SET gender = ? WHERE id = ?").run(gender, userId);
    this.bus.emit({ accountId: userId });
  }

  updateChartName(userId: string, chartName: ChartName) {
    this.deps.db.query("UPDATE users SET chart_name = ? WHERE id = ?").run(chartName, userId);
    this.bus.emit({ accountId: userId });
  }

  updateName(userId: string, name: string, fullName?: string) {
    const enc = (s: string) => this.deps.crypto.encrypt(s);
    this.deps.db
      .query("UPDATE users SET name_enc = ?, full_name_enc = coalesce(?, full_name_enc) WHERE id = ?")
      .run(enc(name), fullName ? enc(fullName) : null, userId);
    this.bus.emit({ accountId: userId });
  }

  /** Deletes the user and, through ON DELETE CASCADE, all drinks, memberships and logins. */
  delete(userId: string) {
    this.deps.db.transaction(() => {
      this.deps.db
        .query("DELETE FROM pending WHERE user_id = ?1 OR user_id IN (SELECT id FROM identities WHERE account_id = ?1)")
        .run(userId);
      this.deps.db.query("DELETE FROM users WHERE id = ?").run(userId);
    })();
    this.bus.emit({ accountId: userId });
  }

  /**
   * Everything stored about the user, as CSV files in the same format as the original
   * bot's /data. `userid` is the legacy sha256 so the files can be re-imported with /tuo.
   */
  exportCsv(userId: string, telegramUserId: number): { filename: string; csv: string }[] | null {
    const profile = this.get(userId);
    if (!profile) return null;
    const legacyId = legacyHash(telegramUserId);
    const drinks = this.deps.db
      .query("SELECT id, alcohol_mg, description, created_at, product_id, kcal FROM drinks WHERE user_id = ? ORDER BY created_at")
      .all(userId) as {
      id: number;
      alcohol_mg: number;
      description: string;
      created_at: number;
      product_id: string | null;
      kcal: number | null;
    }[];
    const groups = this.deps.db
      .query("SELECT group_id FROM group_members WHERE user_id = ?")
      .all(userId) as { group_id: string }[];

    return [
      {
        filename: "user.csv",
        csv: toCsv(
          ["userid", "nick", "weight", "gender", "height", "read_terms", "read_announcements", "created"],
          [
            {
              userid: legacyId,
              nick: profile.name,
              weight: profile.weight,
              gender: profile.gender,
              height: profile.height,
              read_terms: profile.acceptedTerms,
              read_announcements: 0,
              created: new Date(profile.createdAt),
            },
          ],
        ),
      },
      {
        filename: "drinks.csv",
        csv: toCsv(
          ["id", "userid", "alcohol", "description", "created", "product_id", "kcal"],
          drinks.map((d) => ({
            id: d.id,
            userid: legacyId,
            alcohol: d.alcohol_mg,
            description: d.description,
            created: new Date(d.created_at),
            product_id: d.product_id,
            kcal: d.kcal,
          })),
        ),
      },
      {
        filename: "groups.csv",
        csv: toCsv(
          ["userid", "groupid"],
          // Prefixed so a re-import doesn't mistake these HMACs for original-bot group hashes.
          groups.map((g) => ({ userid: legacyId, groupid: `v2:${g.group_id}` })),
        ),
      },
    ];
  }
}

/** The name a chart shows for this account, per their choice. */
export function chartLabel(p: { name: string; fullName: string | null; chartName: ChartName }): string {
  return p.chartName === "username" ? p.name : (p.fullName ?? p.name);
}
