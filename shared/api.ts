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
}

export interface DrinkItem {
  id: number;
  description: string;
  alcoholMg: number;
  standardDrinks: number;
  kcal: number | null;
  createdAt: number;
}

export interface Dashboard {
  now: number;
  me: Me;
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
  botUsername: string; // for the Telegram Login Widget
  catalogue: boolean; // product search is available
  presets: PresetItem[];
}

/** POST /api/drinks. */
export type LogDrinkRequest =
  | { kind: "preset"; id: string }
  | { kind: "product"; productId: string; serving: string }
  | { kind: "custom"; cl: number; percent: number }
  | { kind: "repeat" };

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

export interface ApiError {
  error: string;
}
