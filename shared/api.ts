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

export interface ApiError {
  error: string;
}
