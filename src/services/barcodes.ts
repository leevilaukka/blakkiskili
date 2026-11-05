// Barcode (EAN) → Alko product links, kept by Alkometriikka's backend and filled by people:
// anyone can link a barcode to a product, and a link counts once enough people agree.
//
// The confirmed links are mirrored here (and cached on disk like the catalogue), so a lookup is
// a map read. Votes go to the backend under an opaque voter id derived from the user's Telegram
// id with a key of its own: the backend can't tell who voted or connect it to the user's account.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { normalizeEan } from "../lib/ean.ts";

export interface BarcodesOptions {
  /** Alkometriikka backend, e.g. https://api.alkometriikka.fi. Unset = barcodes are off. */
  url?: string;
  /** Shared secret that lets this bot vote. Without it barcodes can be looked up but not linked. */
  apiKey?: string;
  cachePath?: string;
  fetch?: typeof fetch;
}

export type LinkResult =
  | { ok: true; status: "confirmed" | "pending"; productId: string | null }
  | { ok: false; reason: "invalid" | "unknown-product" | "rate-limited" | "unavailable" };

const TIMEOUT_MS = 8000;

export class Barcodes {
  private map = new Map<string, string>();
  private etag: string | null = null;
  private loaded = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: BarcodesOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  get enabled(): boolean {
    return !!this.opts.url;
  }

  /** Whether users can be offered to link barcodes. */
  get canLink(): boolean {
    return this.enabled && !!this.opts.apiKey;
  }

  get count(): number {
    return this.map.size;
  }

  private endpoint(path: string): string {
    return `${this.opts.url!.replace(/\/+$/, "")}${path}`;
  }

  private load(items: unknown): boolean {
    if (!items || typeof items !== "object") return false;
    const next = new Map<string, string>();
    for (const [ean, productId] of Object.entries(items)) {
      if (normalizeEan(ean) === ean && typeof productId === "string" && /^\d{1,10}$/.test(productId)) next.set(ean, productId);
    }
    this.map = next;
    this.loaded = true;
    return true;
  }

  loadCache(): boolean {
    const path = this.opts.cachePath;
    if (!path || !existsSync(path)) return false;
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown; etag?: string | null };
      if (!this.load(cached.items)) return false;
      this.etag = cached.etag ?? null;
      return true;
    } catch {
      return false;
    }
  }

  /** Downloads the confirmed links if they changed. Keeps the current ones on any error (and rethrows). */
  async refresh(): Promise<"updated" | "unchanged" | "disabled"> {
    if (!this.enabled) return "disabled";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.loaded && this.etag) headers["If-None-Match"] = this.etag;
    const res = await this.fetchFn(this.endpoint("/v1/eans"), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 304) return "unchanged";
    if (!res.ok) throw new Error(`Barcode download failed: HTTP ${res.status}`);
    const body = (await res.json()) as { items?: unknown };
    if (!this.load(body.items)) throw new Error("Barcode download: unexpected format");
    this.etag = res.headers.get("etag");
    if (this.opts.cachePath) {
      const tmp = `${this.opts.cachePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ items: Object.fromEntries(this.map), etag: this.etag }), { mode: 0o600 });
      renameSync(tmp, this.opts.cachePath);
    }
    return "updated";
  }

  /**
   * The product number of a barcode, from the mirror first and otherwise straight from the
   * backend (someone may have just confirmed it). Null when it isn't a valid barcode;
   * `productId` is null when it isn't linked (yet).
   */
  async resolve(input: string): Promise<{ ean: string; productId: string | null } | null> {
    const ean = normalizeEan(input);
    if (!ean) return null;
    const known = this.map.get(ean);
    if (known) return { ean, productId: known };
    if (!this.enabled) return { ean, productId: null };
    try {
      const res = await this.fetchFn(this.endpoint(`/v1/eans/${ean}`), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const info = (await res.json()) as { status?: string; productId?: string | null };
        if (info.status === "confirmed" && typeof info.productId === "string") {
          this.map.set(ean, info.productId);
          return { ean, productId: info.productId };
        }
      }
    } catch {
      // Offline: the mirror said no, so treat it as unlinked.
    }
    return { ean, productId: null };
  }

  /** Votes that `ean` belongs to `productId`. `voter` is already an opaque id, never a Telegram id. */
  async link(input: string, productId: string, voter: string): Promise<LinkResult> {
    const ean = normalizeEan(input);
    if (!ean) return { ok: false, reason: "invalid" };
    if (!this.canLink) return { ok: false, reason: "unavailable" };
    try {
      const res = await this.fetchFn(this.endpoint(`/v1/eans/${ean}`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "X-Voter": voter,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return { ok: false, reason: "unknown-product" };
      if (res.status === 429) return { ok: false, reason: "rate-limited" };
      if (!res.ok) return { ok: false, reason: "unavailable" };
      const info = (await res.json()) as { status?: string; productId?: string | null };
      if (info.status === "confirmed" && typeof info.productId === "string") {
        this.map.set(ean, info.productId);
        return { ok: true, status: "confirmed", productId: info.productId };
      }
      return { ok: true, status: "pending", productId: null };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
}
