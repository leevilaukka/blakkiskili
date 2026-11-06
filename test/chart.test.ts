import { describe, expect, test } from "bun:test";
import { assignColors, buildPermilleChart, type ChartSeries } from "../src/lib/chart.ts";
import { svgToPng } from "../src/lib/render.ts";
import { HOUR_MS } from "../src/lib/units.ts";

const now = Date.parse("2026-11-06T23:20:00+02:00");
const person = (id: string, name: string, drinkHoursAgo: number[]): ChartSeries => ({
  id,
  name,
  body: { weight: 75, height: 180, gender: "mies" },
  drinks: drinkHoursAgo.map((h) => ({ createdAt: now - h * HOUR_MS, alcoholMg: 12241 })),
});

describe("permille chart", () => {
  test("nothing to draw → null", () => {
    expect(buildPermilleChart({ title: "t", series: [], now })).toBeNull();
    expect(buildPermilleChart({ title: "t", series: [person("a", "a", [40])], now })).toBeNull(); // long burned
  });

  test("single person: line, now dot and value label, no legend", () => {
    const r = buildPermilleChart({ title: "Promillekuvaaja feat. leevi", series: [person("a", "leevi", [3, 2, 1])], now })!;
    expect(r.shown).toBe(1);
    expect(r.svg).toContain('stroke-dasharray="2 6"'); // forecast
    expect(r.svg).toContain(">nyt<");
    expect(r.svg).toMatch(/>\d\.\d\d‰</); // direct value label
    expect(r.svg).not.toContain("<tspan"); // no legend entries
  });

  test("names are XML-escaped, and there is a legend with current values", () => {
    const r = buildPermilleChart({ title: "<Kilta & co>", series: [person("a", 'Mörkö & <"Co">', [2]), person("b", "b", [1])], now })!;
    expect(r.svg).toContain("&lt;Kilta &amp; co&gt;");
    expect(r.svg).toContain("Mörkö &amp; &lt;&quot;Co&quot;&gt;");
    expect(r.svg).not.toContain("<Kilta");
    expect(r.svg.match(/<tspan/g)).toHaveLength(2);
  });

  test("overview of everyone first, then groups of 10 ranked by peak", () => {
    const series = Array.from({ length: 13 }, (_, i) => person(`u${i}`, `p${i}`, [2, 1.5, 1 - i * 0.05]));
    const names = (r: { svg: string }) => [...r.svg.matchAll(/>(p\d+) <tspan/g)].map((m) => m[1]);
    const all = buildPermilleChart({ title: "t", series, now })!;
    expect(all).toMatchObject({ shown: 13, page: 0, pages: 3, label: "Kaikki" });
    expect(all.svg).not.toContain("kaikki"); // the overview is just the plain title
    expect(new Set(names(all)).size).toBe(13);
    const first = buildPermilleChart({ title: "t", series, now, page: 1 })!;
    const second = buildPermilleChart({ title: "t", series, now, page: 2 })!;
    expect(first).toMatchObject({ shown: 10, page: 1, label: "1/2" });
    expect(second).toMatchObject({ shown: 3, page: 2, label: "2/2" });
    expect(first.svg).toContain("t (1/2)");
    expect(second.svg).toContain("<tspan"); // a short last page still gets a legend
    expect(buildPermilleChart({ title: "t", series, now, page: 99 })!.page).toBe(2); // clamped
    expect(new Set([...names(first), ...names(second)]).size).toBe(13); // nobody twice, nobody lost
  });

  test("up to 10 people: one chart, no pages", () => {
    const series = Array.from({ length: 10 }, (_, i) => person(`u${i}`, `p${i}`, [2, 1 - i * 0.05]));
    expect(buildPermilleChart({ title: "t", series, now })).toMatchObject({ shown: 10, pages: 1, label: "" });
  });

  test("the ‰ axis fits each page, so a runaway leader does not flatten the rest", () => {
    const series = [person("big", "big", [5, 4, 3, 2.5, 2, 1.5, 1, 0.5]), ...Array.from({ length: 10 }, (_, i) => person(`s${i}`, `s${i}`, [1.5, 1 - i * 0.05]))];
    const top = (svg: string) => Math.max(...[...svg.matchAll(/text-anchor="end">([\d.]+)</g)].map((m) => Number(m[1])));
    const first = buildPermilleChart({ title: "t", series, now, page: 1 })!;
    const second = buildPermilleChart({ title: "t", series, now, page: 2 })!;
    expect(first.pages).toBe(3);
    expect(top(second.svg)).toBeLessThan(top(first.svg));
  });

  test("colour follows the person, not the set or rank", () => {
    const a = assignColors(["alice", "bob", "carol"]);
    const b = assignColors(["carol", "dave", "alice"]);
    expect(new Set(a.values()).size).toBe(3); // distinct
    expect(b.get("alice")).toBe(a.get("alice")!); // no collision with dave here → same colour
    const eight = assignColors(Array.from({ length: 10 }, (_, i) => `id${i}`));
    expect(new Set(eight.values()).size).toBe(10);
  });

  test("renders to a PNG", () => {
    const r = buildPermilleChart({ title: "Bläkkiskili ‰", series: [person("a", "ä", [2, 1])], now })!;
    const png = svgToPng(r.svg, 1);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(5000);
  });
});
