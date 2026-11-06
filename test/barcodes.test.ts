import { describe, expect, test } from "bun:test";
import { defaultBarcodeIO } from "../src/bot/barcode.ts";
import { normalizeEan } from "../src/lib/ean.ts";
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

describe("Barcodes", () => {
  const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("maps the Worker's answers, and remembers them for a while", async () => {
    let calls = 0;
    let clock = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      calls++;
      expect(String(input)).toBe("https://api.test/gtin/4006381333931");
      return new Response(JSON.stringify({ id: 700004 }));
    }) as unknown as typeof fetch;
    const service = new Barcodes({ url: "https://api.test/", fetch: fetchFn, now: () => clock });
    expect(await service.resolve("4006381333931")).toEqual({ ok: true, ean: "4006381333931", productId: "700004" });
    expect(await service.resolve("4006381333931")).toEqual({ ok: true, ean: "4006381333931", productId: "700004" });
    expect(calls).toBe(1);
    clock += 25 * 3600_000;
    await service.resolve("4006381333931");
    expect(calls).toBe(2);
  });

  test("404 means unlinked (retried after a short while), other failures are not remembered", async () => {
    let clock = 0;
    let calls = 0;
    const status = { current: 404 };
    const fetchFn = (async () => {
      calls++;
      return new Response("{}", { status: status.current });
    }) as unknown as typeof fetch;
    const service = new Barcodes({ url: "https://api.test", fetch: fetchFn, now: () => clock });
    expect(await service.resolve("4006381333931")).toEqual({ ok: true, ean: "4006381333931", productId: null });
    await service.resolve("4006381333931");
    expect(calls).toBe(1);
    clock += 11 * 60_000;
    status.current = 429;
    expect(await service.resolve("4006381333931")).toMatchObject({ ok: false, reason: "rate-limited" });
    status.current = 502;
    expect(await service.resolve("4006381333931")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(calls).toBe(3);
  });

  test("rejects bad numbers locally, treats junk answers as unavailable, and needs a URL to ask", async () => {
    const service = new Barcodes({ url: "https://api.test", fetch: respond(200, { id: "not-a-number" }) });
    expect(await service.resolve("12345")).toEqual({ ok: false, reason: "invalid" });
    expect(await service.resolve("4006381333931")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await new Barcodes({ url: "https://api.test", fetch: respond(400) }).resolve("4006381333931")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await new Barcodes().resolve("4006381333931")).toEqual({ ok: true, ean: "4006381333931", productId: null });
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
