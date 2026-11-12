// Shapes the website's API returns. Imported by the server (src/web) and the SvelteKit app
// (web/), so the two can't drift apart. Types only: no runtime code, no dependencies.

/** One person's line as data, for the website's chart (which draws it itself). */
export interface ChartLine {
  id: string;
  name: string;
  /** One of the bot chart's light-mode palette colours; the site maps it to its dark-mode step. */
  color: string;
  current: number; // ‰ now
  peak: number;
  points: [t: number, permille: number][]; // every 15 minutes, plus "now"
}

export interface ChartData {
  now: number;
  from: number;
  to: number;
  lines: ChartLine[]; // highest peak first; people who never reach the threshold are left out
  /** A finished stretch of time (a logbook session): no "now" marker or forecast, `now` is `to`. */
  history?: boolean;
}

export type ChartName = "full" | "username";
export type Gender = "mies" | "nainen";

export interface Me {
  name: string; // @username, or the full name if there is none
  chartName: ChartName;
  chartLabel: string; // what charts show for this person
  weight: number;
  height: number;
  gender: Gender;
  /** Signed in with a Telegram account listed in ADMIN_IDS: may open /admin. */
  admin: boolean;
}

/** GET /api/auth/sessions: how many browsers are signed in to the account. */
export interface SessionsInfo {
  count: number;
}

export interface DrinkItem {
  id: number;
  description: string;
  alcoholMg: number;
  standardDrinks: number;
  kcal: number | null;
  createdAt: number;
}

/**
 * GET /api/drinks?from=&to=&q=&before=&limit=: the logbook. `from` (inclusive) and `to`
 * (exclusive) are epoch ms, chosen by the browser so days follow its time zone; `q` is matched
 * against descriptions. Newest first; pass `next` back as `before` for the following page.
 */
export interface DrinkLog {
  drinks: DrinkItem[];
  /** Over everything the filters match, not only this page. */
  totals: {
    count: number;
    standardDrinks: number;
    kcal: number;
    unknownKcal: number;
    /** Drinking sessions (separated by a pause of 6 h), as "this evening" on the front page. */
    sessions: number;
  };
  next: string | null;
}

export interface Dashboard {
  now: number;
  me: Omit<Me, "admin">;
  permille: number;
  /** When the estimate reaches zero; null when sober now. */
  soberAt: number | null;
  /** Drinks of the current session (no pause of 6 h), oldest first. */
  session: { drinks: DrinkItem[]; standardDrinks: number; kcal: number; unknownKcal: number };
  chart: ChartData;
}

export interface ServingItem {
  key: string;
  label: string;
  standardDrinks: number;
  kcal: number | null;
  priceEur: number | null;
}

export interface ProductItem {
  id: string;
  name: string;
  maker: string | null;
  abv: number;
  type: string;
  emoji: string;
  /** Alko has a photo at /api/products/<id>/photo (user-added products have none). */
  photo: boolean;
  servings: ServingItem[];
}

export interface PresetItem {
  id: string;
  name: string;
  standardDrinks: number;
  kcal: number;
  category: "miedot" | "viinit" | "shotit";
}

export interface Config {
  botUsername: string;
  botId: number; // for Telegram's login page (oauth.telegram.org/auth?bot_id=…)
  catalogue: boolean; // product search is available
  barcodes: boolean; // barcode lookups are available (the catalogue or the API Worker)
  presets: PresetItem[];
}

/** POST /api/drinks. */
export type LogDrinkRequest = (
  | { kind: "preset"; id: string }
  | { kind: "product"; productId: string; serving: string }
  | { kind: "custom"; cl: number; percent: number }
  | { kind: "repeat" }
  | { kind: "favorite"; id: number }
) & {
  /** When the drink was had (epoch ms), for forgotten drinks: at most a week ago, never in the future. Default: now. */
  at?: number;
};

/** A pinned drink (GET /api/favorites): logging it adds the same amount again. */
export interface FavoriteItem {
  id: number;
  description: string;
  standardDrinks: number;
  kcal: number | null;
}

/** GET /api/favorites; also the answer to POST (pinning a logged drink), with what happened. */
export interface Favorites {
  favorites: FavoriteItem[];
  max: number;
  result?: "added" | "exists" | "full";
}

/** A line of text on a docs page: plain, bold, code or a link. */
export interface Inline {
  text: string;
  bold?: boolean;
  code?: boolean;
  href?: string;
}

/** The bot's help, terms and privacy texts as blocks (GET /api/docs/:page, public). */
export interface DocBlock {
  type: "section" | "heading" | "paragraph" | "item";
  inline: Inline[];
}

export type DocPage = "help" | "terms" | "privacy";

/** POST /api/account/import: what happened to one CSV file. */
export interface ImportOutcome {
  ok: boolean;
  message: string;
}


// ---------- barcodes ----------

export type CustomKind = "olut" | "viini" | "kuohu" | "vakeva" | "muu";

/** A product users added for a barcode Alko doesn't know. Shared by everyone. */
export interface CustomProductItem {
  ean: string;
  kind: CustomKind;
  name: string;
  sizeL: number;
  abv: number;
  kcal100: number | null;
  /** Added by this account, or the viewer is an admin. */
  canEdit: boolean;
}

/**
 * GET /api/barcodes/<ean>: what a barcode leads to. Errors: 422 invalid_barcode, 429
 * barcode_rate_limited (the Worker's limit, shared by everyone), 503 barcode_unavailable.
 */
export type BarcodeResult =
  | { status: "found"; ean: string; product: ProductItem; custom: CustomProductItem | null }
  /** Alko doesn't know it: a product can be added. */
  | { status: "unknown"; ean: string }
  /** Alko's product, no longer sold there: a product can be added. */
  | { status: "gone"; ean: string }
  /** Alko's product, but under 1 %: can't be logged. */
  | { status: "alcohol_free"; ean: string; name: string };

/**
 * POST /api/barcodes/<ean>/report: "Ilmoita virheestä" on a user-added product; the admins are
 * told. Errors: 404 not_found, 422 invalid_report, 429 too_many_reports.
 */
export interface ProductReportRequest {
  message: string;
}

/** PUT /api/barcodes/<ean>/product: add the product, or change one the viewer may edit. */
export interface CustomProductRequest {
  kind: CustomKind;
  name: string;
  sizeL: number;
  abv: number;
  kcal100: number | null;
}

// ---------- groups and event screens ----------

export type GroupKind = "telegram" | "web";

export interface GroupSummary {
  id: string;
  name: string;
  kind: GroupKind;
  memberCount: number;
  /** May rename, remove members, delete and rotate the invite (web groups only). */
  isOwner: boolean;
  /** This member shows as "Nimetön" on shared screens. */
  hideOnScreen: boolean;
}

export interface BoardRow {
  /** Opaque handle of the member inside this group (used to remove them). */
  ref: string;
  name: string;
  permille: number;
  /** Alcohol drunk in the last 12 hours, in standard drinks. */
  standardDrinks12h: number;
  /** Chooses to be shown as "Nimetön" on screens. Only meaningful in the members' own view. */
  hidden: boolean;
  isMe: boolean;
}

export interface ScreenLinkItem {
  ref: string;
  createdAt: number;
  expiresAt: number;
  /** Created by the viewer (who can therefore revoke it even when not the owner). */
  mine: boolean;
}

export interface GroupView {
  now: number;
  group: GroupSummary;
  chart: ChartData;
  /** Everyone, highest first. */
  members: BoardRow[];
  /** When the live invite link expires; null when there is none. Only the owner sees this. */
  inviteExpiresAt: number | null;
  screens: ScreenLinkItem[];
}

/** What an event screen shows: no controls, and hidden members are anonymised. */
export interface ScreenView {
  now: number;
  title: string;
  kind: "group" | "person";
  chart: ChartData;
  /** Empty for a person. */
  members: Pick<BoardRow, "name" | "permille" | "standardDrinks12h">[];
  expiresAt: number;
  /** A Telegram group whose photo can be asked for at /api/screen/photo (it may still turn out to have none). */
  photo: boolean;
  /** The group's page on the website is /groups/<id> (members only); null for a person's screen. */
  groupId: string | null;
}

// ---------- admin ----------

export interface AdminProduct {
  ean: string;
  kind: CustomKind;
  name: string;
  sizeL: number;
  abv: number;
  kcal100: number | null;
  /** The account that added it no longer exists. */
  orphan: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A user-added product with open "Ilmoita virheestä" reports, newest first. */
export interface AdminReportedProduct extends AdminProduct {
  reports: { message: string; createdAt: number }[];
}

/** GET /api/admin: only for sessions signed in with a Telegram account in ADMIN_IDS. */
export interface AdminView {
  now: number;
  bot: {
    users: number;
    activeUsers7: number;
    activeUsers14: number;
    groups: number;
    activeGroups7: number;
    activeGroups14: number;
    drinks: number;
    drinks24h: number;
    /** Most drinks logged of all time (decrypted chart names, as in /admin_stats). */
    top: { name: string; value: number }[];
  };
  web: {
    /** Live sessions, and the distinct accounts behind them. */
    sessions: number;
    accounts: number;
    /** Accounts that used the site in the last 24 hours. */
    activeAccounts1: number;
    /** Open live-update streams right now (pages and event screens). */
    liveViewers: number;
    webGroups: number;
    screenLinks: number;
  };
  catalogue: { ready: boolean; drinks: number };
  customProducts: { total: number; items: AdminProduct[] };
  /** Products users have reported; cleared with DELETE /api/admin/products/<ean>/reports. */
  reported: AdminReportedProduct[];
}

export interface ApiError {
  error: string;
}

