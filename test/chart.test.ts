import { describe, expect, test } from "bun:test";
import { assignColors, buildChartData, buildPermilleChart, type ChartSeries } from "../src/lib/chart.ts";
import { FIXED_COLORS, seriesColor } from "../shared/colors.ts";
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

  test("a group's chart (named) has a legend with the name even when only one person is on it", () => {
    const r = buildPermilleChart({ title: "t", series: [person("a", "leevi", [3, 2, 1])], now, named: true })!;
    expect(r.svg).toContain(">leevi <tspan");
    const sober = buildPermilleChart({ title: "t", series: [person("a", "leevi", [15])], now, named: true })!;
    expect(sober.svg).toContain(">leevi <tspan"); // back at zero: no direct label, but still in the legend
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

  test("direct labels only for the people still above zero, when at most four are", () => {
    const direct = (r: { svg: string }) => [...r.svg.matchAll(/paint-order="stroke">([^<]+)</g)].map((m) => m[1]!.split(" ")[0]);
    const drinking = Array.from({ length: 4 }, (_, i) => person(`u${i}`, `p${i}`, [2, 1]));
    const sober = person("z", "zero", [15]); // on the chart, back at zero now
    const r = buildPermilleChart({ title: "t", series: [...drinking, sober], now })!;
    expect(r.shown).toBe(5);
    expect(r.svg).toContain(">zero <tspan"); // still in the legend
    expect(direct(r).sort()).toEqual(["p0", "p1", "p2", "p3"]);
    // a fifth person above zero: too many for direct labels
    expect(direct(buildPermilleChart({ title: "t", series: [...drinking, person("u4", "p4", [1]), sober], now })!)).toEqual([]);
    // alone and at zero: no legend, so the value label stays
    expect(buildPermilleChart({ title: "t", series: [sober], now })!.svg).toMatch(/paint-order="stroke">0[.,]00‰</);
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

  test("a big group gets a colour each, never a repeat", () => {
    for (const n of [11, 40, 150]) {
      const slots = assignColors(Array.from({ length: n }, (_, i) => `id${i}`));
      expect(new Set(slots.values()).size).toBe(n);
      expect(Math.max(...slots.values())).toBe(n - 1); // uses exactly slots 0..n-1
      for (const mode of ["light", "dark"] as const) {
        expect(new Set([...slots.values()].map((s) => seriesColor(s, mode))).size).toBe(n);
      }
    }
  });

  test("generated colours stay readable on their surface", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (let slot = FIXED_COLORS; slot < 100; slot++) {
      expect(seriesColor(slot, "light")).toMatch(/^#[0-9a-f]{6}$/);
      expect(ratio(seriesColor(slot, "light"), "#fcfcfb")).toBeGreaterThanOrEqual(3);
      expect(ratio(seriesColor(slot, "dark"), "#1a1a19")).toBeGreaterThanOrEqual(3);
    }
  });

  test("/kuvaaja and the website give a person the same colour, on every page", () => {
    // 12 people: the bot splits them over two pages plus an overview; the website draws all at once.
    const series = Array.from({ length: 12 }, (_, i) => ({ ...person(`acct${i}`, `p${i}`, [2, 1 + i * 0.1]), colorKey: `acct${i}` }));
    const web = buildChartData(series.map((s) => ({ ...s, id: `ref${s.id}` })), now);
    const colorOf = new Map(web.lines.map((l) => [l.name, seriesColor(l.slot, "light")]));
    let checked = 0;
    for (const page of [0, 1, 2]) {
      const svg = buildPermilleChart({ title: "t", series, now, page })!.svg;
      // Each legend entry: the swatch's dot in the person's colour, then their name.
      for (const m of svg.matchAll(/<circle [^>]*fill="(#[0-9a-f]{6})"\/>\s*<text [^>]*>(p\d+) /g)) {
        expect(m[1]).toBe(colorOf.get(m[2]!)!);
        checked++;
      }
    }
    expect(checked).toBe(24); // everyone on the overview, and everyone once more on pages 1-2
  });

  test("website chart: a big group's sober members don't push the drinkers onto colours the site lacks", () => {
    const drinkers = ["a", "b", "c"].map((id) => person(id, id, [2, 1]));
    const sober = Array.from({ length: 12 }, (_, i) => person(`z${i}`, `z${i}`, []));
    const data = buildChartData([...drinkers, ...sober], now);
    expect(data.lines.map((l) => l.id).sort()).toEqual(["a", "b", "c"]);
    expect(new Set(data.lines.map((l) => l.slot)).size).toBe(3);
    for (const l of data.lines) expect(l.slot).toBeLessThan(FIXED_COLORS); // the validated palette
  });

  test("renders to a PNG", () => {
    const r = buildPermilleChart({ title: "Bläkkiskili ‰", series: [person("a", "ä", [2, 1])], now })!;
    const png = svgToPng(r.svg, 1);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(5000);
  });
});
