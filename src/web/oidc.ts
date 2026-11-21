// Signing in with Google or Microsoft: OpenID Connect's authorization code flow with PKCE.
//
// The browser is sent to the provider with a random state, nonce and PKCE challenge (kept by the
// server, see api/logins.ts); the provider sends it back to our callback with a code, which the
// server exchanges for an ID token over TLS. The ID token's signature is checked against the
// provider's published keys, and its issuer, audience, expiry and nonce against what we expect.
//
// Only the token's `sub` (the provider's id for this person in this app) is used, never the
// email address: emails get reused and aren't always verified. Nothing else from the provider is
// stored; `sub` becomes an identity key (an HMAC) like a Telegram id.

import { createHash, randomBytes } from "node:crypto";
import type { OAuthClient } from "../config.ts";

export type OidcPlatform = "google" | "microsoft";

interface ProviderInfo {
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** Whether `iss` is this provider's (Microsoft's depends on the tenant the person is in). */
  issuerOk: (iss: unknown, claims: Record<string, unknown>) => boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PROVIDERS: Record<OidcPlatform, ProviderInfo> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuerOk: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
  },
  // "common": work and school accounts (students' university Microsoft 365) and personal accounts.
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    issuerOk: (iss, claims) =>
      typeof claims.tid === "string" && GUID.test(claims.tid) && iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`,
  },
};

/** What the server keeps between sending the browser away and the callback. */
export interface OidcStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

export type OidcResult = { ok: true; sub: string } | { ok: false; reason: "exchange_failed" | "bad_token" };

const CLOCK_SKEW_S = 120;
const JWKS_TTL_MS = 60 * 60 * 1000;
/** An unknown key id refetches the keys (they rotate), but not more often than this. */
const JWKS_REFETCH_MS = 60 * 1000;
const TIMEOUT_MS = 10_000;

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");
const random = () => b64url(randomBytes(32));

type Jwk = { kty?: string; kid?: string; n?: string; e?: string };

export class OidcClient {
  #keys: Jwk[] = [];
  #keysAt = -Infinity;

  constructor(
    readonly platform: OidcPlatform,
    private readonly client: OAuthClient,
    private readonly redirectUri: string,
    private readonly now: () => number,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly info: ProviderInfo = PROVIDERS[platform],
  ) {}

  /** Where to send the browser, and the secrets to keep until it comes back. */
  start(): OidcStart {
    const state = random();
    const nonce = random();
    const verifier = random();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.client.clientId,
      redirect_uri: this.redirectUri,
      scope: "openid",
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      // Shared devices: always ask which account, never sign in silently as whoever used it last.
      prompt: "select_account",
    });
    return { url: `${this.info.authorizeUrl}?${q}`, state, nonce, verifier };
  }

  /** Exchanges the callback's code for the person's `sub`. */
  async finish(code: string, verifier: string, nonce: string): Promise<OidcResult> {
    let idToken: unknown;
    try {
      const res = await this.fetchFn(this.info.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.redirectUri,
          client_id: this.client.clientId,
          client_secret: this.client.clientSecret,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, reason: "exchange_failed" };
      idToken = ((await res.json()) as { id_token?: unknown }).id_token;
    } catch {
      return { ok: false, reason: "exchange_failed" };
    }
    if (typeof idToken !== "string") return { ok: false, reason: "exchange_failed" };
    const claims = await this.verify(idToken);
    if (!claims) return { ok: false, reason: "bad_token" };
    const nowS = this.now() / 1000;
    const aud = claims.aud;
    const audOk = aud === this.client.clientId || (Array.isArray(aud) && aud.includes(this.client.clientId) && claims.azp === this.client.clientId);
    const ok =
      this.info.issuerOk(claims.iss, claims) &&
      audOk &&
      typeof claims.exp === "number" &&
      claims.exp > nowS - CLOCK_SKEW_S &&
      (claims.iat === undefined || (typeof claims.iat === "number" && claims.iat < nowS + CLOCK_SKEW_S)) &&
      claims.nonce === nonce &&
      typeof claims.sub === "string" &&
      claims.sub.length > 0 &&
      claims.sub.length <= 255;
    return ok ? { ok: true, sub: claims.sub as string } : { ok: false, reason: "bad_token" };
  }

  /** The token's claims if it is an RS256 JWT signed by one of the provider's keys. */
  private async verify(token: string): Promise<Record<string, unknown> | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown };
    let claims: unknown;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    const jwk = await this.key(header.kid);
    if (!jwk) return null;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
      return valid ? (claims as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async key(kid: string): Promise<Jwk | null> {
    const age = this.now() - this.#keysAt;
    const cached = this.#keys.find((k) => k.kid === kid);
    if (cached && age < JWKS_TTL_MS) return cached;
    if (age >= JWKS_REFETCH_MS) {
      try {
        const res = await this.fetchFn(this.info.jwksUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) {
          const body = (await res.json()) as { keys?: unknown };
          if (Array.isArray(body.keys)) {
            this.#keys = body.keys.filter((k): k is Jwk => !!k && typeof k === "object" && (k as Jwk).kty === "RSA");
            this.#keysAt = this.now();
          }
        }
      } catch {}
    }
    return this.#keys.find((k) => k.kid === kid) ?? null;
  }
}
