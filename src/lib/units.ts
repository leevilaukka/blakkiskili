// Alcohol unit helpers and limits, ported from the original app/constants.js.

export const ETHANOL_GRAMS_PER_LITRE = 789.24;
export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const METABOLISM_RATE = 0.17; // permilles per hour
export const STANDARD_DRINK_GRAMS = 12.0; // Finnish standard drink

/** Milligrams of pure alcohol in `litres` of a drink with `abv` (0..1). */
export function alcoholMg(abv: number, litres: number): number {
  return Math.round(abv * ETHANOL_GRAMS_PER_LITRE * litres * 1000);
}

/** Convenience: centilitres and percent, as users type them ("33 4.7"). */
export function alcoholMgFromClPercent(cl: number, percent: number): number {
  return alcoholMg(percent / 100, cl / 100);
}

/** A 75cl bottle of 14% sparkling wine. Anything above this in one go is treated as a typo. */
export const SINGLE_DRINK_ALCOHOL_LIMIT_MG = alcoholMg(0.14, 0.75);

export function isAlcoholAmountOutOfLimits(mg: number): boolean {
  return mg > SINGLE_DRINK_ALCOHOL_LIMIT_MG;
}

export function toStandardDrinks(grams: number): number {
  return grams / STANDARD_DRINK_GRAMS;
}

export function roundTo(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Parses "4,7", "4.7", "4.7%", "33cl" the way the original bot accepted them. */
export function parseNumber(raw: string | undefined, ...suffixes: string[]): number {
  if (raw === undefined) return NaN;
  let s = raw.trim().toLowerCase().replace(/,/g, ".");
  for (const suffix of suffixes) {
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

export function parseIntStrict(raw: string | undefined): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return NaN;
  return Number.parseInt(raw, 10);
}
