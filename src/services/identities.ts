// Platform logins (identities) and the accounts they belong to.
//
// An account (users row) is the person: body data, drinks, groups. An identity is one login on
// one chat platform, e.g. a Telegram user, pointing at an account. Each account has at least one
// identity and at most one per platform. Another platform is linked with a one-time code: the
// user creates it where they already have the account and sends it with /yhdista on the other
// platform. Accounts are never merged: an identity that already has an account can't be linked
// to a second one.
//
// Raw platform user ids come in only to derive the key and to store an encrypted contact for
// the inactivity warning DM.

import { randomInt } from "node:crypto";
import type { Platform } from "../lib/ids.ts";
import { MINUTE_MS } from "../lib/units.ts";
import type { Deps } from "./index.ts";

export interface IdentityRef {
  platform: Platform;
  platformUserId: string | number;
}

export interface Identity {
  id: string;
  platform: Platform;
  accountId: string;
  createdAt: number;
}

/** Where a message to the account's owner can be sent. */
export interface Contact {
  platform: Platform;
  /** The platform's user id (Telegram: numeric, as a string). */
  address: string;
}

export const LINK_CODE_TTL_MS = 10 * MINUTE_MS;
// Unambiguous when read aloud or typed from another screen: no 0/O, 1/I/L.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export type RedeemResult =
  | { ok: true; accountId: string }
  | {
      ok: false;
      /**
       * invalid: unknown or expired code; already_linked: this identity is already on that
       * account; has_account: this identity has another account; platform_taken: the account
       * already has a login on this platform.
       */
      reason: "invalid" | "already_linked" | "has_account" | "platform_taken";
    };

export type UnlinkResult = "ok" | "last" | "not_linked";

/** "abcd efgh", "ABCD-EFGH" → "ABCDEFGH". */
export function normalizeLinkCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** "ABCDEFGH" → "ABCD-EFGH", easier to read and type. */
export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class Identities {
  constructor(private readonly deps: Deps) {}

  key(ref: IdentityRef): string {
    return this.deps.crypto.identityKey(ref.platform, ref.platformUserId);
  }

  accountOf(identityId: string): string | null {
    const row = this.deps.db.query("SELECT account_id FROM identities WHERE id = ?").get(identityId) as
      | { account_id: string }
      | null;
    return row?.account_id ?? null;
  }

  /** The account's identities, oldest first. */
  list(accountId: string): Identity[] {
    const rows = this.deps.db
      .query("SELECT id, platform, account_id, created_at FROM identities WHERE account_id = ? ORDER BY created_at, rowid")
      .all(accountId) as { id: string; platform: Platform; account_id: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, platform: r.platform, accountId: r.account_id, createdAt: r.created_at }));
  }

  /**
   * Links a new identity to an account. The caller has checked that the identity is free and
   * the account has no identity on that platform; the constraints throw otherwise.
   */
  attach(accountId: string, ref: IdentityRef) {
    this.deps.db
      .query("INSERT INTO identities (id, account_id, platform, contact_enc, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(this.key(ref), accountId, ref.platform, this.encryptContact(ref), this.deps.now());
  }

  /** Stores the encrypted contact if it's missing (identities migrated without one). */
  ensureContact(ref: IdentityRef) {
    this.deps.db
      .query("UPDATE identities SET contact_enc = ? WHERE id = ? AND contact_enc IS NULL")
      .run(this.encryptContact(ref), this.key(ref));
  }

  /** Every place the account's owner can be messaged. */
  contacts(accountId: string): Contact[] {
    const rows = this.deps.db
      .query("SELECT platform, contact_enc FROM identities WHERE account_id = ? AND contact_enc IS NOT NULL ORDER BY created_at, rowid")
      .all(accountId) as { platform: Platform; contact_enc: string }[];
    return rows.map((r) => ({ platform: r.platform, address: this.deps.crypto.decrypt(r.contact_enc) }));
  }

  /** Removes the account's login on `platform`. The last login can't be removed: delete the account instead. */
  unlink(accountId: string, platform: Platform): UnlinkResult {
    return this.deps.db.transaction((): UnlinkResult => {
      const all = this.list(accountId);
      const target = all.find((i) => i.platform === platform);
      if (!target) return "not_linked";
      if (all.length === 1) return "last";
      this.deps.db.query("DELETE FROM identities WHERE id = ?").run(target.id);
      this.deps.db.query("DELETE FROM pending WHERE user_id = ?").run(target.id);
      return "ok";
    })();
  }

  /** A new one-time code for linking another platform; replaces the account's previous code. */
  createLinkCode(accountId: string): { code: string; expiresAt: number } {
    const now = this.deps.now();
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const expiresAt = now + LINK_CODE_TTL_MS;
    this.deps.db.transaction(() => {
      this.deps.db.query("DELETE FROM link_codes WHERE account_id = ? OR expires_at <= ?").run(accountId, now);
      this.deps.db
        .query("INSERT INTO link_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)")
        .run(this.deps.crypto.linkCodeKey(code), accountId, expiresAt);
    })();
    return { code, expiresAt };
  }

  /** Links the identity `ref` to the account that created `code`. The code works once. */
  redeemLinkCode(code: string, ref: IdentityRef): RedeemResult {
    const now = this.deps.now();
    const codeHash = this.deps.crypto.linkCodeKey(normalizeLinkCode(code));
    return this.deps.db.transaction((): RedeemResult => {
      const row = this.deps.db.query("SELECT account_id, expires_at FROM link_codes WHERE code_hash = ?").get(codeHash) as
        | { account_id: string; expires_at: number }
        | null;
      if (!row || row.expires_at <= now) return { ok: false, reason: "invalid" };

      const current = this.accountOf(this.key(ref));
      if (current === row.account_id) return { ok: false, reason: "already_linked" };
      if (current) return { ok: false, reason: "has_account" };
      if (this.list(row.account_id).some((i) => i.platform === ref.platform)) {
        return { ok: false, reason: "platform_taken" };
      }

      this.attach(row.account_id, ref);
      this.deps.db.query("DELETE FROM link_codes WHERE code_hash = ?").run(codeHash);
      return { ok: true, accountId: row.account_id };
    })();
  }

  private encryptContact(ref: IdentityRef): string {
    return this.deps.crypto.encrypt(String(ref.platformUserId));
  }
}
