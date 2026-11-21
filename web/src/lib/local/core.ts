// A local account: the website without an account, everything kept in this browser (store.ts).
//
// These are the server's handlers for one person (src/web/api/drinks.ts, favorites.ts, me.ts,
// views.ts dashboard) as pure functions over the stored data, using the bot's own estimate and chart
// code (src/lib/alcomath.ts, chart.ts), so a local account sees exactly the numbers the server would
// show. No DOM or storage here: test/localcore.test.ts runs it against the server's answers.

import { calculateEbac } from "../../../../src/lib/alcomath.ts";
import { findPreset } from "../../../../src/lib/catalog.ts";
import { buildChartData } from "../../../../src/lib/chart.ts";
import { alcoholMgFromClPercent, HOUR_MS, isAlcoholAmountOutOfLimits, MINUTE_MS, toStandardDrinks } from "../../../../src/lib/units.ts";
import type {
  ChartData,
  Dashboard,
  DrinkItem,
  DrinkLog,
  Favorites,
  Gender,
  LocalDrink,
  LogDrinkRequest,
  Me,
  ServingDrink,
} from "../../../../shared/api.ts";

/** The same limits as the server's (services/drinks.ts, favorites.ts, api/drinks.ts). */
export const SESSION_GAP_MS = 6 * HOUR_MS;
export const EBAC_WINDOW_MS = 3 * 24 * HOUR_MS;
export const MAX_FAVORITES = 8;
const MAX_BACKDATE_MS = 7 * 24 * HOUR_MS;
const MAX_SESSION_CHART_MS = 7 * 24 * HOUR_MS;
const LOG_PAGE = 100;
const LOG_PAGE_MAX = 200;
/** Stands for the person in the chart (its colour slot); the server uses the account id. */
const CHART_ID = "local";

export interface LocalProfile {
  name: string;
  weight: number;
  height: number;
  gender: Gender;
  createdAt: number;
}

export interface StoredDrink extends LocalDrink {
  id: number;
}

export interface StoredFavorite extends Omit<LocalDrink, "createdAt"> {
  id: number;
  createdAt: number;
}

export interface LocalData {
  version: 1;
  profile: LocalProfile;
  /** Oldest first (by createdAt, then id), as the server's queries order them. */
  drinks: StoredDrink[];
  favorites: StoredFavorite[];
  nextId: number;
}

/** An error the pages show with errorText, the same codes the server answers. */
export class LocalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function newLocalData(profile: Omit<LocalProfile, "createdAt">, now: number): LocalData {
  return { version: 1, profile: { ...profile, createdAt: now }, drinks: [], favorites: [], nextId: 1 };
}

export const toItem = (d: StoredDrink): DrinkItem => ({
  id: d.id,
  description: d.description,
  alcoholMg: d.alcoholMg,
  standardDrinks: toStandardDrinks(d.alcoholMg / 1000),
  kcal: d.kcal,
  createdAt: d.createdAt,
});

const order = (a: StoredDrink, b: StoredDrink) => a.createdAt - b.createdAt || a.id - b.id;

export function me(data: LocalData): Me {
  const { name, weight, height, gender } = data.profile;
  return { name, chartName: "username", chartLabel: name, weight, height, gender, admin: false, telegram: false };
}

const since = (data: LocalData, t: number) => data.drinks.filter((d) => d.createdAt > t);

/** The current session: drinks with no pause of 6 h between them, up to now (Drinks.session). */
export function session(data: LocalData, now: number): StoredDrink[] {
  const recent = since(data, now - EBAC_WINDOW_MS);
  let edge = now;
  const out: StoredDrink[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const d = recent[i]!;
    if (edge - d.createdAt > SESSION_GAP_MS) break;
    out.push(d);
    edge = d.createdAt;
  }
  return out.reverse();
}

const series = (data: LocalData, drinks: StoredDrink[]) => [{ id: CHART_ID, name: data.profile.name, body: data.profile, drinks }];

/** The front page (views.ts dashboard). */
export function dashboard(data: LocalData, now: number): Dashboard {
  const recent = since(data, now - EBAC_WINDOW_MS);
  const ebac = calculateEbac(data.profile, recent, now);
  const s = session(data, now);
  const { admin: _a, telegram: _t, ...body } = me(data);
  return {
    now,
    me: body,
    permille: ebac.permilles,
    soberAt: ebac.burnHours > 0 ? now + ebac.burnHours * HOUR_MS : null,
    session: {
      drinks: s.map(toItem),
      standardDrinks: toStandardDrinks(s.reduce((sum, d) => sum + d.alcoholMg, 0) / 1000),
      kcal: s.reduce((sum, d) => sum + (d.kcal ?? 0), 0),
      unknownKcal: s.filter((d) => d.kcal === null).length,
    },
    chart: buildChartData(series(data, recent), now),
  };
}

/** Adds a drink; the same drink in the same millisecond is nudged by one, as on the server. */
export function addDrink(data: LocalData, d: Omit<LocalDrink, "createdAt">, at: number): StoredDrink {
  let t = at;
  while (data.drinks.some((x) => x.createdAt === t && x.alcoholMg === d.alcoholMg && x.description === d.description)) t += 1;
  const kcal = d.kcal === null ? null : Math.max(0, Math.round(d.kcal));
  const drink: StoredDrink = { id: data.nextId++, alcoholMg: d.alcoholMg, description: d.description, productId: d.productId, kcal, createdAt: t };
  data.drinks.push(drink);
  data.drinks.sort(order);
  return drink;
}

export const lastDrink = (data: LocalData): StoredDrink | null => data.drinks.at(-1) ?? null;

/**
 * Logs a drink (POST /api/drinks). `serving` resolves a catalogue serving: the server knows the
 * catalogue, so it is asked what the serving is (GET /api/products/:id/servings/:key).
 */
export async function logDrink(
  data: LocalData,
  r: LogDrinkRequest,
  now: number,
  serving: (productId: string, key: string) => Promise<ServingDrink>,
): Promise<StoredDrink> {
  let at = now;
  if (r.at !== undefined) {
    if (typeof r.at !== "number" || !Number.isSafeInteger(r.at) || r.at < now - MAX_BACKDATE_MS || r.at > now + MINUTE_MS) {
      throw new LocalError(422, "invalid_time");
    }
    at = Math.min(r.at, now);
  }
  switch (r.kind) {
    case "preset": {
      const preset = findPreset(r.id);
      if (!preset) throw new LocalError(404, "unknown_preset");
      return addDrink(data, { alcoholMg: preset.mg, description: preset.name, productId: null, kcal: preset.kcal }, at);
    }
    case "product": {
      const s = await serving(r.productId, r.serving);
      return addDrink(data, s, at);
    }
    case "custom": {
      const { cl, percent } = r;
      if (!Number.isFinite(cl) || cl <= 0 || cl > 250 || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
        throw new LocalError(422, "invalid_amount");
      }
      const mg = alcoholMgFromClPercent(cl, percent);
      if (isAlcoholAmountOutOfLimits(mg)) throw new LocalError(422, "too_much");
      return addDrink(data, { alcoholMg: mg, description: `Oma juoma - ${cl}cl ${percent}%`, productId: null, kcal: null }, at);
    }
    case "repeat": {
      const last = lastDrink(data);
      if (!last) throw new LocalError(404, "nothing_to_repeat");
      return addDrink(data, last, at);
    }
    case "favorite": {
      const fav = data.favorites.find((f) => f.id === r.id);
      if (!fav) throw new LocalError(404, "not_found");
      return addDrink(data, fav, at);
    }
  }
}

export function undo(data: LocalData): StoredDrink {
  const last = data.drinks.pop();
  if (!last) throw new LocalError(404, "nothing_to_undo");
  return last;
}

export function removeDrink(data: LocalData, id: number) {
  const i = data.drinks.findIndex((d) => d.id === id);
  if (i < 0) throw new LocalError(404, "not_found");
  data.drinks.splice(i, 1);
}

export interface LogFilter {
  from?: number;
  to?: number;
  q?: string;
  before?: string;
  limit?: number;
}

/** The logbook (GET /api/drinks): newest first, a page at a time, totals over everything matched. */
export function logbook(data: LocalData, f: LogFilter): DrinkLog {
  const q = (f.q ?? "").slice(0, 80).trim();
  // SQLite's LIKE (Drinks.page) is case-insensitive for ASCII only; so is this.
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const matched = data.drinks.filter(
    (d) => (f.from === undefined || d.createdAt >= f.from) && (f.to === undefined || d.createdAt < f.to) && (!q || fold(d.description).includes(fold(q))),
  );
  const limit = Math.min(Math.max(f.limit ?? LOG_PAGE, 1), LOG_PAGE_MAX);
  let rows = [...matched].reverse();
  const m = f.before ? /^(\d{1,15})\.(\d{1,15})$/.exec(f.before) : null;
  if (m) {
    const at = Number(m[1]);
    const id = Number(m[2]);
    rows = rows.filter((d) => d.createdAt < at || (d.createdAt === at && d.id < id));
  }
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  let sessions = 0;
  let prev = -Infinity;
  for (const d of matched) {
    if (d.createdAt - prev > SESSION_GAP_MS) sessions += 1;
    prev = d.createdAt;
  }
  const last = page.at(-1);
  return {
    drinks: page.map(toItem),
    totals: {
      count: matched.length,
      standardDrinks: toStandardDrinks(matched.reduce((s, d) => s + d.alcoholMg, 0) / 1000),
      kcal: matched.reduce((s, d) => s + (d.kcal ?? 0), 0),
      unknownKcal: matched.filter((d) => d.kcal === null).length,
      sessions,
    },
    next: more && last ? `${last.createdAt}.${last.id}` : null,
  };
}

/** A past session's curve (GET /api/drinks/chart). */
export function sessionChart(data: LocalData, first: number, last: number, now: number): ChartData {
  if (last < first || last - first > MAX_SESSION_CHART_MS) throw new LocalError(400, "bad_request");
  const history = { from: first - HOUR_MS, to: Math.min(last + 12 * HOUR_MS, now) };
  const samples = since(data, first - EBAC_WINDOW_MS).filter((d) => d.createdAt <= history.to);
  return buildChartData(series(data, samples), now, history);
}

export function favorites(data: LocalData, result?: Favorites["result"]): Favorites {
  return {
    favorites: data.favorites.map((f) => ({ id: f.id, description: f.description, standardDrinks: toStandardDrinks(f.alcoholMg / 1000), kcal: f.kcal })),
    max: MAX_FAVORITES,
    ...(result ? { result } : {}),
  };
}

export function pinFavorite(data: LocalData, drinkId: number, now: number): Favorites {
  const d = data.drinks.find((x) => x.id === drinkId);
  if (!d) throw new LocalError(404, "not_found");
  if (data.favorites.some((f) => f.description === d.description && f.alcoholMg === d.alcoholMg)) return favorites(data, "exists");
  if (data.favorites.length >= MAX_FAVORITES) return favorites(data, "full");
  data.favorites.push({ id: data.nextId++, description: d.description, alcoholMg: d.alcoholMg, productId: d.productId, kcal: d.kcal, createdAt: now });
  return favorites(data, "added");
}

export function unpinFavorite(data: LocalData, id: number): Favorites {
  const i = data.favorites.findIndex((f) => f.id === id);
  if (i < 0) throw new LocalError(404, "not_found");
  data.favorites.splice(i, 1);
  return favorites(data);
}

export const LIMITS = { weight: { min: 20, max: 250 }, height: { min: 120, max: 240 } } as const;

/** A name as the server takes it for accounts without Telegram (accounts.ts webName). */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  const length = [...name].length;
  if (length < 2 || length > 32 || name.startsWith("@") || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

/** The profile as typed in a form, checked like the server checks a sign-up; throws LocalError. */
export function checkProfile(p: { name: unknown; weight: unknown; height: unknown; gender: unknown }): Omit<LocalProfile, "createdAt"> {
  const name = cleanName(p.name);
  if (!name) throw new LocalError(422, "invalid_user_name");
  const ok = (v: unknown, l: { min: number; max: number }) => typeof v === "number" && Number.isInteger(v) && v >= l.min && v <= l.max;
  if (!ok(p.weight, LIMITS.weight)) throw new LocalError(422, "invalid_weight");
  if (!ok(p.height, LIMITS.height)) throw new LocalError(422, "invalid_height");
  if (p.gender !== "mies" && p.gender !== "nainen") throw new LocalError(422, "invalid_gender");
  return { name, weight: p.weight as number, height: p.height as number, gender: p.gender };
}

/** Settings (PATCH /api/me); only the fields given change. */
export function updateProfile(data: LocalData, changes: Partial<Pick<Me, "name" | "weight" | "height" | "gender">>): Me {
  const next = checkProfile({ ...data.profile, ...changes });
  data.profile = { ...data.profile, ...next };
  return me(data);
}

/** A stored value that isn't a LocalData (another version, or damaged) is treated as none. */
export function isLocalData(v: unknown): v is LocalData {
  if (!v || typeof v !== "object") return false;
  const d = v as Partial<LocalData>;
  return d.version === 1 && !!d.profile && typeof d.profile.name === "string" && Array.isArray(d.drinks) && Array.isArray(d.favorites) && typeof d.nextId === "number";
}
