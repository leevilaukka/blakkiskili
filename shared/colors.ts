// Chart line colours, shared by the bot's chart picture (light only) and the website's chart
// (light and dark), so a person's line is the same colour in both.
//
// Slots 0-9 are the dataviz palette, light steps validated on the light chart surface and dark
// steps on the dark one. Past those, colours are generated: the hue turns by the golden angle so
// neighbouring slots land far apart on the wheel, and the lightness cycles through three steps so
// two slots that end up near the same hue still differ in lightness. Every generated colour is
// held in the mode's lightness band and to 3:1 contrast against that mode's surface. The legend
// and the direct labels carry identity too, so large groups never depend on colour alone.

export type ColorMode = "light" | "dark";

const FIXED: Record<ColorMode, readonly string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#8c564b", "#17becf"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767", "#8c564b", "#17becf"],
};
/** How many slots are the validated palette; a chart of at most this many people uses only these. */
export const FIXED_COLORS = FIXED.light.length;

const SURFACE: Record<ColorMode, string> = { light: "#fcfcfb", dark: "#1a1a19" };
// OKLCH lightness steps (cycled) and the band they're clamped to while reaching 3:1 contrast.
const STEPS: Record<ColorMode, readonly number[]> = { light: [0.55, 0.45, 0.63], dark: [0.6, 0.52, 0.66] };
const BAND: Record<ColorMode, readonly [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const CHROMA = 0.16;
const GOLDEN_ANGLE = 137.508;
const FIRST_HUE = 330; // the first generated hue (a magenta), away from the fixed palette's blues

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** OKLCH to linear sRGB; components outside 0..1 mean the colour is out of gamut. */
function oklchToLinear(L: number, C: number, hue: number): [number, number, number] {
  const a = C * Math.cos((hue * Math.PI) / 180);
  const b = C * Math.sin((hue * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** The most saturated in-gamut colour at this lightness and hue, up to CHROMA. */
function oklchHex(L: number, hue: number): string {
  let C = CHROMA;
  let rgb = oklchToLinear(L, C, hue);
  while (C > 0 && rgb.some((c) => c < 0 || c > 1)) rgb = oklchToLinear(L, (C -= 0.005), hue);
  return "#" + rgb.map((c) => Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255).toString(16).padStart(2, "0")).join("");
}

function generated(index: number, mode: ColorMode): string {
  const hue = (FIRST_HUE + index * GOLDEN_ANGLE) % 360;
  const [lo, hi] = BAND[mode];
  // Toward the surface's opposite until the line stands out from it: darker on light, lighter on dark.
  const dir = mode === "light" ? -1 : 1;
  let L = STEPS[mode][index % STEPS[mode].length]!;
  let hex = oklchHex(L, hue);
  while (contrast(hex, SURFACE[mode]) < 3 && L > lo && L < hi) hex = oklchHex((L += dir * 0.01), hue);
  return hex;
}

const cache: Record<ColorMode, string[]> = { light: [], dark: [] };

/** The colour of chart slot `slot` (0-based) in the given mode. Any slot has one. */
export function seriesColor(slot: number, mode: ColorMode): string {
  if (slot < FIXED_COLORS) return FIXED[mode][Math.max(0, slot)]!;
  const list = cache[mode];
  while (list.length <= slot - FIXED_COLORS) list.push(generated(list.length, mode));
  return list[slot - FIXED_COLORS]!;
}
