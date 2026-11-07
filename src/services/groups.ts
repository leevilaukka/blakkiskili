import { randomBytes } from "node:crypto";
import { calculateEbac, type BodyProfile, type DrinkSample, type Gender } from "../lib/alcomath.ts";
import { legacyHash } from "../lib/ids.ts";
import { DAY_MS, HOUR_MS, STANDARD_DRINK_GRAMS } from "../lib/units.ts";
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

export const MAX_WEB_GROUPS_PER_OWNER = 10;
export const MAX_WEB_GROUP_MEMBERS = 100;
export const GROUP_NAME_MAX = 40;
export const INVITE_TTL_MS = 7 * DAY_MS;

export type GroupKind = "telegram" | "web";

export interface GroupInfo {
  id: string;
  /** Null for Telegram groups until someone says /moro in the chat after names were introduced. */
  name: string | null;
  kind: GroupKind;
  createdAt: number;
  memberCount: number;
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

/** A member of a group, whether or not they have drunk recently. */
export interface Member extends MemberHistory {
  joinedAt: number;
  hideOnScreen: boolean;
}

/** "  Kaverit\n 2026 " → "Kaverit 2026"; null when empty or too long. */
export function cleanGroupName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\p{C}\s]+/gu, " ").trim();
  return name.length >= 1 && [...name].length <= GROUP_NAME_MAX ? name : null;
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

  private encryptName(name: string) {
    return this.deps.crypto.encrypt(name);
  }

  // ---------- Telegram chats (the bot) ----------

  /** `title` is the chat's title; it becomes the group's name on the website. */
  join(userId: string, chatId: number, title?: string) {
    const groupId = this.deps.crypto.groupKey(chatId);
    this.ensureGroup(groupId);
    this.deps.db
      .query("INSERT OR IGNORE INTO group_members (user_id, group_id, joined_at) VALUES (?, ?, ?)")
      .run(userId, groupId, this.deps.now());
    const name = cleanGroupName(title);
    if (name) this.deps.db.query("UPDATE groups SET name_enc = ? WHERE id = ? AND kind = 'telegram'").run(this.encryptName(name), groupId);
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
    return this.isMemberOf(userId, this.deps.crypto.groupKey(chatId));
  }

  // ---------- by group id (the website) ----------

  isMemberOf(accountId: string, groupId: string): boolean {
    return !!this.deps.db.query("SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ?").get(accountId, groupId);
  }

  private info(row: { id: string; name_enc: string | null; kind: GroupKind; created_at: number; members: number }): GroupInfo {
    return {
      id: row.id,
      name: row.name_enc === null ? null : this.deps.crypto.decrypt(row.name_enc),
      kind: row.kind,
      createdAt: row.created_at,
      memberCount: row.members,
    };
  }

  get(groupId: string): GroupInfo | null {
    const row = this.deps.db
      .query(
        `SELECT g.id, g.name_enc, g.kind, g.created_at, (SELECT count(*) FROM group_members WHERE group_id = g.id) AS members
         FROM groups g WHERE g.id = ?`,
      )
      .get(groupId) as Parameters<Groups["info"]>[0] | null;
    return row ? this.info(row) : null;
  }

  /** The account's groups, newest membership first, with whether they hide on shared screens. */
  listFor(accountId: string): (GroupInfo & { hideOnScreen: boolean })[] {
    const rows = this.deps.db
      .query(
        `SELECT g.id, g.name_enc, g.kind, g.created_at, m.hide_on_screen,
                (SELECT count(*) FROM group_members WHERE group_id = g.id) AS members
         FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = ? ORDER BY m.joined_at DESC, g.id`,
      )
      .all(accountId) as (Parameters<Groups["info"]>[0] & { hide_on_screen: number })[];
    return rows.map((r) => ({ ...this.info(r), hideOnScreen: r.hide_on_screen === 1 }));
  }

  groupIdsOf(accountId: string): string[] {
    return (this.deps.db.query("SELECT group_id FROM group_members WHERE user_id = ?").all(accountId) as { group_id: string }[]).map((r) => r.group_id);
  }

  /**
   * Who may rename, remove members, delete and rotate the invite: the creator of a web group, or
   * the earliest member when the creator's account is gone. Telegram groups have no owner.
   */
  ownerOf(groupId: string): string | null {
    const row = this.deps.db
      .query(
        `SELECT g.kind, g.owner_id,
                (SELECT user_id FROM group_members WHERE group_id = g.id ORDER BY joined_at, rowid LIMIT 1) AS earliest
         FROM groups g WHERE g.id = ?`,
      )
      .get(groupId) as { kind: GroupKind; owner_id: string | null; earliest: string | null } | null;
    if (!row || row.kind !== "web") return null;
    return row.owner_id ?? row.earliest;
  }

  /** Makes a web group with `ownerId` as its first member, or "limit" when they own too many. */
  createWeb(ownerId: string, name: string): GroupInfo | "limit" {
    const clean = cleanGroupName(name);
    if (!clean) throw new Error("invalid group name");
    const owned = this.deps.db.query("SELECT count(*) AS n FROM groups WHERE kind = 'web' AND owner_id = ?").get(ownerId) as { n: number };
    if (owned.n >= MAX_WEB_GROUPS_PER_OWNER) return "limit";
    const id = randomBytes(16).toString("hex");
    const now = this.deps.now();
    this.deps.db.transaction(() => {
      this.deps.db
        .query("INSERT INTO groups (id, created_at, name_enc, kind, owner_id) VALUES (?, ?, ?, 'web', ?)")
        .run(id, now, this.encryptName(clean), ownerId);
      this.deps.db.query("INSERT INTO group_members (user_id, group_id, joined_at) VALUES (?, ?, ?)").run(ownerId, id, now);
    })();
    this.bus.emit({ accountId: ownerId, groupId: id });
    return this.get(id)!;
  }

  rename(groupId: string, name: string): boolean {
    const clean = cleanGroupName(name);
    if (!clean) return false;
    const changed = this.deps.db.query("UPDATE groups SET name_enc = ? WHERE id = ? AND kind = 'web'").run(this.encryptName(clean), groupId).changes > 0;
    if (changed) this.bus.emit({ groupId });
    return changed;
  }

  /** Takes the account out of the group. An emptied web group is deleted with its links. */
  leaveGroup(accountId: string, groupId: string): boolean {
    const left = this.deps.db.query("DELETE FROM group_members WHERE user_id = ? AND group_id = ?").run(accountId, groupId).changes > 0;
    if (!left) return false;
    this.deps.db.query("DELETE FROM groups WHERE id = ? AND kind = 'web' AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = ?1)").run(groupId);
    this.bus.emit({ accountId, groupId });
    return true;
  }

  /** The members' accounts are told (so their pages drop the group) before it is deleted. */
  deleteWeb(groupId: string): boolean {
    const members = this.deps.db.query("SELECT user_id FROM group_members WHERE group_id = ?").all(groupId) as { user_id: string }[];
    const deleted = this.deps.db.query("DELETE FROM groups WHERE id = ? AND kind = 'web'").run(groupId).changes > 0;
    if (deleted) {
      this.bus.emit({ groupId });
      for (const m of members) this.bus.emit({ accountId: m.user_id, groupId });
    }
    return deleted;
  }

  setHidden(accountId: string, groupId: string, hidden: boolean): boolean {
    const changed = this.deps.db
      .query("UPDATE group_members SET hide_on_screen = ? WHERE user_id = ? AND group_id = ?")
      .run(hidden ? 1 : 0, accountId, groupId).changes > 0;
    if (changed) this.bus.emit({ accountId, groupId });
    return changed;
  }

  /** Every member of the group with the drinks they logged within `windowMs`. */
  members(groupId: string, windowMs = EBAC_WINDOW_MS): Member[] {
    const now = this.deps.now();
    const rows = this.deps.db
      .query(
        `SELECT u.id, u.name_enc, u.full_name_enc, u.chart_name, u.weight, u.height, u.gender,
                m.joined_at, m.hide_on_screen, d.alcohol_mg, d.created_at
         FROM group_members m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN drinks d ON d.user_id = u.id AND d.created_at > ?
         WHERE m.group_id = ?
         ORDER BY u.id, d.created_at, d.id`,
      )
      .all(now - windowMs, groupId) as {
      id: string;
      name_enc: string;
      full_name_enc: string | null;
      chart_name: ChartName;
      weight: number;
      height: number;
      gender: Gender;
      joined_at: number;
      hide_on_screen: number;
      alcohol_mg: number | null;
      created_at: number | null;
    }[];

    const byUser = new Map<string, Member>();
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
          joinedAt: r.joined_at,
          hideOnScreen: r.hide_on_screen === 1,
        };
        byUser.set(r.id, entry);
      }
      if (r.alcohol_mg !== null && r.created_at !== null) entry.drinks.push({ alcoholMg: r.alcohol_mg, createdAt: r.created_at });
    }
    return [...byUser.values()];
  }

  // ---------- invites (web groups) ----------

  /** A new invite code for the group; replaces the previous one. Only its hash is stored. */
  createInvite(groupId: string, createdBy: string): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString("base64url");
    const expiresAt = this.deps.now() + INVITE_TTL_MS;
    this.deps.db.transaction(() => {
      this.deps.db.query("DELETE FROM group_invites WHERE group_id = ?").run(groupId);
      this.deps.db
        .query("INSERT INTO group_invites (code_hash, group_id, created_by, expires_at) VALUES (?, ?, ?, ?)")
        .run(this.deps.crypto.webTokenKey(code), groupId, createdBy, expiresAt);
    })();
    return { code, expiresAt };
  }

  revokeInvite(groupId: string) {
    this.deps.db.query("DELETE FROM group_invites WHERE group_id = ?").run(groupId);
  }

  hasInvite(groupId: string): number | null {
    const row = this.deps.db.query("SELECT expires_at FROM group_invites WHERE group_id = ? AND expires_at > ?").get(groupId, this.deps.now()) as
      | { expires_at: number }
      | null;
    return row?.expires_at ?? null;
  }

  redeemInvite(code: string, accountId: string): { ok: true; groupId: string } | { ok: false; reason: "invalid" | "already_member" | "full" } {
    const row = this.deps.db
      .query("SELECT group_id, expires_at FROM group_invites WHERE code_hash = ?")
      .get(this.deps.crypto.webTokenKey(code)) as { group_id: string; expires_at: number } | null;
    if (!row || row.expires_at <= this.deps.now()) return { ok: false, reason: "invalid" };
    if (this.isMemberOf(accountId, row.group_id)) return { ok: false, reason: "already_member" };
    const count = this.deps.db.query("SELECT count(*) AS n FROM group_members WHERE group_id = ?").get(row.group_id) as { n: number };
    if (count.n >= MAX_WEB_GROUP_MEMBERS) return { ok: false, reason: "full" };
    this.deps.db.query("INSERT INTO group_members (user_id, group_id, joined_at) VALUES (?, ?, ?)").run(accountId, row.group_id, this.deps.now());
    this.bus.emit({ accountId, groupId: row.group_id });
    return { ok: true, groupId: row.group_id };
  }

  /** Deletes expired invites and web groups nobody belongs to any more. */
  prune(): number {
    const now = this.deps.now();
    const a = this.deps.db.query("DELETE FROM group_invites WHERE expires_at <= ?").run(now).changes;
    const b = this.deps.db
      .query("DELETE FROM groups WHERE kind = 'web' AND NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = groups.id)")
      .run().changes;
    return a + b;
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
    return this.members(this.deps.crypto.groupKey(chatId), windowMs).filter((m) => m.drinks.length > 0);
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
