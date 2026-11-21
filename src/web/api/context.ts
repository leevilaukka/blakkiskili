// What every API handler gets: the request context (one per request) and the shared dependencies
// (one per app).

import type { BunRequest, Server } from "bun";
import type { Config } from "../../config.ts";
import type { IdentityRef } from "../../services/identities.ts";
import type { LoginProvider } from "../../../shared/api.ts";
import type { FlowStore } from "../authflows.ts";
import type { OidcClient, OidcPlatform } from "../oidc.ts";
import type { RateLimiter } from "../../bot/ratelimit.ts";
import type { Profile } from "../../services/accounts.ts";
import type { Services } from "../../services/index.ts";
import type { WebSession } from "../../services/websessions.ts";
import { readJsonBody, type Cookies } from "../http.ts";
import type { GroupAdmins } from "../groupadmins.ts";
import type { GroupPhotos, ProductPhotos } from "../photos.ts";
import type { Live } from "./live.ts";
import type { Views } from "./views.ts";

export interface WebAppOptions {
  services: Services;
  botToken: string;
  /** A function when the username isn't known yet at startup (the bot asks Telegram after the site is up). */
  botUsername: string | (() => string);
  /** Public origin, e.g. "https://kili.example.com" (no trailing slash). */
  origin: string;
  /** Alko's product photos, fetched by the server (see photos.ts); tests pass a fake fetch. */
  photos?: ProductPhotos;
  /** Telegram group photos for event screens; tests pass a fake fetch. */
  groupPhotos?: GroupPhotos;
  /** Telegram group admins (they may stop any of the group's screen links); tests pass a fake fetch. */
  groupAdmins?: GroupAdmins;
  /** Telegram user ids of the admins (ADMIN_IDS); they get /api/admin. */
  adminIds?: readonly number[];
  /** Sends a Telegram HTML message to the admins (new "Ilmoita virheestä" reports). Never throws. */
  notifyAdmins?: (html: string) => Promise<void>;
  /** Sends a Telegram HTML message to an account, in private (an adder was verified). False if it couldn't. Never throws. */
  messageAccount?: (accountId: string, html: string) => Promise<boolean>;
  /** The help, terms and privacy texts as Telegram HTML (bot/context.ts docsHtml), shown at /help, /terms and /privacy. */
  docs?: Record<string, string>;
  /** Sign-in methods besides Telegram (Config.auth); none when left out. */
  auth?: Config["auth"];
  /** The OpenID Connect providers' token and key endpoints; tests pass a fake. */
  oidcFetch?: typeof fetch;
  /** Live-update timing; tests shorten it. */
  live?: { tickMs?: number; minGapMs?: number; maxTotal?: number; maxPerOwner?: number };
}

/** A Google or Microsoft sign-in on its way (see api/logins.ts). `link`: adding it to a signed-in account. */
export interface OAuthFlow {
  platform: OidcPlatform;
  state: string;
  nonce: string;
  verifier: string;
  link: { accountId: string; sessionHash: string } | null;
}

/** A passkey challenge waiting for the browser's answer (see api/passkeys.ts). */
export type PasskeyFlow =
  | { kind: "login"; challenge: string }
  | { kind: "signup"; challenge: string; handle: string }
  | { kind: "add"; challenge: string; accountId: string };

/** May create an account for this login: it signed in fine but has no account yet. */
export interface SignupTicket {
  ref: IdentityRef;
}

/** Shared by all handlers. */
export interface Api {
  services: Services;
  opts: WebAppOptions;
  now: () => number;
  cookies: Cookies;
  views: Views;
  live: Live;
  photos: ProductPhotos;
  groupPhotos: GroupPhotos;
  groupAdmins: GroupAdmins;
  auth: {
    /** Configured sign-in methods, Telegram first (Config.loginProviders). */
    providers: LoginProvider[];
    oidc: Partial<Record<OidcPlatform, OidcClient>>;
    /** Passkeys' relying party id: the site's host name. */
    rpId: string;
    flows: { oauth: FlowStore<OAuthFlow>; passkey: FlowStore<PasskeyFlow>; signup: FlowStore<SignupTicket> };
  };
  /** Signed in with a Telegram login in ADMIN_IDS that still belongs to the account. */
  isAdmin: (s: WebSession) => boolean;
  limits: {
    /** Per client address. */
    signIn: RateLimiter;
    /** New accounts, per client address. */
    signUp: RateLimiter;
    /** Per account (or per address for event screens). */
    api: RateLimiter;
    /** A search shows up to 8 thumbnails, so photos get their own, larger budget. */
    photo: RateLimiter;
    /** Barcode lookups may go on to the API Worker, whose per-IP limit every user of ours shares. */
    barcode: RateLimiter;
  };
}

export type Handler = (c: Ctx) => Response | Promise<Response>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** A module's routes, in Bun.serve's shape: path → method → handler. */
export type Routes = Record<string, Partial<Record<Method, Handler>>>;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not set: the route is missing its guard`);
  return value;
}

/** One request. */
export class Ctx {
  readonly url: URL;
  /** The client's address. The port is reached only through the Cloudflare Tunnel (see server.ts), so its header is trusted. */
  readonly ip: string;
  /** The raw session cookie, for signing out. Set by signedIn. */
  sessionToken: string | null = null;
  /** Set by user. */
  admin = false;
  #session?: WebSession;
  #user?: Profile;
  #body?: Promise<Record<string, unknown> | null>;

  constructor(
    readonly api: Api,
    readonly req: BunRequest,
    readonly server: Server<unknown>,
  ) {
    this.url = new URL(req.url);
    this.ip = req.headers.get("cf-connecting-ip") ?? server.requestIP(req)?.address ?? "unknown";
  }

  /** Set by the signedIn guard; throws if the route doesn't have it (a bug, so a 500). */
  get session(): WebSession {
    return need(this.#session, "session");
  }
  set session(s: WebSession) {
    this.#session = s;
  }
  /** The signed-in account. Set by the user guard. */
  get user(): Profile {
    return need(this.#user, "user");
  }
  set user(p: Profile) {
    this.#user = p;
  }

  /** A path parameter, or null if it doesn't look like `pattern` (Bun's params match anything). */
  param(name: string, pattern: RegExp): string | null {
    const value = (this.req.params as Record<string, string | undefined>)[name];
    return value !== undefined && pattern.test(value) ? value : null;
  }

  /** The JSON object body, or null (see readJsonBody). `max`: a larger limit than 4 KiB (passkeys). */
  body(max?: number): Promise<Record<string, unknown> | null> {
    return (this.#body ??= readJsonBody(this.req, max));
  }
}
