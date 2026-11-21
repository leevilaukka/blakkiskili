// Short-lived sign-in state kept between two requests: an OAuth state, nonce and PKCE verifier
// until the provider sends the browser back, a passkey challenge until the browser answers it, and
// a "may create an account for this login" ticket until the sign-up form is sent.
//
// It lives in memory, under a random key that the browser holds in an HttpOnly cookie, and each
// entry can be taken once. A restart forgets them: someone signing in at that moment starts over.

import { randomBytes } from "node:crypto";

export class FlowStore<T> {
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    readonly ttlMs: number,
    private readonly now: () => number,
    /** A cap so a flood of started flows can't grow memory without bound; the oldest go first. */
    private readonly max = 10_000,
  ) {}

  /** Stores `value` and returns its key (the cookie's value). */
  put(value: T): string {
    this.prune();
    while (this.#entries.size >= this.max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const key = randomBytes(32).toString("base64url");
    this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return key;
  }

  /** The value without using it up, or null when unknown or expired. */
  peek(key: string | null | undefined): T | null {
    if (!key) return null;
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  /** The value, once. */
  take(key: string | null | undefined): T | null {
    const value = this.peek(key);
    if (value !== null) this.#entries.delete(key!);
    return value;
  }

  private prune() {
    const now = this.now();
    // Insertion order is expiry order (one TTL per store), so stop at the first live entry.
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt > now) break;
      this.#entries.delete(key);
    }
  }
}
