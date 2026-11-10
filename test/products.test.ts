import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, parseCatalog, Products } from "../src/services/products.ts";
import {
  cleanName,
  customServing,
  packCount,
  parseAmount,
  pricePerStandardDrink,
  resolveServing,
  servingDescription,
  servingFacts,
  splitAmount,
  type CatalogDrink,
} from "../src/lib/servings.ts";
import { catalogJson, PRODUCTS } from "./fixtures.ts";

const loaded = () => {
  const p = new Products();
  p.load(catalogJson());
  return p;
};
const catalogue = loaded();
const drink = (id: string) => catalogue.get(id)!;
const servingSummary = (d: CatalogDrink) => d.servings.map((s) => `${s.key}:${s.label}`);

describe("catalogue parsing", () => {
  test("columns are found by name; unusable files are rejected", () => {
    const { products, updatedAt } = parseCatalog(catalogJson());
    expect(products).toHaveLength(PRODUCTS.length);
    expect(products[0]).toMatchObject({ id: "700001", name: "Karhu 4,6 tölkki", sizeL: 0.33, abv: 4.6, type: "Panimotuotteet" });
    expect(updatedAt).toBe(Date.parse("2026-11-04T23:15:38.631Z"));
    expect(() => parseCatalog({ schema: ["Nimi"], products: {} })).toThrow(/missing columns/);
    expect(() => parseCatalog({ hello: 1 })).toThrow();
  });

  test("non-alcoholic products aren't searchable", () => {
    expect(loaded().get("700040")).toBeUndefined();
  });

  test("all package sizes of a drink are one entry; any product number finds it", () => {
    const jallu = drink("700023"); // the 4 cl mini's number
    expect(jallu.variants.map((v) => v.id).sort()).toEqual(["700020", "700022", "700023", "700024"]);
    expect(jallu.id).toBe("700022"); // representative: a bottle you pour from, the bigger one
    expect(drink("700020")).toBe(jallu);
    expect(drink("700001")).toBe(drink("700008")); // Karhu 4,6 33 cl can and 50 cl can
    expect(drink("700010")).not.toBe(drink("700013")); // different wines stay apart
    expect(drink("700025")).not.toBe(jallu); // Jaloviina * is not Jaloviina ***
  });
});

describe("removed products and legacy types", () => {
  test("removed products (null Tila) resolve by number and EAN but never show up in search", () => {
    expect(catalogue.get("700051")!.name).toBe("Karhu Vanha Poistunut");
    expect(catalogue.productIdByEan("6410000000018")).toBe("700051");
    expect(catalogue.search("poistunut")).toEqual([]);
    expect(catalogue.search("karhu vanha").map((d) => d.id)).toEqual(["700050"]);
    expect(catalogue.drinksFor(["700051"], 5).map((d) => d.id)).toEqual(["700051"]);
  });

  test("an unknown Tyyppi counts as Muut instead of failing", () => {
    expect(catalogue.get("700052")!.product.type).toBe("Muut");
  });

  test("a product with a missing or invalid required value is skipped", () => {
    const rows = PRODUCTS.map((r) => [...r] as typeof r);
    const row = (id: string) => rows.find((r) => r[1] === id)!;
    row("700004")[7] = null as never; // ABV
    row("700030")[3] = "0.75 l" as never; // size as a string
    const p = new Products();
    p.load(catalogJson(rows));
    expect(p.get("700004")).toBeUndefined();
    expect(p.get("700030")).toBeUndefined();
    expect(p.get("700026")).toBeDefined();
  });
});

describe("EAN column", () => {
  test("is read by name, normalised, and found by productIdByEan", () => {
    expect(catalogue.productIdByEan("4006381333931")).toBe("700004");
    expect(catalogue.productIdByEan("4006381333948")).toBeUndefined();
    const rows = PRODUCTS.map((r) => [...r] as typeof r);
    rows[0]![12] = "not a barcode";
    const p = new Products();
    p.load(catalogJson(rows));
    expect(p.get("700001")!.product.ean).toBeNull();
    // a catalogue without the column (older file) still loads
    const old = catalogJson();
    old.schema = old.schema.filter((c) => c !== "EAN");
    expect(() => new Products().load(old)).not.toThrow();
  });
});

describe("servings", () => {
  test("beer: one container per size; multipacks per can; kegs by the glass", () => {
    expect(servingSummary(drink("700001"))).toEqual(["c33:33 cl", "c50:50 cl"]);
    expect(drink("700001").servings.map((s) => s.productId)).toEqual(["700002", "700008"]); // each size's own number
    expect(packCount("Karhu 5,3 6-pack tölkki")).toBe(6);
    expect(servingSummary(drink("700003"))).toEqual(["c33:33 cl"]);
    expect(servingSummary(drink("700007"))).toEqual(["33:33 cl", "50:50 cl"]);
  });

  test("wine: glasses plus every bottle size; small bottles single; boxes no bottle; over-limit bottle dropped", () => {
    expect(servingSummary(drink("700010"))).toEqual(["12:12 cl", "16:16 cl", "b37.5:37.5 cl", "b75:75 cl"]);
    expect(drink("700010").servings.find((s) => s.key === "b37.5")!.productId).toBe("700014");
    expect(servingSummary(drink("700011"))).toEqual(["c20:20 cl"]);
    expect(servingSummary(drink("700012"))).toEqual(["12:12 cl", "16:16 cl"]);
    expect(servingSummary(drink("700013"))).toEqual(["12:12 cl", "16:16 cl"]); // 75 cl 16 % > limit
  });

  test("spirits: one set of shots whatever the bottle size; a mini alone is single", () => {
    expect(servingSummary(drink("700020"))).toEqual(["2:2 cl", "4:4 cl", "6:6 cl"]); // the mini's 4 cl merges into the pour
    expect(drink("700020").servings.every((s) => s.productId === "700022")).toBe(true);
    expect(servingSummary(drink("700026"))).toEqual(["2:2 cl", "4:4 cl", "6:6 cl"]); // the 5 cl mini adds no choice
    expect(drink("700027")).toBe(drink("700026"));
    expect(servingSummary(drink("700021"))).toEqual(["c4:4 cl"]); // a mini on its own stays
    expect(servingSummary(drink("700030"))).toEqual(["4:4 cl", "8:8 cl"]);
  });

  test("alcohol and standard drinks per serving", () => {
    const can = drink("700001").servings[0]!;
    expect(can.mg).toBe(Math.round(0.046 * 789.24 * 0.33 * 1000));
    expect(can.standardDrinks).toBeCloseTo(0.998, 2);
    expect(servingDescription(drink("700001"), can)).toBe("🍺 Karhu 4,6 (33 cl)");
    const glass = drink("700010").servings[1]!;
    expect(servingDescription(drink("700010"), glass)).toBe("🍷 Château Testi 2022 (16 cl)");
  });
});

describe("names and custom amounts", () => {
  test("package words are dropped from names", () => {
    expect(cleanName("Karhu 5,3 6-pack tölkki")).toBe("Karhu 5,3");
    expect(cleanName("Jaloviina *** muovipullo")).toBe("Jaloviina ***");
    expect(cleanName("Pubi Lager hanapakkaus")).toBe("Pubi Lager");
    expect(cleanName("tölkki")).toBe("tölkki"); // never empty
    expect(drink("700004").name).toBe("Karjala");
    expect(drink("700024").name).toBe("Jaloviina ***");
  });

  test("amounts: cl by default, other units, decimal commas", () => {
    expect(parseAmount("3 cl")).toBe(0.03);
    expect(parseAmount("25")).toBe(0.25);
    expect(parseAmount("0,5 l")).toBe(0.5);
    expect(parseAmount("2dl")).toBeCloseTo(0.2, 10);
    expect(parseAmount("250 ml")).toBe(0.25);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("25", null)).toBeNull(); // unit required
  });

  test("an amount at the end of a search needs a unit", () => {
    expect(splitAmount("jallu 3 cl")).toEqual({ query: "jallu", litres: 0.03 });
    expect(splitAmount("karhu 4,6 33cl")).toEqual({ query: "karhu 4,6", litres: 0.33 });
    expect(splitAmount("karhu 4,6")).toEqual({ query: "karhu 4,6" }); // part of the name
  });

  test("servings carry energy and the price of that amount; product pages link to Alkometriikka", () => {
    const can = drink("700001").servings.find((s) => s.key === "c33")!;
    expect(can).toMatchObject({ kcal: 132, productId: "700002" });
    expect(can.priceEur).toBeCloseTo(2.29);
    const shot = resolveServing(drink("700022"), "4")!; // 4 cl from the 70 cl bottle at 33,90 €
    expect(shot.kcal).toBe(84);
    expect(servingFacts(shot)).toBe("84 kcal · Alkossa 1,94 €");
    const noEnergy = drink("700013").servings[0]!;
    expect(noEnergy.kcal).toBeNull();
    expect(servingFacts(noEnergy)).toStartWith("Alkossa ");
    // 12 g of alcohol from Jaloviina at 33,90 € / 70 cl
    expect(pricePerStandardDrink(drink("700022").product)).toBeCloseTo((33.9 / 0.7) * (12 / (0.38 * 789.24)), 4);

    expect(catalogue.pageUrl("700022")).toBeUndefined(); // search disabled: no URL
    const online = new Products({ url: "https://alkometriikka.fi/data.json" });
    expect(online.pageUrl("700022")).toBe(
      "https://alkometriikka.fi/tuotteet/700022/?utm_source=blakkiskili&utm_medium=telegram&utm_campaign=product_link",
    );
    expect(online.pageUrl("../x")).toBeUndefined();
    expect(online.alkoUrl("700022")).toBe("https://www.alko.fi/tuotteet/700022/");
    expect(online.alkoUrl("../x")).toBeUndefined();
  });

  test("custom servings: any sane amount within the single-drink limit", () => {
    const jallu = drink("700022");
    const r = customServing(jallu, 0.03);
    expect(r).toMatchObject({ serving: { key: "x3", label: "3 cl", productId: "700022", mg: Math.round(0.38 * 789.24 * 0.03 * 1000) } });
    expect(customServing(jallu, 0.5)).toEqual({ error: "too_much" }); // half a litre of 38 %
    expect(customServing(jallu, 0)).toEqual({ error: "invalid" });
    expect(resolveServing(jallu, "x3")?.label).toBe("3 cl");
    expect(resolveServing(jallu, "4")?.label).toBe("4 cl");
    expect(resolveServing(jallu, "x500")).toBeUndefined(); // over the limit
    expect(resolveServing(jallu, "nope")).toBeUndefined();
  });
});

describe("search", () => {
  const names = (q: string, recent: string[] = []) => loaded().search(q, 8, recent).map((d) => d.product.name);

  test("normalisation: case, diacritics, decimal commas", () => {
    expect(normalize("Château KARHU 4,6%")).toBe("chateau karhu 4.6");
  });

  test("prefix match on every word, one result per drink regardless of packaging or size", () => {
    const karhu = names("karhu");
    expect(karhu).toContain("Karhu 5,3 6-pack tölkki");
    expect(karhu.filter((n) => n.startsWith("Karhu 4,6"))).toHaveLength(1); // 3 packages, one entry
    expect(names("jaloviina").sort()).toEqual(["Jaloviina *", "Jaloviina ***"]); // 4 packages of *** → one entry
    expect(names("muovipullo")).toEqual(["Jaloviina ***"]); // any variant's name matches
    expect(names("kar")).toContain("Karjala tölkki");
    expect(names("karhu 5.3")).toEqual(["Karhu 5,3 6-pack tölkki"]);
    expect(names("karhu 4,6")[0]).toStartWith("Karhu 4,6");
    expect(names("chateau")).toEqual(["Château Testi 2022"]);
    expect(names("sinebrychoff").length).toBeGreaterThan(0); // maker matches too
    expect(names("xyzzy")).toEqual([]);
    expect(names("")).toEqual([]);
  });

  test("nicknames", () => {
    expect(names("jallu").sort()).toEqual(["Jaloviina *", "Jaloviina ***"]);
    expect(names("lonkero")).toEqual(expect.arrayContaining(["Original Long Drink tölkki", "Olvi Lonkero Greippi tölkki"]));
  });

  test("standard selection and active products first; recent picks boosted", () => {
    expect(names("karhu").indexOf("Karhu Vanha Poistuva")).toBeGreaterThan(names("karhu").indexOf("Karhu 5,3 6-pack tölkki"));
    expect(names("kar", ["700004"])[0]).toBe("Karjala tölkki");
    expect(names("j", ["700023"])[0]).toBe("Jaloviina ***"); // a recent mini boosts the whole drink
  });
});

describe("catalogue refresh", () => {
  test("downloads, caches, uses conditional requests, and keeps the old data on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kili-products-"));
    try {
      const cachePath = join(dir, "cache.json");
      const requests: Record<string, string>[] = [];
      let respond: () => Response = () =>
        new Response(JSON.stringify(catalogJson()), { headers: { etag: 'W/"v1"', "last-modified": "Wed, 04 Nov 2026 23:18:02 GMT" } });
      const fakeFetch = (async (_url: string, init?: RequestInit) => {
        requests.push({ ...(init?.headers as Record<string, string>) });
        return respond();
      }) as unknown as typeof fetch;

      const p = new Products({ url: "https://example.test/data.json", cachePath, fetch: fakeFetch });
      expect(await p.refresh()).toBe("updated");
      const drinks = p.count;
      expect(drinks).toBeGreaterThan(10);
      expect(requests[0]!["If-None-Match"]).toBeUndefined();

      respond = () => new Response(null, { status: 304 });
      expect(await p.refresh()).toBe("unchanged");
      expect(requests[1]!["If-None-Match"]).toBe('W/"v1"');

      respond = () => new Response("oops", { status: 500 });
      await expect(p.refresh()).rejects.toThrow(/HTTP 500/);
      respond = () => new Response(JSON.stringify({ schema: ["Nimi"], products: {} }));
      await expect(p.refresh()).rejects.toThrow(/missing columns/);
      expect(p.count).toBe(drinks); // still the good data

      const restarted = new Products({ url: "https://example.test/data.json", cachePath, fetch: fakeFetch });
      expect(restarted.loadCache()).toBe(true);
      expect(restarted.get("700001")?.product.name).toBe("Karhu 4,6");
      respond = () => new Response(null, { status: 304 });
      await restarted.refresh();
      expect(requests.at(-1)!["If-None-Match"]).toBe('W/"v1"'); // etag survived the restart

      expect(await new Products().refresh()).toBe("disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
