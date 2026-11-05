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
    expect(r.svg).toContain('stroke-dasharray="6 5"'); // forecast
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

  test("at most 8 people, the rest summarised", () => {
    const series = Array.from({ length: 11 }, (_, i) => person(`u${i}`, `p${i}`, [2, 1.5, 1 - i * 0.05]));
    const r = buildPermilleChart({ title: "t", series, now })!;
    expect(r).toMatchObject({ shown: 8, hidden: 3 });
    expect(r.svg).toContain("+3 muuta");
  });

  test("colour follows the person, not the set or rank", () => {
    const a = assignColors(["alice", "bob", "carol"]);
    const b = assignColors(["carol", "dave", "alice"]);
    expect(new Set(a.values()).size).toBe(3); // distinct
    expect(b.get("alice")).toBe(a.get("alice")!); // no collision with dave here → same colour
    const eight = assignColors(Array.from({ length: 8 }, (_, i) => `id${i}`));
    expect(new Set(eight.values()).size).toBe(8);
  });

  test("renders to a PNG", () => {
    const r = buildPermilleChart({ title: "Bläkkiskili ‰", series: [person("a", "ä", [2, 1])], now })!;
    const png = svgToPng(r.svg, 1);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(5000);
  });
});
