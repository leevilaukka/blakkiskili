// Passkeys (WebAuthn credentials) for signing in to the website.
//
// An account has at most one 'passkey' identity, and any number of passkeys under it (a phone, a
// laptop, a security key). Signing in finds the passkey by its credential id, so the WebAuthn user
// handle is only a random value that keeps one account's passkeys together on an authenticator.
// Checking signatures is the web layer's job (src/web/api/passkeys.ts); this stores the results.

import { randomBytes } from "node:crypto";
import type { Deps } from "./index.ts";
import type { Identities } from "./identities.ts";

/** Enough for a phone, a laptop, a tablet and a couple of security keys. */
export const PASSKEYS_PER_ACCOUNT = 10;

export interface Passkey {
  id: string;
  identityId: string;
  accountId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface NewPasskey {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
}

interface Row {
  id: string;
  identity_id: string;
  account_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** ok; last: removing it would leave the account with no way to sign in; not_found. */
export type RemovePasskeyResult = "ok" | "last" | "not_found";

const SELECT = `SELECT p.*, i.account_id FROM passkeys p JOIN identities i ON i.id = p.identity_id`;

export class Passkeys {
  constructor(
    private readonly deps: Deps,
    private readonly identities: Identities,
  ) {}

  private toPasskey(r: Row): Passkey {
    let transports: string[] = [];
    try {
      const parsed = JSON.parse(r.transports ?? "[]");
      if (Array.isArray(parsed)) transports = parsed.filter((t) => typeof t === "string");
    } catch {}
    return {
      id: r.id,
      identityId: r.identity_id,
      accountId: r.account_id,
      publicKey: new Uint8Array(r.public_key),
      counter: r.counter,
      transports,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  }

  get(credentialId: string): Passkey | null {
    const row = this.deps.db.query(`${SELECT} WHERE p.id = ?`).get(credentialId) as Row | null;
    return row ? this.toPasskey(row) : null;
  }

  /** The account's passkeys, oldest first. */
  list(accountId: string): Passkey[] {
    const rows = this.deps.db.query(`${SELECT} WHERE i.account_id = ? ORDER BY p.created_at, p.rowid`).all(accountId) as Row[];
    return rows.map((r) => this.toPasskey(r));
  }

  /** A new random value for the passkey identity of a new account (it becomes the identity key's input). */
  static newHandle(): string {
    return randomBytes(16).toString("base64url");
  }

  /**
   * Stores a passkey for an account that already exists, creating its passkey identity if it has
   * none. False when the account has the maximum already.
   */
  add(accountId: string, passkey: NewPasskey): boolean {
    return this.deps.db.transaction(() => {
      if (this.list(accountId).length >= PASSKEYS_PER_ACCOUNT) return false;
      let identity = this.identities.find(accountId, "passkey");
      if (!identity) {
        this.identities.attach(accountId, { platform: "passkey", platformUserId: Passkeys.newHandle() });
        identity = this.identities.find(accountId, "passkey")!;
      }
      this.insert(identity.id, passkey);
      return true;
    })();
  }

  /** Stores a passkey under a given passkey identity (signing up: the identity was just made). */
  insert(identityId: string, passkey: NewPasskey) {
    this.deps.db
      .query("INSERT INTO passkeys (id, identity_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(passkey.id, identityId, passkey.publicKey, passkey.counter, JSON.stringify(passkey.transports ?? []), this.deps.now());
  }

  /** After a successful sign-in: the authenticator's new counter. */
  used(credentialId: string, counter: number) {
    this.deps.db.query("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, this.deps.now(), credentialId);
  }

  /**
   * Removes one of the account's passkeys. The last one takes the passkey identity with it, which
   * is allowed only when the account has another login.
   */
  remove(accountId: string, credentialId: string): RemovePasskeyResult {
    return this.deps.db.transaction((): RemovePasskeyResult => {
      const all = this.list(accountId);
      const target = all.find((p) => p.id === credentialId);
      if (!target) return "not_found";
      if (all.length > 1) {
        this.deps.db.query("DELETE FROM passkeys WHERE id = ?").run(credentialId);
        return "ok";
      }
      const r = this.identities.unlink(accountId, "passkey");
      return r === "ok" ? "ok" : r === "last" ? "last" : "not_found";
    })();
  }
}
