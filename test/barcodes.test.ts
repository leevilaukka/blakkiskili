import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBarcodeIO } from "../src/bot/barcode.ts";
import { normalizeEan } from "../src/lib/ean.ts";
import { createCrypto } from "../src/lib/ids.ts";
import { Barcodes } from "../src/services/barcodes.ts";

describe("normalizeEan", () => {
  test("accepts EAN-13, EAN-8 and UPC-A, rejects bad checksums and lengths", () => {
    expect(normalizeEan("4006381333931")).toBe("4006381333931");
    expect(normalizeEan("96385074")).toBe("96385074");
    expect(normalizeEan("036000291452")).toBe("0036000291452");
    expect(normalizeEan(" 4006381333931 ")).toBe("4006381333931");
    expect(normalizeEan("4006381333932")).toBeNull();
    expect(normalizeEan("12345")).toBeNull();
    expect(normalizeEan("karhu")).toBeNull();
  });
});

describe("voterKey", () => {
  test("is one stable, opaque id per account, unrelated to the account id and to other keys", () => {
    const crypto = createCrypto("test-secret-test-secret-test-secret-123");
    const account = "7f3a9c0d51e24b6f8a1d";
    const voter = crypto.voterKey(account);
    expect(voter).toBe(crypto.voterKey(account));
    expect(voter).toMatch(/^[0-9a-f]{48}$/);
    expect(voter).not.toContain(account);
    expect(voter).not.toBe(crypto.voterKey("another-account"));
    expect(voter).not.toBe(crypto.identityKey("telegram", account).slice(0, 48));
    // a different APP_SECRET gives different voters, so ids can't be matched across deployments
    expect(createCrypto("another-secret-another-secret-12345").voterKey(account)).not.toBe(voter);
  });
});

describe("Barcodes", () => {
  test("mirrors confirmed links, uses the ETag and keeps a disk cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kili-barcodes-"));
    try {
      const cachePath = join(dir, "barcodes.json");
      const seen: (string | null)[] = [];
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        const inm = new Headers(init?.headers).get("if-none-match");
        seen.push(inm);
        if (inm === '"v1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify({ items: { "4006381333931": "700004", bad: "1", "96385074": "not-a-number" } }), {
          headers: { etag: '"v1"' },
        });
      }) as unknown as typeof fetch;

      const a = new Barcodes({ url: "https://api.test/", cachePath, fetch: fetchFn });
      expect(await a.refresh()).toBe("updated");
      expect(await a.refresh()).toBe("unchanged");
      expect(seen).toEqual([null, '"v1"']);
      expect(a.count).toBe(1); // invalid entries are dropped
      expect(await a.resolve("4006381333931")).toEqual({ ean: "4006381333931", productId: "700004" });

      const b = new Barcodes({ url: "https://api.test", cachePath });
      expect(b.loadCache()).toBe(true);
      expect(b.count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the backend for a barcode confirmed since the last refresh, and survives it being down", async () => {
    let up = true;
    const fetchFn = (async () => {
      if (!up) throw new Error("offline");
      return new Response(JSON.stringify({ status: "confirmed", productId: "700004" }));
    }) as unknown as typeof fetch;
    const service = new Barcodes({ url: "https://api.test", fetch: fetchFn });
    expect((await service.resolve("4006381333931"))?.productId).toBe("700004");
    up = false;
    expect((await service.resolve("96385074"))?.productId).toBeNull();
    expect(await service.resolve("nope")).toBeNull();
  });

  test("never votes without a key, and maps failures", async () => {
    const respond = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await new Barcodes({ url: "https://api.test" }).link("4006381333931", "700004", "v")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const link = (status: number) =>
      new Barcodes({ url: "https://api.test", apiKey: "k", fetch: respond(status) }).link("4006381333931", "700004", "voter");
    expect(await link(429)).toEqual({ ok: false, reason: "rate-limited" });
    expect(await link(404)).toEqual({ ok: false, reason: "unknown-product" });
    expect(await link(500)).toEqual({ ok: false, reason: "unavailable" });
    expect(await new Barcodes({ url: "https://api.test", apiKey: "k" }).link("123", "700004", "v")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("barcode photo decoding", () => {
  test("reads an EAN-13 from a real image", async () => {
    const { writeBarcode } = await import("zxing-wasm/writer");
    const written = await writeBarcode("4006381333931", { format: "EAN-13", scale: 3 });
    const image = new Uint8Array(await written.image!.arrayBuffer());
    expect(await defaultBarcodeIO().decode(image)).toBe("4006381333931");
    expect(await defaultBarcodeIO().decode(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
