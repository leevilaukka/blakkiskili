// Alko product catalogue from Alkometriikka (https://alkometriikka.fi/data.minimal.json).
//
// Data flows one way: the bot downloads the public catalogue; nothing about users is sent.
// The last good copy is cached on disk so restarts and Alkometriikka outages don't break
// search. Columns are looked up by name from the file's `schema`, not by position.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CatalogDrink, CatalogProduct } from "../lib/servings.ts";
import { normalizeEan } from "../lib/ean.ts";
import { cleanName, mergeServings, packCount, servingsFor } from "../lib/servings.ts";

const REQUIRED = ["Numero", "Nimi", "Pullokoko", "Alkoholi-%", "Tyyppi"] as const;

/** Product types the servings rules know. Anything else (legacy types of removed products) counts as "Muut". */
const KNOWN_TYPES = new Set(["Panimotuotteet", "Viinit", "Väkevät", "Välituotteet", "Alkoholittomat", "Muut"]);

interface RawCatalog {
  schema: string[];
  metadata?: { LastUpdated?: string };
  products: Record<string, { values: unknown[] }>;
}

interface Indexed {
  drink: CatalogDrink;
  tokens: string[]; // normalised words of all variants' names + maker
  name: string; // normalised name of the representative
  removed: boolean; // no longer sold (null Tila): found by product number or EAN, never in search results
}

/** Ranks package variants: the one shown to users and used for pours. */
function representativeScore(p: CatalogProduct): number {
  return (
    (p.selection === "vakiovalikoima" ? 8 : 0) +
    (p.status === "Aktiivinen" || p.status === "Uutuus" ? 4 : 0) +
    (packCount(p.name) === 1 ? 2 : 0) -
    p.name.length * 0.01
  );
}

const PACKAGING_WORDS = /\b(tolkki|pullo|lasipullo|muovipullo|kartonkitolkki|pack)\b/g;

/** Nicknames people actually type (normalised form) → what the catalogue calls them. */
const ALIASES: Record<string, string[]> = {
  jallu: ["jaloviina"],
  kossu: ["koskenkorva"],
  kosu: ["koskenkorva"],
  lonkka: ["lonkero", "long drink"],
  lonkero: ["lonkero", "long drink"],
  siideri: ["siideri", "cider"],
  skumppa: ["kuohuviini", "cava", "prosecco", "samppanja"],
};

/** Lowercase, strip diacritics (ä → a), "4,6" → "4.6", drop punctuation. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** A finite number, or null for missing values (Number(null) would be 0). */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parses and validates a data.minimal.json payload. Throws with a useful message if the format changed. */
export function parseCatalog(json: unknown): { products: CatalogProduct[]; updatedAt: number | null } {
  const raw = json as RawCatalog;
  if (!raw || !Array.isArray(raw.schema) || typeof raw.products !== "object" || raw.products === null) {
    throw new Error("Alkometriikka data file: missing schema or products");
  }
  const col = new Map(raw.schema.map((name, i) => [name, i]));
  const missing = REQUIRED.filter((c) => !col.has(c));
  if (missing.length) throw new Error(`Alkometriikka data file: missing columns ${missing.join(", ")}`);
  const get = (values: unknown[], name: string) => {
    const i = col.get(name);
    return i === undefined ? undefined : values[i];
  };

  const products: CatalogProduct[] = [];
  for (const entry of Object.values(raw.products)) {
    const v = entry?.values;
    if (!Array.isArray(v)) continue;
    const id = String(get(v, "Numero") ?? "");
    const name = str(get(v, "Nimi"));
    const sizeL = num(get(v, "Pullokoko"));
    const abv = num(get(v, "Alkoholi-%"));
    const rawType = str(get(v, "Tyyppi"));
    if (!/^\d{1,10}$/.test(id) || !name || sizeL === null || !(sizeL > 0) || abv === null || !(abv >= 0) || !rawType) continue;
    const type = KNOWN_TYPES.has(rawType) ? rawType : "Muut";
    const price = num(get(v, "Hinta"));
    const kcal100 = num(get(v, "Energia kcal/100 ml"));
    products.push({
      id,
      name,
      maker: str(get(v, "Valmistaja")),
      sizeL,
      abv,
      type,
      subtype: str(get(v, "Alatyyppi")),
      selection: str(get(v, "Valikoima")),
      status: str(get(v, "Tila")),
      price: price !== null && price > 0 ? price : null,
      kcal100: kcal100 !== null && kcal100 >= 0 && kcal100 < 1000 ? kcal100 : null,
      country: str(get(v, "Valmistusmaa")),
      ean: normalizeEan(str(get(v, "EAN")) ?? ""),
    });
  }
  if (products.length === 0) throw new Error("Alkometriikka data file: no usable products");
  const updatedAt = Date.parse(raw.metadata?.LastUpdated ?? "");
  return { products, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null };
}

export interface ProductsOptions {
  url?: string; // undefined = catalogue disabled
  cachePath?: string;
  fetch?: typeof fetch;
}

export class Products {
  private byId = new Map<string, Indexed>();
  private byEanMap = new Map<string, string>();
  private skipped = new Map<string, CatalogProduct>(); // in the catalogue but not drinkable (alcohol-free)
  private list: Indexed[] = [];
  private etag: string | null = null;
  private lastModified: string | null = null;
  updatedAt: number | null = null;

  constructor(private readonly opts: ProductsOptions = {}) {}

  get enabled(): boolean {
    return Boolean(this.opts.url);
  }

  get ready(): boolean {
    return this.list.length > 0;
  }

  /** Searchable drinks (package sizes merged). */
  get count(): number {
    return this.list.length;
  }

  /**
   * Replaces the catalogue. Only products with at least one serving are searchable, and every
   * package size of the same drink (same name apart from packaging words, same type and ABV)
   * becomes one entry.
   */
  load(json: unknown) {
    const { products, updatedAt } = parseCatalog(json);
    const groups = new Map<string, CatalogProduct[]>();
    const skipped = new Map<string, CatalogProduct>();
    for (const product of products) {
      if (servingsFor(product).length === 0) {
        skipped.set(product.id, product);
        continue;
      }
      const base = normalize(product.name)
        .replace(/\b\d+ ?pack\b/g, "")
        .replace(PACKAGING_WORDS, "")
        .replace(/\s+/g, " ")
        .trim();
      // Stars are dropped by normalize() but tell products apart (Jaloviina * vs ***).
      const stars = (product.name.match(/\*/g) ?? []).length;
      // Removed products stay apart from sold ones so they never add servings to an active drink.
      const key = `${product.type}|${base}|${stars}|${product.abv}|${product.status === null ? "removed" : ""}`;
      const group = groups.get(key);
      if (group) group.push(product);
      else groups.set(key, [product]);
    }

    const list: Indexed[] = [];
    const byId = new Map<string, Indexed>();
    for (const variants of groups.values()) {
      // Representative: best selection/status; then one you pour from rather than a mini
      // (more servings); then the bigger package.
      variants.sort(
        (a, b) =>
          representativeScore(b) - representativeScore(a) ||
          servingsFor(b).length - servingsFor(a).length ||
          b.sizeL - a.sizeL,
      );
      const rep = variants[0]!;
      const drink: CatalogDrink = { id: rep.id, name: cleanName(rep.name), product: rep, variants, servings: mergeServings(variants) };
      const words = variants.flatMap((v) => normalize(`${v.name} ${v.maker ?? ""}`).split(" "));
      const removed = rep.status === null;
      const x: Indexed = { drink, tokens: [...new Set(words.filter(Boolean))], name: normalize(rep.name), removed };
      if (!removed) list.push(x);
      for (const v of variants) byId.set(v.id, x);
    }
    const byEan = new Map<string, string>();
    for (const p of products) if (p.ean && !byEan.has(p.ean)) byEan.set(p.ean, p.id);
    this.list = list;
    this.byId = byId;
    this.byEanMap = byEan;
    this.skipped = skipped;
    this.updatedAt = updatedAt;
  }

  /** The product's page on Alkometriikka (next to the data file), tagged so its analytics can tell the visit came from the bot. Undefined if search is off. */
  pageUrl(productId: string): string | undefined {
    if (!this.opts.url || !/^\d{1,10}$/.test(productId)) return undefined;
    try {
      const url = new URL(`tuotteet/${productId}/`, this.opts.url);
      url.search = new URLSearchParams({ utm_source: "blakkiskili", utm_medium: "telegram", utm_campaign: "product_link" }).toString();
      return url.href;
    } catch {
      return undefined;
    }
  }

  /** The product's page on alko.fi. Plain link, no tracking parameters. Undefined for ids that aren't product numbers. */
  alkoUrl(productId: string): string | undefined {
    return /^\d{1,10}$/.test(productId) ? `https://www.alko.fi/tuotteet/${productId}/` : undefined;
  }

  /** The product number with this EAN in the catalogue, if Alkometriikka has recorded one. */
  productIdByEan(ean: string): string | undefined {
    return this.byEanMap.get(ean);
  }

  /** A catalogue product that can't be logged as a drink (alcohol-free), for explaining why. */
  notDrinkable(id: string): CatalogProduct | undefined {
    return this.skipped.get(id);
  }

  /** The drink a product number belongs to (any package size of it). */
  get(id: string): CatalogDrink | undefined {
    return this.byId.get(id)?.drink;
  }

  /**
   * Every query word must prefix-match a word of the drink's names or maker. Ranked by: name
   * starts with the query, exact word matches, the user's recent drinks, Alko's standard
   * selection, active status, shorter (more generic) names.
   */
  search(query: string, limit = 8, recentProductIds: readonly string[] = [], extra: readonly CatalogDrink[] = []): CatalogDrink[] {
    const q = normalize(query);
    if (!q) return [];
    const recent = new Map<Indexed, number>();
    recentProductIds.forEach((id, i) => {
      const x = this.byId.get(id);
      if (x && !recent.has(x)) recent.set(x, recentProductIds.length - i);
    });
    // Extra drinks (user-added products) are ranked with the catalogue; their barcode is searchable too.
    const extras = extra.map((drink): Indexed => {
      const words = normalize(`${drink.name} ${drink.product.maker ?? ""} ${drink.product.ean ?? ""}`).split(" ");
      return { drink, tokens: [...new Set(words.filter(Boolean))], name: normalize(drink.name), removed: false };
    });
    const best = new Map<Indexed, number>();
    for (const variant of this.variants(q)) {
      for (const { x, score } of this.score(variant, recent, extras)) best.set(x, Math.max(best.get(x) ?? -Infinity, score));
    }
    return [...best]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([x]) => x.drink);
  }

  /** Drinks for the given product numbers, de-duplicated, in order (recent picks). */
  drinksFor(productIds: readonly string[], limit: number): CatalogDrink[] {
    const out: CatalogDrink[] = [];
    for (const id of productIds) {
      const d = this.get(id);
      if (d && !out.includes(d)) out.push(d);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The query itself plus versions with nicknames replaced ("jallu" → "jaloviina"). */
  private variants(q: string): string[] {
    const words = q.split(" ");
    const out = [q];
    words.forEach((w, i) => {
      for (const alt of ALIASES[w] ?? []) out.push([...words.slice(0, i), alt, ...words.slice(i + 1)].join(" "));
    });
    return [...new Set(out)];
  }

  private score(q: string, recent: Map<Indexed, number>, extras: Indexed[]): { x: Indexed; score: number }[] {
    const words = q.split(" ").filter(Boolean);
    const scored: { x: Indexed; score: number }[] = [];
    for (const x of [...this.list, ...extras]) {
      let score = 0;
      let ok = true;
      for (const w of words) {
        let best = 0;
        for (const t of x.tokens) {
          if (t === w) best = Math.max(best, 10);
          else if (t.startsWith(w)) best = Math.max(best, 5);
        }
        if (best === 0) {
          ok = false;
          break;
        }
        score += best;
      }
      if (!ok) continue;
      const p = x.drink.product;
      if (x.name.startsWith(q)) score += 20;
      score += (recent.get(x) ?? 0) * 15;
      if (p.selection === "vakiovalikoima") score += 8;
      if (p.status === "Aktiivinen" || p.status === "Uutuus") score += 4;
      else if (p.status === "Poistuva") score -= 2;
      score -= x.name.length * 0.05; // shorter, more generic names first
      scored.push({ x, score });
    }
    return scored;
  }

  /** Loads the on-disk copy, if any. Returns whether a catalogue is now available. */
  loadCache(): boolean {
    const path = this.opts.cachePath;
    if (!path || !existsSync(path)) return false;
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as { etag?: string; lastModified?: string; data: unknown };
      this.load(cached.data);
      this.etag = cached.etag ?? null;
      this.lastModified = cached.lastModified ?? null;
      return true;
    } catch (err) {
      console.warn("Ignoring unreadable Alkometriikka cache:", err);
      return false;
    }
  }

  /** Downloads the catalogue if it changed. Keeps the current one on any error (and rethrows). */
  async refresh(): Promise<"updated" | "unchanged" | "disabled"> {
    if (!this.opts.url) return "disabled";
    const headers: Record<string, string> = { "User-Agent": "Blakkiskili-bot (Telegram; catalogue sync)" };
    if (this.ready && this.etag) headers["If-None-Match"] = this.etag;
    if (this.ready && this.lastModified) headers["If-Modified-Since"] = this.lastModified;
    const res = await (this.opts.fetch ?? fetch)(this.opts.url, { headers, signal: AbortSignal.timeout(60_000) });
    if (res.status === 304) return "unchanged";
    if (!res.ok) throw new Error(`Alkometriikka download failed: HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text) as unknown;
    this.load(data); // throws before anything is replaced if the format is unusable
    this.etag = res.headers.get("etag");
    this.lastModified = res.headers.get("last-modified");
    if (this.opts.cachePath) {
      const tmp = `${this.opts.cachePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ etag: this.etag, lastModified: this.lastModified, data }));
      renameSync(tmp, this.opts.cachePath);
    }
    return "updated";
  }
}
