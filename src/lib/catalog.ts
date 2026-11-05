// Drink presets shown in the /start → Juo menu. Ported from app/commands/start/juo.js.
// This is the natural place to plug in an external product catalogue later (e.g. Alkometriikka).

import { alcoholMg } from "./units.ts";

export const EMOJI = {
  beer: "🍺",
  wine: "🍷",
  glasses: "🥂",
  shot: "🥃",
  drink: "🍹",
} as const;

export interface DrinkPreset {
  id: string; // stable, short: goes into callback data
  name: string; // also stored as the drink description
  mg: number;
}

export interface DrinkCategory {
  id: "miedot" | "viinit" | "shotit";
  presets: DrinkPreset[];
}

const p = (id: string, name: string, abv: number, litres: number): DrinkPreset => ({
  id,
  name,
  mg: alcoholMg(abv, litres),
});

export const CATALOG: DrinkCategory[] = [
  {
    id: "miedot",
    presets: [
      p("b33a", `${EMOJI.beer} 33cl 4.7%`, 0.047, 0.33),
      p("b33b", `${EMOJI.beer} 33cl 5.3%`, 0.053, 0.33),
      p("b33c", `${EMOJI.beer} 33cl 5.5%`, 0.055, 0.33), // the original /juoma's "nelonen"
      p("b40", `${EMOJI.beer} 40cl 4.7%`, 0.047, 0.4),
      p("b50", `${EMOJI.beer} 50cl 4.7%`, 0.047, 0.5),
      p("b568", `${EMOJI.beer} 56.8cl 4.7%`, 0.047, 0.568),
      p("lonk", "Lonkero 33cl 5.3%", 0.053, 0.33),
      p("sid", "Siideri 33cl 4.7%", 0.047, 0.33),
    ],
  },
  {
    id: "viinit",
    presets: [
      p("w12", `${EMOJI.wine} 12cl 12%`, 0.12, 0.12),
      p("w16", `${EMOJI.wine} 16cl 12%`, 0.12, 0.16),
      p("w20", `${EMOJI.drink} 20cl 12%`, 0.12, 0.2),
      p("sp12", `${EMOJI.glasses} 12cl 11%`, 0.11, 0.12),
    ],
  },
  {
    id: "shotit",
    presets: [
      p("s20", `${EMOJI.shot}4cl 20%`, 0.2, 0.04),
      p("s32", `${EMOJI.shot}4cl 32%`, 0.32, 0.04),
      p("s38", `${EMOJI.shot}4cl 38%`, 0.38, 0.04),
      p("s40", `${EMOJI.shot}4cl 40%`, 0.4, 0.04),
      p("s60", `${EMOJI.shot}4cl 60%`, 0.6, 0.04),
    ],
  },
];

const byId = new Map(CATALOG.flatMap((c) => c.presets).map((preset) => [preset.id, preset]));

export function findPreset(id: string): DrinkPreset | undefined {
  return byId.get(id);
}

/** Shortcut commands kept from the original bot. */
export const KALJA033: DrinkPreset = p("k033", "/kalja033", 0.047, 0.33);
export const KALJA05: DrinkPreset = p("k05", "/kalja05", 0.047, 0.5);
