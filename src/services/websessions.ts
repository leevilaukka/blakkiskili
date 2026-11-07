// Website sign-in: single-use login links (sent by the bot's /web command) and browser sessions.
//
// Tokens are 256-bit random values. Only their HMAC is stored (Crypto.webTokenKey), so a leaked
// database file can't be used to sign in. A session belongs to an account and remembers which
// platform login it came from; it ends when it expires, is revoked, or the account is deleted.

import { randomBytes } from "node:crypto";
import { DAY_MS, MINUTE_MS } from "../lib/units.ts";
import type { Deps } from "./index.ts";

export const LOGIN_LINK_TTL_MS = 10 * MINUTE_MS;
export const SESSION_TTL_MS = 30 * DAY_MS;
// last_seen_at and the expiry are renewed at most this often, so reads don't write every request.
const TOUCH_EVERY_MS = 5 * MINUTE_MS;

export interface WebSession {
  accountId: string;
  identityId: string | null;
}

const newToken = () => randomBytes(32).toString("base64url");

export class WebSessions {
  constructor(private readonly deps: Deps) {}

  /** A login link token for the account; the caller turns it into a URL. Replaces earlier unused links. */
  createLoginLink(accountId: string, identityId: string | null): { token: string; expiresAt: number } {
    const now = this.deps.now();
    const token = newToken();
    const expiresAt = now + LOGIN_LINK_TTL_MS;
    this.deps.db.transaction(() => {
      this.deps.db.query("DELETE FROM web_login_links WHERE account_id = ? OR expires_at <= ?").run(accountId, now);
      this.deps.db
        .query("INSERT INTO web_login_links (token_hash, account_id, identity_id, expires_at) VALUES (?, ?, ?, ?)")
        .run(this.deps.crypto.webTokenKey(token), accountId, identityId, expiresAt);
    })();
    return { token, expiresAt };
  }

  /** Exchanges a login link for a session. The link works once. */
  redeemLoginLink(token: string): { sessionToken: string; expiresAt: number } | null {
    const now = this.deps.now();
    const hash = this.deps.crypto.webTokenKey(token);
    return this.deps.db.transaction(() => {
      const row = this.deps.db
        .query("SELECT account_id, identity_id, expires_at FROM web_login_links WHERE token_hash = ?")
        .get(hash) as { account_id: string; identity_id: string | null; expires_at: number } | null;
      if (!row) return null;
      this.deps.db.query("DELETE FROM web_login_links WHERE token_hash = ?").run(hash);
      if (row.expires_at <= now) return null;
      return this.createSession(row.account_id, row.identity_id);
    })();
  }

  createSession(accountId: string, identityId: string | null): { sessionToken: string; expiresAt: number } {
    const now = this.deps.now();
    const sessionToken = newToken();
    const expiresAt = now + SESSION_TTL_MS;
    this.deps.db
      .query(
        "INSERT INTO web_sessions (token_hash, account_id, identity_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.deps.crypto.webTokenKey(sessionToken), accountId, identityId, now, now, expiresAt);
    return { sessionToken, expiresAt };
  }

  /** The session behind a cookie value, or null when unknown or expired. Slides the expiry forward. */
  authenticate(sessionToken: string): WebSession | null {
    const now = this.deps.now();
    const hash = this.deps.crypto.webTokenKey(sessionToken);
    const row = this.deps.db
      .query("SELECT account_id, identity_id, last_seen_at, expires_at FROM web_sessions WHERE token_hash = ?")
      .get(hash) as { account_id: string; identity_id: string | null; last_seen_at: number; expires_at: number } | null;
    if (!row || row.expires_at <= now) return null;
    if (now - row.last_seen_at >= TOUCH_EVERY_MS) {
      this.deps.db
        .query("UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
        .run(now, now + SESSION_TTL_MS, hash);
    }
    return { accountId: row.account_id, identityId: row.identity_id };
  }

  revoke(sessionToken: string) {
    this.deps.db.query("DELETE FROM web_sessions WHERE token_hash = ?").run(this.deps.crypto.webTokenKey(sessionToken));
  }

  /** Signs the account out everywhere. */
  revokeAll(accountId: string) {
    this.deps.db.query("DELETE FROM web_sessions WHERE account_id = ?").run(accountId);
  }

  /** Deletes expired sessions and login links. */
  prune(): number {
    const now = this.deps.now();
    const a = this.deps.db.query("DELETE FROM web_sessions WHERE expires_at <= ?").run(now).changes;
    const b = this.deps.db.query("DELETE FROM web_login_links WHERE expires_at <= ?").run(now).changes;
    return a + b;
  }
}
