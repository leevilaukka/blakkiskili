// Barcode (EAN) → Alko product number, from Alkometriikka's API Worker (api.alkometriikka.fi).
//
// Alko's own API has no barcodes. The Worker looks each new one up from Alko's mobile app API once
// and keeps the answer; Alkometriikka's sync then writes the known ones into data.json's EAN
// column, which `Products.productIdByEan` reads. This is only the fallback for barcodes that
// haven't made it there yet. The request is just the barcode number: nothing about the user.

import { normalizeEan } from "../lib/ean.ts";

export interface BarcodesOptions {
  /** Alkometriikka API Worker, e.g. https://api.alkometriikka.fi. Unset = no lookups beyond the catalogue. */
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type ResolveResult =
  | { ok: true; ean: string; productId: string | null }
  | { ok: false; reason: "invalid" | "rate-limited" | "unavailable"; ean?: string };

const TIMEOUT_MS = 8000;
/** How long an answer is remembered. The Worker is rate limited per IP and all users share ours. */
const FOUND_TTL_MS = 24 * 3600_000;
const MISSING_TTL_MS = 10 * 60_000;

export class Barcodes {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly answers = new Map<string, { productId: string | null; until: number }>();

  constructor(private readonly opts: BarcodesOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Whether the Worker can be asked. */
  get enabled(): boolean {
    return !!this.opts.url;
  }

  /** The product number of a barcode; `productId` is null when Alko doesn't know it. */
  async resolve(input: string): Promise<ResolveResult> {
    const ean = normalizeEan(input);
    if (!ean) return { ok: false, reason: "invalid" };
    if (!this.enabled) return { ok: true, ean, productId: null };

    const cached = this.answers.get(ean);
    if (cached && cached.until > this.now()) return { ok: true, ean, productId: cached.productId };

    try {
      const res = await this.fetchFn(`${this.opts.url!.replace(/\/+$/, "")}/gtin/${ean}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return this.remember(ean, null);
      if (res.status === 400) return { ok: false, reason: "invalid", ean };
      if (res.status === 429) return { ok: false, reason: "rate-limited", ean };
      if (!res.ok) return { ok: false, reason: "unavailable", ean };
      const body = (await res.json()) as { id?: unknown };
      const id = body.id == null ? "" : String(body.id);
      if (!/^\d{1,10}$/.test(id)) return { ok: false, reason: "unavailable", ean };
      return this.remember(ean, id);
    } catch {
      return { ok: false, reason: "unavailable", ean };
    }
  }

  private remember(ean: string, productId: string | null): ResolveResult {
    if (this.answers.size >= 5000) this.answers.clear();
    this.answers.set(ean, { productId, until: this.now() + (productId ? FOUND_TTL_MS : MISSING_TTL_MS) });
    return { ok: true, ean, productId };
  }
}
