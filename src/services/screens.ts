// Read-only links for event screens (a TV or projector): they show one group's, or one person's,
// live chart to anyone who has the link, without signing in. The link is the credential, so it
// is long and random, only its hash is stored, it expires, and it can be revoked at any time
// (which deletes it, ending open screens within a second).

import { randomBytes } from "node:crypto";
import { DAY_MS, HOUR_MS } from "../lib/units.ts";
import { ChangeBus } from "./changebus.ts";
import type { Deps } from "./index.ts";

export const SCREEN_DEFAULT_TTL_MS = 24 * HOUR_MS;
export const SCREEN_MAX_TTL_MS = 7 * DAY_MS;
export const MAX_SCREENS_PER_TARGET = 5;

export type ScreenTarget = { groupId: string } | { accountId: string };

export interface ScreenAccess {
  /** Hash of the token: names the screen's live channel and its cookie lookups. */
  hash: string;
  groupId: string | null;
  accountId: string | null;
  expiresAt: number;
}

export interface ScreenLink {
  /** Public handle to revoke it by (a prefix of the hash; not enough to use the link). */
  ref: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

const REF_LENGTH = 16;

export class Screens {
  constructor(
    private readonly deps: Deps,
    private readonly bus = new ChangeBus(),
  ) {}

  /** A new link for the target, or "limit" when it already has the maximum number of live ones. */
  create(target: ScreenTarget, createdBy: string, ttlMs = SCREEN_DEFAULT_TTL_MS): { token: string; expiresAt: number } | "limit" {
    const now = this.deps.now();
    const [column, id] = "groupId" in target ? ["group_id", target.groupId] : ["account_id", target.accountId];
    const live = this.deps.db.query(`SELECT count(*) AS n FROM screen_tokens WHERE ${column} = ? AND expires_at > ?`).get(id, now) as { n: number };
    if (live.n >= MAX_SCREENS_PER_TARGET) return "limit";
    const ttl = Math.min(Math.max(ttlMs, HOUR_MS), SCREEN_MAX_TTL_MS);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + ttl;
    this.deps.db
      .query(`INSERT INTO screen_tokens (token_hash, ${column}, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(this.deps.crypto.webTokenKey(token), id, createdBy, now, expiresAt);
    return { token, expiresAt };
  }

  /** What a token gives access to, or null when it is unknown, expired or revoked. */
  authenticate(token: string): ScreenAccess | null {
    return this.byHash(this.deps.crypto.webTokenKey(token));
  }

  byHash(hash: string): ScreenAccess | null {
    const row = this.deps.db
      .query("SELECT group_id, account_id, expires_at FROM screen_tokens WHERE token_hash = ? AND expires_at > ?")
      .get(hash, this.deps.now()) as { group_id: string | null; account_id: string | null; expires_at: number } | null;
    return row ? { hash, groupId: row.group_id, accountId: row.account_id, expiresAt: row.expires_at } : null;
  }

  /** The hashes of the live links of a group or account (to wake their screens up). */
  hashesFor(target: ScreenTarget): string[] {
    const [column, id] = "groupId" in target ? ["group_id", target.groupId] : ["account_id", target.accountId];
    return (
      this.deps.db.query(`SELECT token_hash FROM screen_tokens WHERE ${column} = ? AND expires_at > ?`).all(id, this.deps.now()) as { token_hash: string }[]
    ).map((r) => r.token_hash);
  }

  list(target: ScreenTarget): ScreenLink[] {
    const [column, id] = "groupId" in target ? ["group_id", target.groupId] : ["account_id", target.accountId];
    return (
      this.deps.db
        .query(`SELECT token_hash, created_by, created_at, expires_at FROM screen_tokens WHERE ${column} = ? AND expires_at > ? ORDER BY created_at, rowid`)
        .all(id, this.deps.now()) as { token_hash: string; created_by: string; created_at: number; expires_at: number }[]
    ).map((r) => ({ ref: r.token_hash.slice(0, REF_LENGTH), createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at }));
  }

  /** Revokes one link of the target by its ref. The open screens are told to stop. */
  revoke(target: ScreenTarget, ref: string): boolean {
    if (!/^[0-9a-f]{16}$/.test(ref)) return false;
    const [column, id] = "groupId" in target ? ["group_id", target.groupId] : ["account_id", target.accountId];
    const hash = (
      this.deps.db.query(`SELECT token_hash FROM screen_tokens WHERE ${column} = ? AND substr(token_hash, 1, ${REF_LENGTH}) = ?`).get(id, ref) as
        | { token_hash: string }
        | null
    )?.token_hash;
    if (!hash) return false;
    this.deps.db.query("DELETE FROM screen_tokens WHERE token_hash = ?").run(hash);
    this.bus.emit({ screenHash: hash });
    return true;
  }

  prune(): number {
    return this.deps.db.query("DELETE FROM screen_tokens WHERE expires_at <= ?").run(this.deps.now()).changes;
  }
}
