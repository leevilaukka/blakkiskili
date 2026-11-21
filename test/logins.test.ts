// Website sign-in methods besides Telegram: the switches (Config.auth), Google and Microsoft
// (OpenID Connect against a fake provider), sign-up, linking and removing logins, and passkeys
// (against a software authenticator).

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { docsHtml } from "../src/bot/context.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { PLATFORM_NAMES } from "../src/strings.ts";
import { webName } from "../src/services/accounts.ts";
import { FlowStore } from "../src/web/authflows.ts";
import { PROVIDERS } from "../src/web/oidc.ts";
import { serveTestApp, setup, testConfig, tg } from "./helpers.ts";

const BOT_TOKEN = "123:TEST";
const ORIGIN = "https://kili.test";
const GOOGLE = { clientId: "google-client", clientSecret: "google-secret" };
const MICROSOFT = { clientId: "ms-client", clientSecret: "ms-secret" };
const MS_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

// ---------- A fake OpenID provider ----------

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function jwt(claims: Record<string, unknown>, key = rsa.privateKey, kid = "k1") {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}

/** The provider: issues an ID token for the next code exchanged, built by `token(nonce)`. */
function fakeProvider() {
  const state = {
    /** Claims for the next ID token; the nonce is the one the token request's code was issued for. */
    claims: (_nonce: string): Record<string, unknown> => ({}),
    key: rsa.privateKey,
    tokenStatus: 200,
    codes: new Map<string, string>(), // code → nonce
    tokenRequests: [] as URLSearchParams[],
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === PROVIDERS.google.jwksUrl || url === PROVIDERS.microsoft.jwksUrl) return Response.json({ keys: [JWK] });
    if (url === PROVIDERS.google.tokenUrl || url === PROVIDERS.microsoft.tokenUrl) {
      const form = new URLSearchParams(String(init?.body));
      state.tokenRequests.push(form);
      const nonce = state.codes.get(form.get("code") ?? "");
      if (state.tokenStatus !== 200 || nonce === undefined) return Response.json({ error: "invalid_grant" }, { status: state.tokenStatus === 200 ? 400 : state.tokenStatus });
      return Response.json({ id_token: jwt(state.claims(nonce), state.key) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  /** The person picks their account: the provider sends the browser back with a code for this sign-in. */
  const authorize = (startUrl: string) => {
    const q = new URL(startUrl).searchParams;
    const code = randomBytes(8).toString("hex");
    state.codes.set(code, q.get("nonce")!);
    return { code, state: q.get("state")!, nonce: q.get("nonce")!, query: q };
  };
  return Object.assign(state, { fetchFn, authorize });
}

// ---------- A software passkey authenticator ----------

/** Just enough CBOR for WebAuthn: unsigned/negative ints, byte and text strings, maps. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

function authenticator(rpId = "kili.test", origin = ORIGIN) {
  const credentials = new Map<string, { key: { privateKey: KeyObject; publicKey: KeyObject }; userHandle: string; counter: number }>();
  const flags = (attested: boolean) => 0x01 | 0x04 | (attested ? 0x40 : 0); // user present, verified, attested data

  return {
    credentials,
    /** navigator.credentials.create() for these options. */
    create(options: { challenge: string; user: { id: string } }, opts: { origin?: string } = {}) {
      const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const id = randomBytes(16);
      const jwk = key.publicKey.export({ format: "jwk" }) as { x: string; y: string };
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(id.length);
      const counter = Buffer.alloc(4);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags(true)]), counter, Buffer.alloc(16), idLen, id, cose]);
      const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: opts.origin ?? origin, crossOrigin: false });
      credentials.set(b64u(id), { key, userHandle: options.user.id, counter: 0 });
      return {
        id: b64u(id),
        rawId: b64u(id),
        type: "public-key",
        response: {
          clientDataJSON: b64u(Buffer.from(clientData)),
          attestationObject: b64u(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    /** navigator.credentials.get() with credential `id`. */
    get(options: { challenge: string }, id: string, opts: { counter?: number } = {}) {
      const cred = credentials.get(id)!;
      cred.counter = opts.counter ?? cred.counter + 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(cred.counter);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags(false)]), counter]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const signature = createSign("SHA256").update(Buffer.concat([authData, sha256(clientData)])).sign(cred.key.privateKey);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          userHandle: cred.userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}

// ---------- The app ----------

const apps: ReturnType<typeof serveTestApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

const PROFILE = { name: "Kalle", weight: 80, height: 180, gender: "mies", acceptTerms: true };

function world(auth: Config["auth"] = { google: GOOGLE, microsoft: MICROSOFT, passkeys: true }) {
  const w = setup();
  const provider = fakeProvider();
  const alice = w.services.accounts.register(tg(1), { name: "alice", weight: 70, height: 170, gender: "nainen" }).profile;
  const app = serveTestApp({ services: w.services, botToken: BOT_TOKEN, botUsername: "kili_bot", origin: ORIGIN, auth, oidcFetch: provider.fetchFn });
  apps.push(app);

  /** A browser: keeps its cookies, like the real one. */
  const browser = (ip = "1.2.3.4") => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = {};
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      if (method !== "GET") Object.assign(headers, { origin: ORIGIN, "x-kili": "1", "content-type": "application/json" });
      const res = await app(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ip);
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(";");
        const [name, value] = pair!.split("=") as [string, string];
        if (attrs.some((a) => a.trim() === "Max-Age=0")) jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    };
    /** Starts a Google/Microsoft sign-in (or link) and comes back from the provider. */
    const viaProvider = async (platform: "google" | "microsoft", kind: "start" | "link" = "start", tweak?: (q: URLSearchParams) => void) => {
      const start = await call("POST", `/api/auth/${platform}/${kind}`, {});
      expect(start.status).toBe(200);
      const { url } = (await start.json()) as { url: string };
      const a = provider.authorize(url);
      const q = new URLSearchParams({ code: a.code, state: a.state });
      tweak?.(q);
      const res = await call("GET", `/api/auth/${platform}/callback?${q}`);
      return { res, location: res.headers.get("location"), authorize: a };
    };
    return { call, jar, viaProvider, cookie: (name: string) => jar.get(name) };
  };

  const googleClaims = (sub: string, over: Record<string, unknown> = {}) => (nonce: string) => ({
    iss: "https://accounts.google.com",
    aud: GOOGLE.clientId,
    sub,
    nonce,
    iat: Math.floor(w.clock.now / 1000),
    exp: Math.floor(w.clock.now / 1000) + 3600,
    ...over,
  });

  return { ...w, provider, app, alice, browser, googleClaims };
}

// ---------- Tests ----------

describe("switches (Config.auth)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const load = (env: Record<string, string>) => {
    process.env = { ...saved, BOT_TOKEN: "1:x", APP_SECRET: "x".repeat(32), ...env };
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "PASSKEYS"]) {
      if (!(k in env)) delete process.env[k];
    }
    return loadConfig().auth;
  };

  test("a provider is on only with both of its variables; one alone stops the start", () => {
    expect(load({})).toEqual({ google: undefined, microsoft: undefined, passkeys: false });
    expect(load({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }).google).toEqual({ clientId: "id", clientSecret: "s" });
    expect(() => load({ GOOGLE_CLIENT_ID: "id" })).toThrow("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    expect(() => load({ MICROSOFT_CLIENT_SECRET: "s" })).toThrow("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET");
    expect(load({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "" }).google).toBeUndefined();
    expect(load({ PASSKEYS: "true" }).passkeys).toBe(true);
  });

  test("/api/config lists only what is configured; the others' routes don't exist", async () => {
    const off = world({ passkeys: false }).browser();
    expect(((await (await off.call("GET", "/api/config")).json()) as { loginProviders: string[] }).loginProviders).toEqual(["telegram"]);
    for (const path of ["/api/auth/google/start", "/api/auth/microsoft/start", "/api/auth/passkey/login/options", "/api/auth/passkey/signup/options"]) {
      expect((await off.call("POST", path, {})).status).toBe(404);
    }
    expect((await off.call("GET", "/api/auth/google/callback?code=x&state=y")).status).toBe(404);

    const some = world({ microsoft: MICROSOFT, passkeys: false }).browser();
    expect(((await (await some.call("GET", "/api/config")).json()) as { loginProviders: string[] }).loginProviders).toEqual(["telegram", "microsoft"]);
    expect((await some.call("POST", "/api/auth/google/start", {})).status).toBe(404);

    const all = world().browser();
    expect(((await (await all.call("GET", "/api/config")).json()) as { loginProviders: string[] }).loginProviders).toEqual(["telegram", "google", "microsoft", "passkey"]);
  });

  test("a signup with a passkey answer is refused when passkeys are off", async () => {
    const b = world({ google: GOOGLE, passkeys: false }).browser();
    expect((await b.call("POST", "/api/auth/signup", { ...PROFILE, passkey: {} })).status).toBe(404);
  });

  test("the privacy text names exactly the configured methods", () => {
    const base = testConfig();
    const web = { ...base, web: { ...base.web, enabled: true } };
    const off = docsHtml({ ...web, auth: { passkeys: false } }).privacy;
    expect(off).toContain("kirjaudutaan Telegramilla tai botin /web-linkillä");
    expect(off).not.toContain("Google");
    expect(off).not.toContain("Pääsyavaimesta");
    const on = docsHtml({ ...web, auth: { google: GOOGLE, passkeys: true } }).privacy;
    expect(on).toContain("kirjaudutaan Telegramilla, Googlella, pääsyavaimella tai botin /web-linkillä");
    expect(on).toContain("Kun kirjaudut Googlella, palvelu kertoo");
    expect(on).toContain("Google näkee");
    expect(on).not.toContain("Microsoft");
    expect(on).toContain("Pääsyavaimesta tallennetaan");
    expect(on).toContain(`ei ole käytetty ${base.inactivity.deleteAfterDays} päivään`);
    const both = docsHtml({ ...web, auth: { google: GOOGLE, microsoft: MICROSOFT, passkeys: false } }).privacy;
    expect(both).toContain("Kun kirjaudut Googlella tai Microsoftilla");
    expect(both).toContain("Google tai Microsoft näkee");
  });
});

describe("Google and Microsoft", () => {
  test("the provider gets PKCE, a nonce and our callback, and only the openid scope", async () => {
    const w = world();
    const b = w.browser();
    const res = await b.call("POST", "/api/auth/google/start", {});
    const { url } = (await res.json()) as { url: string };
    const q = new URL(url).searchParams;
    expect(url.startsWith(PROVIDERS.google.authorizeUrl)).toBe(true);
    expect(q.get("client_id")).toBe(GOOGLE.clientId);
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(q.get("scope")).toBe("openid");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("nonce")!.length).toBeGreaterThan(20);
    expect(b.cookie("__Host-kili-oauth")).toBeTruthy();
    // The flow cookie is HttpOnly and lives about as long as the flow.
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  });

  test("a new person signs up, then signs in again with the same Google account", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-123");
    const b = w.browser();
    const first = await b.viaProvider("google");
    expect(first.location).toBe("/signup");
    expect(b.cookie("__Host-kili")).toBeUndefined();
    expect(b.cookie("__Host-kili-oauth")).toBeUndefined(); // used up
    // The code went to the token endpoint with the PKCE verifier matching the challenge.
    const verifier = w.provider.tokenRequests[0]!.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(first.authorize.query.get("code_challenge")!);

    expect(await (await b.call("GET", "/api/auth/signup")).json()).toEqual({ method: "google" });
    expect((await b.call("POST", "/api/auth/signup", { ...PROFILE, acceptTerms: false })).status).toBe(422);
    expect((await b.call("POST", "/api/auth/signup", { ...PROFILE, name: "@alice" })).status).toBe(422);
    expect((await b.call("POST", "/api/auth/signup", { ...PROFILE, weight: 5 })).status).toBe(422);
    const ok = await b.call("POST", "/api/auth/signup", PROFILE);
    expect(ok.status).toBe(200);
    expect(b.cookie("__Host-kili-signup")).toBeUndefined();
    const me = (await (await b.call("GET", "/api/me")).json()) as { name: string; telegram: boolean; admin: boolean };
    expect(me).toMatchObject({ name: "Kalle", telegram: false, admin: false });

    // Only an HMAC of the Google id is stored, and no contact for it.
    const row = w.db.query("SELECT id, platform, contact_enc FROM identities WHERE platform = 'google'").get() as { id: string; contact_enc: string | null };
    expect(row.id).toBe(w.services.identities.key({ platform: "google", platformUserId: "g-123" }));
    expect(row.contact_enc).toBeNull();

    // The ticket is single-use.
    expect((await b.call("POST", "/api/auth/signup", PROFILE)).status).toBe(401);

    const again = w.browser();
    const second = await again.viaProvider("google");
    expect(second.location).toBe("/login#signedin");
    expect(((await (await again.call("GET", "/api/me")).json()) as { name: string }).name).toBe("Kalle");
    expect(w.db.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 2 }); // alice and Kalle
  });

  test("Microsoft: the issuer must be the person's tenant", async () => {
    const w = world();
    const claims = (over: Record<string, unknown>) => (nonce: string) => ({
      iss: `https://login.microsoftonline.com/${MS_TENANT}/v2.0`,
      tid: MS_TENANT,
      aud: MICROSOFT.clientId,
      sub: "ms-1",
      nonce,
      exp: Math.floor(w.clock.now / 1000) + 600,
      ...over,
    });
    w.provider.claims = claims({});
    expect((await w.browser().viaProvider("microsoft")).location).toBe("/signup");
    w.provider.claims = claims({ iss: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0" });
    expect((await w.browser().viaProvider("microsoft")).location).toBe("/login#error=provider_failed");
    w.provider.claims = claims({ tid: "x", iss: "https://login.microsoftonline.com/x/v2.0" });
    expect((await w.browser().viaProvider("microsoft")).location).toBe("/login#error=provider_failed");
  });

  test("a token that isn't right for us is refused", async () => {
    const w = world();
    const bad: [string, (nonce: string) => Record<string, unknown>][] = [
      ["wrong audience", w.googleClaims("g", { aud: "someone-else" })],
      ["wrong issuer", w.googleClaims("g", { iss: "https://evil.example" })],
      ["expired", w.googleClaims("g", { exp: Math.floor(w.clock.now / 1000) - 3600 })],
      ["issued in the future", w.googleClaims("g", { iat: Math.floor(w.clock.now / 1000) + 3600 })],
      ["another sign-in's nonce", (_n) => w.googleClaims("g")("other-nonce")],
      ["no sub", w.googleClaims("", {})],
    ];
    // Each from its own address: sign-in is rate limited per address.
    let ip = 0;
    const fresh = () => w.browser(`10.0.0.${++ip}`);
    for (const [why, claims] of bad) {
      w.provider.claims = claims;
      expect({ why, location: (await fresh().viaProvider("google")).location }).toEqual({ why, location: "/login#error=provider_failed" });
    }
    w.provider.claims = w.googleClaims("g");
    w.provider.key = otherRsa.privateKey; // signed by a key that isn't the provider's
    expect((await fresh().viaProvider("google")).location).toBe("/login#error=provider_failed");
    w.provider.key = rsa.privateKey;
    w.provider.tokenStatus = 500;
    expect((await fresh().viaProvider("google")).location).toBe("/login#error=provider_failed");
    // And the same person with a good token is let through (the checks above aren't failing for another reason).
    w.provider.tokenStatus = 200;
    expect((await fresh().viaProvider("google")).location).toBe("/signup");
    expect(w.db.query("SELECT count(*) AS n FROM identities WHERE platform = 'google'").get()).toEqual({ n: 0 });
  });

  test("the callback works only in the browser that started it, once, with its state", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-1");
    // Wrong state.
    expect((await w.browser().viaProvider("google", "start", (q) => q.set("state", "forged"))).location).toBe("/login#error=invalid_state");
    // Cancelled at the provider.
    expect((await w.browser().viaProvider("google", "start", (q) => (q.delete("code"), q.set("error", "access_denied")))).location).toBe("/login#error=cancelled");
    // Another browser (an attacker's code and state, the victim's cookies): no flow there.
    const attacker = w.browser();
    const start = await attacker.call("POST", "/api/auth/google/start", {});
    const a = w.provider.authorize(((await start.json()) as { url: string }).url);
    const victim = w.browser();
    const res = await victim.call("GET", `/api/auth/google/callback?code=${a.code}&state=${a.state}`);
    expect(res.headers.get("location")).toBe("/login#error=invalid_state");
    // Google's callback isn't Microsoft's.
    const b = w.browser();
    const s = await b.call("POST", "/api/auth/google/start", {});
    const g = w.provider.authorize(((await s.json()) as { url: string }).url);
    expect((await b.call("GET", `/api/auth/microsoft/callback?code=${g.code}&state=${g.state}`)).headers.get("location")).toBe("/login#error=invalid_state");
    // Used up: the same callback again fails.
    expect((await b.call("GET", `/api/auth/google/callback?code=${g.code}&state=${g.state}`)).headers.get("location")).toBe("/login#error=invalid_state");
  });

  test("starting needs our origin and header (login CSRF)", async () => {
    const w = world();
    const res = await w.app(new Request(`${ORIGIN}/api/auth/google/start`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }));
    expect(res.status).toBe(403);
  });
});

describe("linking and removing logins", () => {
  const signInAlice = (w: ReturnType<typeof world>) => {
    const b = w.browser();
    b.jar.set("__Host-kili", w.services.webSessions.createSession(w.alice.id, w.services.identities.key(tg(1))).sessionToken);
    return b;
  };

  test("a Telegram account adds Google, then signs in with it", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-alice");
    const b = signInAlice(w);
    expect((await b.call("POST", "/api/auth/google/link", {})).status).toBe(200);
    const linked = await b.viaProvider("google", "link");
    expect(linked.location).toBe("/settings#linked=google");
    const view = (await (await b.call("GET", "/api/auth/logins")).json()) as { logins: { platform: string; current: boolean; usable: boolean }[] };
    expect(view.logins).toEqual([
      expect.objectContaining({ platform: "telegram", current: true, usable: true }),
      expect.objectContaining({ platform: "google", current: false, usable: true }),
    ]);

    const other = w.browser();
    expect((await other.viaProvider("google")).location).toBe("/login#signedin");
    expect(((await (await other.call("GET", "/api/me")).json()) as { name: string; telegram: boolean })).toMatchObject({ name: "alice", telegram: true });
  });

  test("never merges accounts: a Google login with its own account can't be linked", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-kalle");
    const k = w.browser();
    await k.viaProvider("google");
    await k.call("POST", "/api/auth/signup", PROFILE);

    const b = signInAlice(w);
    expect((await b.viaProvider("google", "link")).location).toBe("/settings#error=has_account");
    // A second Google account on the same account isn't allowed either.
    w.provider.claims = w.googleClaims("g-alice");
    expect((await b.viaProvider("google", "link")).location).toBe("/settings#linked=google");
    w.provider.claims = w.googleClaims("g-alice-2");
    expect((await b.viaProvider("google", "link")).location).toBe("/settings#error=platform_taken");
  });

  test("linking needs a session, and that session still signed in when the provider sends the browser back", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-alice");
    expect((await w.browser().call("POST", "/api/auth/google/link", {})).status).toBe(401);

    const b = signInAlice(w);
    const start = await b.call("POST", "/api/auth/google/link", {});
    const a = w.provider.authorize(((await start.json()) as { url: string }).url);
    w.services.webSessions.revokeAll(w.alice.id); // signed out (everywhere) meanwhile
    const res = await b.call("GET", `/api/auth/google/callback?code=${a.code}&state=${a.state}`);
    expect(res.headers.get("location")).toBe("/settings#error=unauthorized");
    expect(w.services.identities.find(w.alice.id, "google")).toBeNull();
  });

  test("removing: not the current login, not the last usable one", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-alice");
    const b = signInAlice(w);
    await b.viaProvider("google", "link");
    expect((await b.call("DELETE", "/api/auth/logins/telegram")).status).toBe(409); // current
    expect((await b.call("DELETE", "/api/auth/logins/discord")).status).toBe(404);
    expect((await b.call("DELETE", "/api/auth/logins/nonsense")).status).toBe(404);
    expect((await b.call("DELETE", "/api/auth/logins/google")).status).toBe(200);
    expect(w.services.identities.find(w.alice.id, "google")).toBeNull();

    // Signed in with Google, Telegram can go; then Google is the only one and stays.
    await b.viaProvider("google", "link");
    const g = w.browser();
    await g.viaProvider("google");
    expect((await g.call("DELETE", "/api/auth/logins/telegram")).status).toBe(200);
    expect((await g.call("DELETE", "/api/auth/logins/google")).status).toBe(409);
    // Alice's Telegram session ended with its login.
    expect((await b.call("GET", "/api/me")).status).toBe(401);
  });

  test("a login whose provider has been switched off doesn't count as a way in", async () => {
    const w = world({ passkeys: false }); // no Google configured
    w.services.identities.attach(w.alice.id, { platform: "google", platformUserId: "g-alice" });
    const g = w.browser();
    g.jar.set("__Host-kili", w.services.webSessions.createSession(w.alice.id, w.services.identities.key({ platform: "google", platformUserId: "g-alice" })).sessionToken);
    const view = (await (await g.call("GET", "/api/auth/logins")).json()) as { logins: { platform: string; usable: boolean }[] };
    expect(view.logins.find((l) => l.platform === "google")?.usable).toBe(false);
    // Telegram is the only login that still works, so it can't be removed.
    expect((await g.call("DELETE", "/api/auth/logins/telegram")).status).toBe(409);
  });

  test("Telegram can be added to a website account", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-kalle");
    const b = w.browser();
    await b.viaProvider("google");
    await b.call("POST", "/api/auth/signup", PROFILE);
    const fields = { id: 77, first_name: "Kalle", auth_date: Math.floor(w.clock.now / 1000) };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join("\n");
    const secret = createHash("sha256").update(BOT_TOKEN).digest();
    const hash = new Bun.CryptoHasher("sha256", secret).update(check).digest("hex");
    expect((await b.call("POST", "/api/auth/telegram/link", { ...fields, hash: "0".repeat(64) })).status).toBe(400);
    expect((await b.call("POST", "/api/auth/telegram/link", { ...fields, hash })).status).toBe(200);
    expect(((await (await b.call("GET", "/api/me")).json()) as { telegram: boolean }).telegram).toBe(true);
    // Alice's Telegram has its own account.
    const alice = { ...fields, id: 1 };
    const check2 = Object.keys(alice).sort().map((k) => `${k}=${alice[k as keyof typeof alice]}`).join("\n");
    const hash2 = new Bun.CryptoHasher("sha256", secret).update(check2).digest("hex");
    const res = await b.call("POST", "/api/auth/telegram/link", { ...alice, hash: hash2 });
    expect(res.status).toBe(409);
  });
});

describe("names chosen on the website", () => {
  test("webName", () => {
    expect(webName("  Kalle   K ")).toBe("Kalle K");
    expect(webName("@kalle")).toBeNull();
    expect(webName("K")).toBeNull();
    expect(webName("x".repeat(33))).toBeNull();
    expect(webName("a‮b")).toBeNull(); // bidi override
    expect(webName(5)).toBeNull();
  });

  test("an account without Telegram changes its name; one with Telegram can't", async () => {
    const w = world();
    w.provider.claims = w.googleClaims("g-kalle");
    const b = w.browser();
    await b.viaProvider("google");
    await b.call("POST", "/api/auth/signup", PROFILE);
    const res = await b.call("PATCH", "/api/me", { name: "Kalle 2" });
    expect(((await res.json()) as { name: string }).name).toBe("Kalle 2");
    expect((await b.call("PATCH", "/api/me", { name: "@x" })).status).toBe(422);

    const a = w.browser();
    a.jar.set("__Host-kili", w.services.webSessions.createSession(w.alice.id, w.services.identities.key(tg(1))).sessionToken);
    expect((await a.call("PATCH", "/api/me", { name: "Someone" })).status).toBe(409);
  });
});

describe("passkeys", () => {
  type Options = { challenge: string; user: { id: string }; rp: { id: string }; excludeCredentials?: { id: string }[] };

  const signUp = async (w: ReturnType<typeof world>, auth = authenticator()) => {
    const b = w.browser();
    const options = (await (await b.call("POST", "/api/auth/passkey/signup/options", { name: "Kalle" })).json()) as Options;
    expect(options.rp.id).toBe("kili.test");
    const credential = auth.create(options);
    const res = await b.call("POST", "/api/auth/signup", { ...PROFILE, passkey: credential });
    return { b, res, auth, credential };
  };

  test("sign up with a passkey, then sign in with it on another browser", async () => {
    const w = world();
    const { b, res, auth, credential } = await signUp(w);
    expect(res.status).toBe(200);
    expect(((await (await b.call("GET", "/api/me")).json()) as { name: string }).name).toBe("Kalle");

    const other = w.browser();
    const options = (await (await other.call("POST", "/api/auth/passkey/login/options", {})).json()) as Options;
    const login = await other.call("POST", "/api/auth/passkey/login", { response: auth.get(options, credential.id) });
    expect(login.status).toBe(200);
    expect(((await (await other.call("GET", "/api/me")).json()) as { name: string }).name).toBe("Kalle");
    expect(w.services.passkeys.get(credential.id)?.counter).toBe(1);
    expect(w.services.passkeys.get(credential.id)?.lastUsedAt).toBe(w.clock.now);
  });

  test("a challenge works once, and only for what it was made for", async () => {
    const w = world();
    const { auth, credential } = await signUp(w);
    const b = w.browser();
    const options = (await (await b.call("POST", "/api/auth/passkey/login/options", {})).json()) as Options;
    const answer = auth.get(options, credential.id);
    expect((await b.call("POST", "/api/auth/passkey/login", { response: answer })).status).toBe(200);
    // Replayed: the challenge is gone.
    expect((await b.call("POST", "/api/auth/passkey/login", { response: answer })).status).toBe(401);
    // Answering a challenge from another browser.
    const c = w.browser();
    await c.call("POST", "/api/auth/passkey/login/options", {});
    expect((await c.call("POST", "/api/auth/passkey/login", { response: auth.get(options, credential.id) })).status).toBe(401);
    // A sign-in challenge can't be used to sign up.
    const d = w.browser();
    const o2 = (await (await d.call("POST", "/api/auth/passkey/login/options", {})).json()) as Options;
    expect((await d.call("POST", "/api/auth/signup", { ...PROFILE, passkey: authenticator().create({ ...o2, user: { id: "x" } }) })).status).toBe(401);
  });

  test("a passkey made for another site, or a cloned one (counter going back), doesn't sign in", async () => {
    const w = world();
    const b = w.browser();
    const options = (await (await b.call("POST", "/api/auth/passkey/signup/options", {})).json()) as Options;
    const phishing = authenticator().create(options, { origin: "https://kili.evil" });
    expect((await b.call("POST", "/api/auth/signup", { ...PROFILE, passkey: phishing })).status).toBe(400);
    expect(w.db.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });

    const { auth, credential } = await signUp(w);
    const sign = async (counter: number) => {
      const c = w.browser();
      const o = (await (await c.call("POST", "/api/auth/passkey/login/options", {})).json()) as Options;
      return (await c.call("POST", "/api/auth/passkey/login", { response: auth.get(o, credential.id, { counter }) })).status;
    };
    expect(await sign(5)).toBe(200);
    expect(await sign(3)).toBe(401);
    // An unknown passkey.
    const c = w.browser();
    const o = (await (await c.call("POST", "/api/auth/passkey/login/options", {})).json()) as Options;
    const stranger = authenticator();
    const made = stranger.create({ challenge: "x", user: { id: "y" } });
    expect((await c.call("POST", "/api/auth/passkey/login", { response: stranger.get(o, made.id) })).status).toBe(401);
  });

  test("adding a second passkey and removing passkeys", async () => {
    const w = world();
    const { b, credential } = await signUp(w);
    const laptop = authenticator();
    const options = (await (await b.call("POST", "/api/auth/passkey/add/options", {})).json()) as Options;
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([credential.id]);
    expect((await b.call("POST", "/api/auth/passkey/add", { response: laptop.create(options) })).status).toBe(200);
    const view = (await (await b.call("GET", "/api/auth/logins")).json()) as { logins: { platform: string }[]; passkeys: { id: string }[] };
    expect(view.logins.map((l) => l.platform)).toEqual(["passkey"]);
    expect(view.passkeys).toHaveLength(2);

    // One of two can go; the last one is the only way in (and this browser's login).
    expect((await b.call("DELETE", `/api/auth/passkeys/${credential.id}`)).status).toBe(200);
    expect((await b.call("DELETE", `/api/auth/passkeys/${view.passkeys[1]!.id}`)).status).toBe(409);
    expect((await b.call("DELETE", "/api/auth/passkeys/someone-elses")).status).toBe(404);
  });

  test("a Telegram account adds a passkey; its last passkey can go while Telegram is left", async () => {
    const w = world();
    const b = w.browser();
    b.jar.set("__Host-kili", w.services.webSessions.createSession(w.alice.id, w.services.identities.key(tg(1))).sessionToken);
    const auth = authenticator();
    const options = (await (await b.call("POST", "/api/auth/passkey/add/options", {})).json()) as Options;
    const made = auth.create(options);
    expect((await b.call("POST", "/api/auth/passkey/add", { response: made })).status).toBe(200);
    expect(w.services.identities.list(w.alice.id).map((i) => i.platform)).toEqual(["telegram", "passkey"]);
    // Someone else's passkey can't be removed through this account.
    const other = await signUp(w);
    expect((await b.call("DELETE", `/api/auth/passkeys/${other.credential.id}`)).status).toBe(404);
    expect((await b.call("DELETE", `/api/auth/passkeys/${made.id}`)).status).toBe(200);
    expect(w.services.identities.list(w.alice.id).map((i) => i.platform)).toEqual(["telegram"]);
  });
});

describe("FlowStore", () => {
  test("entries expire, are taken once, and the store has a cap", () => {
    let t = 0;
    const s = new FlowStore<number>(1000, () => t, 3);
    const a = s.put(1);
    expect(s.peek(a)).toBe(1);
    expect(s.take(a)).toBe(1);
    expect(s.take(a)).toBeNull();
    const b = s.put(2);
    t = 1000;
    expect(s.take(b)).toBeNull();
    const keys = [s.put(3), s.put(4), s.put(5), s.put(6)];
    expect(s.peek(keys[0])).toBeNull(); // the oldest went
    expect(s.peek(keys[3])).toBe(6);
    expect(s.peek(undefined)).toBeNull();
  });
});

test("every login platform has a name for the bot's Yhdistetyt palvelut", () => {
  for (const p of ["telegram", "discord", "google", "microsoft", "passkey"] as const) expect(PLATFORM_NAMES[p]).toBeTruthy();
});
