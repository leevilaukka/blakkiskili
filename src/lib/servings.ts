// How much of a catalogue drink counts as "one drink". A product is a package (a bottle, a
// 24-pack); what gets logged is a serving: a can, a 12 cl glass, a 4 cl shot, a whole bottle.
// The same drink sold in several sizes is merged into one entry whose servings are the union
// (Jaloviina 0.5 l and 0.7 l → 2/4/6 cl; Karhu 33 cl and 50 cl → both cans).
// Rules were chosen from the actual Alkometriikka data (types, sizes, packaging).

import { alcoholMg, isAlcoholAmountOutOfLimits, STANDARD_DRINK_GRAMS } from "./units.ts";

export interface CatalogProduct {
  id: string; // Alko product number
  name: string;
  maker: string | null;
  sizeL: number; // whole package, e.g. 1.98 for a 6-pack of 33 cl
  abv: number; // percent
  type: string; // Viinit, Väkevät, Panimotuotteet, Välituotteet, Alkoholittomat
  subtype: string | null;
  packaging: string | null; // tölkki, lasipullo, hanapakkaus, ...
  selection: string | null; // vakiovalikoima, tilausvalikoima, ...
  status: string | null; // Aktiivinen, Poistuva, Uutuus, ...
  price: number | null; // euros
}

export interface Serving {
  /** Unique within a drink: "c33" a 33 cl container, "b75" a whole 75 cl bottle, "4" a 4 cl pour, "x25" a custom 25 cl. */
  key: string;
  label: string; // the amount only: "33 cl", "12 cl", "4 cl"
  litres: number;
  mg: number;
  standardDrinks: number;
  /** The concrete Alko product this serving comes from (stored on the logged drink). */
  productId: string;
}

/** One searchable drink: every package size of the same product merged. */
export interface CatalogDrink {
  id: string; // the representative product's id (used in buttons and inline results)
  name: string; // representative's name without package words
  product: CatalogProduct; // representative: maker, type, ABV shown to users
  variants: CatalogProduct[];
  servings: Serving[];
}

const PACK = /(\d+)\s*-?\s*pack\b/i;

/** Containers in a multipack ("Karhu 5,3 6-pack tölkki" → 6), else 1. */
export function packCount(name: string): number {
  const n = Number(PACK.exec(name)?.[1] ?? 1);
  return n >= 1 && n <= 48 ? n : 1;
}

export const cl = (litres: number) => {
  const v = Math.round(litres * 1000) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

const PACKAGING_IN_NAME =
  /(^|\s)(\d+\s*-?\s*pack|kartonkitölkki|lasipullo|muovipullo|paperipullo|tölkki|pullo|hanapakkaus|viinipussi)(?=\s|$)/giu;

/** Name without package words: "Karhu 5,3 6-pack tölkki" → "Karhu 5,3". One entry covers all packages. */
export function cleanName(name: string): string {
  const cleaned = name.replace(PACKAGING_IN_NAME, "$1").replace(/\s+/g, " ").trim();
  return cleaned || name;
}

export function emojiFor(p: Pick<CatalogProduct, "type" | "subtype">): string {
  if (p.type === "Panimotuotteet") return "🍺";
  if (p.type === "Väkevät") return "🥃";
  if ((p.subtype ?? "").startsWith("kuohuviinit")) return "🥂";
  return "🍷";
}

/** Servings one package offers. Empty for (nearly) non-alcoholic products. */
export function servingsFor(p: CatalogProduct): Serving[] {
  if (!(p.abv >= 1)) return [];
  const make = (key: string, label: string, litres: number): Serving => {
    const mg = alcoholMg(p.abv / 100, litres);
    return { key, label, litres, mg, standardDrinks: mg / 1000 / STANDARD_DRINK_GRAMS, productId: p.id };
  };
  const pours = (...cls: number[]) => cls.map((c) => make(String(c), `${c} cl`, c / 100));
  const whole = (unit: number) => make(`c${cl(unit)}`, `${cl(unit)} cl`, unit);

  const unit = p.sizeL / packCount(p.name);
  let out: Serving[];
  switch (p.type) {
    case "Panimotuotteet": // beers, ciders, long drinks
      out = unit <= 0.75 ? [whole(unit)] : pours(33, 50);
      break;
    case "Viinit":
      if (unit <= 0.25) out = [whole(unit)];
      else out = [...pours(12, 16), ...(unit <= 1 ? [make(`b${cl(unit)}`, `${cl(unit)} cl`, unit)] : [])];
      break;
    case "Väkevät":
      out = unit <= 0.06 ? [whole(unit)] : pours(2, 4, 6);
      break;
    case "Välituotteet": // port, sherry, vermouth
      out = pours(4, 8);
      break;
    default:
      out = unit <= 0.75 ? [whole(unit)] : pours(12);
  }
  // A single serving over the sanity limit (e.g. a 16 % beer in 75 cl) falls back to glasses.
  const ok = out.filter((s) => !isAlcoholAmountOutOfLimits(s.mg));
  if (ok.length === 0 && out.length > 0) return pours(12).filter((s) => !isAlcoholAmountOutOfLimits(s.mg));
  return ok;
}

/**
 * Union of the servings of all package sizes of one drink, smallest first. Where two give the
 * same amount (a 4 cl mini and a 4 cl pour, a 33 cl can and a 33 cl glass from a keg), the
 * representative's (first variant's) serving wins.
 */
export function mergeServings(variantsRepFirst: readonly CatalogProduct[]): Serving[] {
  const byLitres = new Map<string, Serving>();
  for (const v of variantsRepFirst) {
    for (const s of servingsFor(v)) {
      const k = s.litres.toFixed(4);
      if (!byLitres.has(k)) byLitres.set(k, s);
    }
  }
  let out = [...byLitres.values()];
  // Spirits are poured: once 2/4/6 cl exist, a 5 cl mini bottle is just clutter.
  const rep = variantsRepFirst[0];
  if (rep?.type === "Väkevät" && out.some((s) => /^\d/.test(s.key))) out = out.filter((s) => /^\d/.test(s.key));
  return out.sort((a, b) => a.litres - b.litres);
}

/** What gets stored as the drink description, e.g. "🍺 Karhu 4,6 (33 cl)". */
export function servingDescription(drink: CatalogDrink, s: Serving): string {
  const name = [...drink.name].length > 60 ? [...drink.name].slice(0, 59).join("") + "…" : drink.name;
  return `${emojiFor(drink.product)} ${name} (${cl(s.litres)} cl)`;
}

// ---------- custom amounts ----------

const UNIT_LITRES: Record<string, number> = { ml: 0.001, cl: 0.01, dl: 0.1, l: 1 };
const AMOUNT = "(\\d+(?:[.,]\\d+)?)\\s*(ml|cl|dl|l)";

/** "3 cl", "25" (cl by default), "0,5 l", "2dl", "250 ml" → litres; null if not an amount. */
export function parseAmount(text: string, defaultUnit: "cl" | null = "cl"): number | null {
  const m = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(ml|cl|dl|l)?$`, "i").exec(text.trim());
  if (!m) return null;
  const unit = m[2]?.toLowerCase() ?? defaultUnit;
  if (!unit) return null;
  const litres = Number(m[1]!.replace(",", ".")) * UNIT_LITRES[unit]!;
  return litres > 0 ? litres : null;
}

/**
 * Splits an amount off the end of a search: "jallu 3 cl" → { query: "jallu", litres: 0.03 }.
 * A unit is required ("karhu 4,6" is a product name, not an amount).
 */
export function splitAmount(text: string): { query: string; litres?: number } {
  const m = new RegExp(`^(.*\\S)\\s+${AMOUNT}$`, "i").exec(text.trim());
  if (!m) return { query: text.trim() };
  return { query: m[1]!, litres: parseAmount(`${m[2]}${m[3]}`, null) ?? undefined };
}

/** A serving of any amount (1 ml – 2 l), as long as it's within the single-drink limit. */
export function customServing(
  drink: CatalogDrink,
  litres: number,
): { serving: Serving } | { error: "invalid" | "too_much" } {
  if (!(litres >= 0.001 && litres <= 2)) return { error: "invalid" };
  const rounded = Math.round(litres * 10000) / 10000;
  const mg = alcoholMg(drink.product.abv / 100, rounded);
  if (isAlcoholAmountOutOfLimits(mg)) return { error: "too_much" };
  return {
    serving: {
      key: `x${cl(rounded)}`,
      label: `${cl(rounded)} cl`,
      litres: rounded,
      mg,
      standardDrinks: mg / 1000 / STANDARD_DRINK_GRAMS,
      productId: drink.id,
    },
  };
}

/** A listed serving by key, or a custom one ("x3" = 3 cl). */
export function resolveServing(drink: CatalogDrink, key: string): Serving | undefined {
  const listed = drink.servings.find((s) => s.key === key);
  if (listed) return listed;
  if (!/^x\d+(\.\d+)?$/.test(key)) return undefined;
  const r = customServing(drink, Number(key.slice(1)) / 100);
  return "serving" in r ? r.serving : undefined;
}

/** "0.9 annosta" */
export const standardDrinksText = (s: Serving) => `${s.standardDrinks.toFixed(1)} annosta`;
