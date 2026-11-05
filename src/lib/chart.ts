// /kuvaaja: estimated permilles over time as an SVG line chart (rendered to PNG elsewhere).
//
// Design: past solid, 12 h forecast dashed on a light wash, a "nyt" marker, hairline grid,
// one y-axis in ‰. Up to 8 people, colours in fixed slot order by stable user order (not by
// rank). Two or more series always get a legend with each person's current value (the
// palette has three sub-3:1 hues, so identity and values are never colour-only); four or
// fewer also get direct labels at the "now" dot. Palette validated with the dataviz
// validator (light surface, adjacent pairs).

import { calculateEbac, type BodyProfile, type DrinkSample } from "./alcomath.ts";
import { hhmm, longDate, num } from "./format.ts";

const pm = (v: number) => `${v.toFixed(2)}‰`;
import { HOUR_MS } from "./units.ts";

export interface ChartSeries {
  id: string; // stable per person: decides the colour slot
  name: string;
  body: BodyProfile;
  drinks: readonly DrinkSample[]; // ascending
}

export interface ChartInput {
  title: string;
  series: readonly ChartSeries[];
  now: number;
}

export interface ChartResult {
  svg: string;
  width: number;
  height: number;
  shown: number;
  hidden: number; // series left out because of the 8-series cap
}

const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781" };
const SURFACE = "#fcfcfb";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const WASH = "#f0efec";
const FONT = "DejaVu Sans, Noto Sans, Liberation Sans, Arial, sans-serif";

const MAX_SERIES = 8;
const DIRECT_LABEL_MAX = 4;
const STEP_MS = 15 * 60_000;
const PAST_MS = 24 * HOUR_MS;
const FORECAST_MS = 12 * HOUR_MS;
const MIN_SPAN_MS = 6 * HOUR_MS;
const EPS = 0.005;

const W = 960;
const PAD = 32;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);
const floorHour = (t: number) => t - (t % HOUR_MS);
const ceilHour = (t: number) => (t % HOUR_MS === 0 ? t : floorHour(t) + HOUR_MS);
const f = (n: number) => n.toFixed(1);

interface Point {
  t: number;
  v: number;
}

function sample(s: ChartSeries, from: number, to: number, now: number): Point[] {
  const times: number[] = [];
  for (let t = from; t <= to; t += STEP_MS) times.push(t);
  if (!times.includes(now)) times.push(now);
  times.sort((a, b) => a - b);
  return times.map((t) => ({ t, v: calculateEbac(s.body, s.drinks.filter((d) => d.createdAt < t), t).permilles }));
}

/**
 * Drops the flat zero runs before the first and after the last non-zero value (keeping one
 * zero point at each end so the line starts/ends on the baseline), so lines don't pile up
 * along the axis.
 */
function trimZeroEnds(points: Point[]): Point[] {
  const first = points.findIndex((p) => p.v > EPS);
  if (first === -1) return [];
  let last = points.length - 1;
  while (points[last]!.v <= EPS) last -= 1;
  return points.slice(Math.max(0, first - 1), Math.min(points.length, last + 2));
}

/**
 * Colour follows the person, not their rank: each id has a preferred slot derived from a hash
 * of it, so someone keeps their colour from one chart to the next. Collisions take the next
 * free slot, resolved in id order so the result is deterministic.
 */
export function assignColors(ids: readonly string[]): Map<string, string> {
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const id of [...ids].sort()) {
    let slot = Number.parseInt(new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 8), 16) % PALETTE.length;
    while (taken.has(slot)) slot = (slot + 1) % PALETTE.length;
    taken.add(slot);
    out.set(id, PALETTE[slot]!);
  }
  return out;
}

function niceStep(max: number): number {
  for (const step of [0.1, 0.2, 0.25, 0.5, 1, 2]) if (max / step <= 6) return step;
  return 5;
}

export function buildPermilleChart(input: ChartInput): ChartResult | null {
  const { now } = input;
  const from = floorHour(now - PAST_MS);
  const to = ceilHour(now + FORECAST_MS);

  const sampled = input.series
    .map((s) => {
      const points = sample(s, from, to, now);
      return {
        s,
        points,
        peak: Math.max(...points.map((p) => p.v)),
        current: points.find((p) => p.t === now)!.v,
      };
    })
    .filter((x) => x.peak > EPS)
    .sort((a, b) => b.peak - a.peak);
  if (sampled.length === 0) return null;

  const shown = sampled.slice(0, MAX_SERIES);
  const hidden = sampled.length - shown.length;
  const color = assignColors(shown.map((x) => x.s.id));

  // Visible time range: trim empty hours at both ends, keep at least 6 h and 2 h of forecast.
  const nonZero = shown.flatMap((x) => x.points.filter((p) => p.v > EPS).map((p) => p.t));
  let viewStart = Math.max(from, floorHour(Math.min(...nonZero) - HOUR_MS));
  let viewEnd = Math.min(to, ceilHour(Math.max(Math.max(...nonZero) + 30 * 60_000, now + 2 * HOUR_MS)));
  if (viewEnd - viewStart < MIN_SPAN_MS) viewStart = Math.max(from, viewEnd - MIN_SPAN_MS);
  if (viewEnd - viewStart < MIN_SPAN_MS) viewEnd = Math.min(to, viewStart + MIN_SPAN_MS);

  // Layout
  const single = shown.length === 1;
  const direct = shown.length <= DIRECT_LABEL_MAX;
  const legendCols = 3;
  const legendRows = single ? 0 : Math.ceil((shown.length + (hidden > 0 ? 1 : 0)) / legendCols);
  const plotLeft = PAD + 44;
  const plotRight = W - PAD;
  const plotTop = 112;
  const plotBottom = plotTop + 300;
  const legendTop = plotBottom + 56;
  const H = single ? plotBottom + 52 : legendTop + legendRows * 26 + 12;

  const yMaxRaw = Math.max(0.5, ...shown.map((x) => x.peak)) * 1.08;
  const yStep = niceStep(yMaxRaw);
  const yMax = Math.ceil(yMaxRaw / yStep) * yStep;
  const x = (t: number) => plotLeft + ((t - viewStart) / (viewEnd - viewStart)) * (plotRight - plotLeft);
  const y = (v: number) => plotBottom - (v / yMax) * (plotBottom - plotTop);
  const nowX = x(now);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
    `<rect width="${W}" height="${H}" fill="${SURFACE}"/>`,
    `<text x="${PAD}" y="52" font-size="24" font-weight="bold" fill="${INK.primary}">${esc(truncate(input.title, 60))}</text>`,
    `<text x="${PAD}" y="80" font-size="15" fill="${INK.secondary}">Arvioitu veren alkoholipitoisuus · ${esc(longDate(now))} klo ${esc(hhmm(now))}</text>`,
  );

  // Forecast wash + "nyt" marker
  out.push(
    `<rect x="${f(nowX)}" y="${plotTop}" width="${f(plotRight - nowX)}" height="${plotBottom - plotTop}" fill="${WASH}" opacity="0.7"/>`,
    `<text x="${f(plotRight - 6)}" y="${plotTop + 16}" font-size="12" fill="${INK.muted}" text-anchor="end">ennuste</text>`,
  );

  // Y grid + labels
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    const yy = f(y(v));
    out.push(
      `<line x1="${plotLeft}" x2="${plotRight}" y1="${yy}" y2="${yy}" stroke="${v === 0 ? AXIS : GRID}" stroke-width="1"/>`,
      `<text x="${plotLeft - 8}" y="${f(y(v) + 4)}" font-size="13" fill="${INK.muted}" text-anchor="end">${num(v)}</text>`,
    );
  }
  out.push(`<text x="${plotLeft - 8}" y="${plotTop - 12}" font-size="13" fill="${INK.muted}" text-anchor="end">‰</text>`);

  // X labels (Helsinki hours)
  const spanH = (viewEnd - viewStart) / HOUR_MS;
  const xStepH = [1, 2, 3, 4, 6].find((s) => spanH / s <= 12) ?? 6;
  for (let t = ceilHour(viewStart); t <= viewEnd; t += HOUR_MS) {
    const hour = Number(hhmm(t).slice(0, 2));
    if (hour % xStepH !== 0) continue;
    out.push(`<text x="${f(x(t))}" y="${plotBottom + 22}" font-size="13" fill="${INK.muted}" text-anchor="middle">${hour}</text>`);
  }

  out.push(
    `<line x1="${f(nowX)}" x2="${f(nowX)}" y1="${plotTop}" y2="${plotBottom}" stroke="${INK.muted}" stroke-width="1"/>`,
    `<text x="${f(nowX)}" y="${plotTop - 8}" font-size="12" fill="${INK.secondary}" text-anchor="middle">nyt</text>`,
  );

  // Lines: past solid, forecast dashed (same colour)
  const pathOf = (pts: Point[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${f(x(p.t))},${f(y(p.v))}`).join(" ");
  for (const s of shown) {
    const visible = trimZeroEnds(s.points.filter((p) => p.t >= viewStart && p.t <= viewEnd));
    const past = visible.filter((p) => p.t <= now);
    const future = visible.filter((p) => p.t >= now);
    const c = color.get(s.s.id)!;
    const common = `fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
    if (past.length > 1) out.push(`<path d="${pathOf(past)}" ${common}/>`);
    if (future.length > 1) out.push(`<path d="${pathOf(future)}" ${common} stroke-dasharray="6 5"/>`);
  }
  // "now" dots with a surface ring, drawn above all lines
  for (const s of shown) {
    out.push(`<circle cx="${f(nowX)}" cy="${f(y(s.current))}" r="4.5" fill="${color.get(s.s.id)}" stroke="${SURFACE}" stroke-width="2"/>`);
  }

  // Direct labels at the "now" dot, pushed apart vertically with leader lines when needed
  if (direct) {
    const labels = shown
      .map((s) => ({
        dotY: y(s.current),
        y: y(s.current) - 10,
        text: single ? pm(s.current) : `${truncate(s.s.name, 16)} ${pm(s.current)}`,
      }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i]!.y = Math.max(labels[i]!.y, labels[i - 1]!.y + 17);
    for (const l of labels) l.y = Math.min(Math.max(l.y, plotTop + 14), plotBottom - 4);
    const maxChars = Math.max(...labels.map((l) => [...l.text].length));
    const toRight = nowX + 10 + maxChars * 7.6 <= plotRight;
    const lx = toRight ? nowX + 10 : nowX - 10;
    for (const l of labels) {
      if (Math.abs(l.y - 4 - l.dotY) > 12) {
        out.push(`<line x1="${f(nowX)}" y1="${f(l.dotY)}" x2="${f(lx + (toRight ? -2 : 2))}" y2="${f(l.y - 4)}" stroke="${INK.muted}" stroke-width="1"/>`);
      }
      out.push(
        `<text x="${f(lx)}" y="${f(l.y)}" font-size="13" fill="${INK.primary}" text-anchor="${toRight ? "start" : "end"}" stroke="${SURFACE}" stroke-width="4" stroke-linejoin="round" paint-order="stroke">${esc(l.text)}</text>`,
      );
    }
  }

  // Legend (two or more series): line key + name + current value, ordered by current value
  if (!single) {
    const colW = (plotRight - PAD) / legendCols;
    const entries = [...shown].sort((a, b) => b.current - a.current || b.peak - a.peak);
    entries.forEach((s, i) => {
      const lx = PAD + (i % legendCols) * colW;
      const ly = legendTop + Math.floor(i / legendCols) * 26;
      out.push(
        `<line x1="${f(lx)}" x2="${f(lx + 20)}" y1="${ly - 5}" y2="${ly - 5}" stroke="${color.get(s.s.id)}" stroke-width="2" stroke-linecap="round"/>`,
        `<circle cx="${f(lx + 10)}" cy="${ly - 5}" r="4" fill="${color.get(s.s.id)}"/>`,
        `<text x="${f(lx + 28)}" y="${ly}" font-size="14" fill="${INK.primary}">${esc(truncate(s.s.name, 22))} <tspan fill="${INK.secondary}">${pm(s.current)}</tspan></text>`,
      );
    });
    if (hidden > 0) {
      const i = entries.length;
      out.push(
        `<text x="${f(PAD + (i % legendCols) * colW)}" y="${legendTop + Math.floor(i / legendCols) * 26}" font-size="14" fill="${INK.muted}">+${hidden} muuta</text>`,
      );
    }
  }

  out.push("</svg>");
  return { svg: out.join("\n"), width: W, height: H, shown: shown.length, hidden };
}
