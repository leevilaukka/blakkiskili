import { calculateEbac, type BodyProfile, type DrinkSample, type Gender } from "../lib/alcomath.ts";
import { legacyHash } from "../lib/ids.ts";
import { HOUR_MS, STANDARD_DRINK_GRAMS } from "../lib/units.ts";
import { EBAC_WINDOW_MS } from "./drinks.ts";
import { ChangeBus } from "./changebus.ts";
import type { Deps } from "./index.ts";
import type { ChartName } from "./accounts.ts";

export interface GroupMemberStatus {
  userId: string;
  name: string;
  permilles: number;
  standardDrinks: number; // unburned alcohol, in standard drinks
  std12h: number; // consumed in the last 12h, in standard drinks
  std24h: number;
}

export interface MemberHistory {
  userId: string;
  name: string;
  /** Telegram first + last name for charts; null until the user next uses the bot. */
  fullName: string | null;
  chartName: ChartName;
  body: BodyProfile;
  drinks: DrinkSample[];
}

export class Groups {
  constructor(
    private readonly deps: Deps,
    private readonly bus = new ChangeBus(),
  ) {}

  private ensureGroup(groupId: string) {
    this.deps.db
      .query("INSERT OR IGNORE INTO groups (id, created_at) VALUES (?, ?)")
      .run(groupId, this.deps.now());
  }

  join(userId: string, chatId: number) {
    const groupId = this.deps.crypto.groupKey(chatId);
    this.ensureGroup(groupId);
    this.deps.db
      .query("INSERT OR IGNORE INTO group_members (user_id, group_id, joined_at) VALUES (?, ?, ?)")
      .run(userId, groupId, this.deps.now());
    this.bus.emit({ accountId: userId, groupId });
  }

  leave(userId: string, chatId: number) {
    const groupId = this.deps.crypto.groupKey(chatId);
    this.deps.db.query("DELETE FROM group_members WHERE user_id = ? AND group_id = ?").run(userId, groupId);
    // Also forget an imported membership so the user isn't re-added automatically.
    this.deps.db
      .query("DELETE FROM legacy_group_memberships WHERE user_id = ? AND legacy_group_id = ?")
      .run(userId, legacyHash(chatId));
    this.bus.emit({ accountId: userId, groupId });
  }

  isMember(userId: string, chatId: number): boolean {
    return !!this.deps.db
      .query("SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ?")
      .get(userId, this.deps.crypto.groupKey(chatId));
  }

  /**
   * Turns memberships imported from the original bot's groups.csv into real memberships
   * of this chat. Returns how many users were added.
   */
  adoptLegacyMembers(chatId: number): number {
    const legacyId = legacyHash(chatId);
    const rows = this.deps.db
      .query("SELECT user_id FROM legacy_group_memberships WHERE legacy_group_id = ?")
      .all(legacyId) as { user_id: string }[];
    if (rows.length === 0) return 0;
    this.deps.db.transaction(() => {
      for (const r of rows) this.join(r.user_id, chatId);
      this.deps.db.query("DELETE FROM legacy_group_memberships WHERE legacy_group_id = ?").run(legacyId);
    })();
    return rows.length;
  }

  /** Members who have drunk within the estimate window, with their recent drinks (ascending). */
  memberHistories(chatId: number, windowMs = EBAC_WINDOW_MS): MemberHistory[] {
    const now = this.deps.now();
    const rows = this.deps.db
      .query(
        `SELECT u.id, u.name_enc, u.full_name_enc, u.chart_name, u.weight, u.height, u.gender, d.alcohol_mg, d.created_at
         FROM group_members m
         JOIN users u ON u.id = m.user_id
         JOIN drinks d ON d.user_id = u.id AND d.created_at > ?
         WHERE m.group_id = ?
         ORDER BY u.id, d.created_at, d.id`,
      )
      .all(now - windowMs, this.deps.crypto.groupKey(chatId)) as {
      id: string;
      name_enc: string;
      full_name_enc: string | null;
      chart_name: ChartName;
      weight: number;
      height: number;
      gender: Gender;
      alcohol_mg: number;
      created_at: number;
    }[];

    const byUser = new Map<string, MemberHistory>();
    for (const r of rows) {
      let entry = byUser.get(r.id);
      if (!entry) {
        entry = {
          userId: r.id,
          name: this.deps.crypto.decrypt(r.name_enc),
          fullName: r.full_name_enc === null ? null : this.deps.crypto.decrypt(r.full_name_enc),
          chartName: r.chart_name,
          body: { weight: r.weight, height: r.height, gender: r.gender },
          drinks: [],
        };
        byUser.set(r.id, entry);
      }
      entry.drinks.push({ alcoholMg: r.alcohol_mg, createdAt: r.created_at });
    }
    return [...byUser.values()];
  }

  /** Current status of every member who has drunk within the estimate window. */
  memberStatuses(chatId: number): GroupMemberStatus[] {
    const now = this.deps.now();
    const sumSince = (drinks: DrinkSample[], ms: number) =>
      drinks.filter((d) => d.createdAt > now - ms).reduce((s, d) => s + d.alcoholMg, 0) / 1000 / STANDARD_DRINK_GRAMS;

    return this.memberHistories(chatId).map((m) => {
      const ebac = calculateEbac(m.body, m.drinks, now);
      return {
        userId: m.userId,
        name: m.name,
        permilles: ebac.permilles,
        standardDrinks: ebac.grams / STANDARD_DRINK_GRAMS,
        std12h: sumSince(m.drinks, 12 * HOUR_MS),
        std24h: sumSince(m.drinks, 24 * HOUR_MS),
      };
    });
  }
}
