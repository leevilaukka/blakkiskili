// Drink presets shown in the /start → Juo menu. Ported from app/commands/start/juo.js.
// This is the natural place to plug in an external product catalogue later (e.g. Alkometriikka).
// Copyright (C) 2017 Joonas Ulmanen, GPL-3.0-or-later; ported and modified November 2026.

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
  kcal: number; // typical energy of this amount
}

export interface DrinkCategory {
  id: "miedot" | "viinit" | "shotit";
  presets: DrinkPreset[];
}

/**
 * `kcal100` is a typical energy per 100 ml: the median of comparable Alko products in
 * Alkometriikka's data (Nov 2026), e.g. 4.5–4.9 % lagers 40, 11.5–12.5 % wines 70, 40 % spirits 220.
 */
const p = (id: string, name: string, abv: number, litres: number, kcal100: number): DrinkPreset => ({
  id,
  name,
  mg: alcoholMg(abv, litres),
  kcal: Math.round(kcal100 * litres * 10),
});

export const CATALOG: DrinkCategory[] = [
  {
    id: "miedot",
    presets: [
      p("b33a", `${EMOJI.beer} 33cl 4.7%`, 0.047, 0.33, 40),
      p("b33b", `${EMOJI.beer} 33cl 5.3%`, 0.053, 0.33, 50),
      p("b33c", `${EMOJI.beer} 33cl 5.5%`, 0.055, 0.33, 50), // the original /juoma's "nelonen"
      p("b40", `${EMOJI.beer} 40cl 4.7%`, 0.047, 0.4, 40),
      p("b50", `${EMOJI.beer} 50cl 4.7%`, 0.047, 0.5, 40),
      p("b568", `${EMOJI.beer} 56.8cl 4.7%`, 0.047, 0.568, 40),
      p("lonk", "Lonkero 33cl 5.3%", 0.053, 0.33, 60),
      p("sid", "Siideri 33cl 4.7%", 0.047, 0.33, 50),
    ],
  },
  {
    id: "viinit",
    presets: [
      p("w12", `${EMOJI.wine} 12cl 12%`, 0.12, 0.12, 70),
      p("w16", `${EMOJI.wine} 16cl 12%`, 0.12, 0.16, 70),
      p("w20", `${EMOJI.drink} 20cl 12%`, 0.12, 0.2, 70),
      p("sp12", `${EMOJI.glasses} 12cl 11%`, 0.11, 0.12, 70),
    ],
  },
  {
    id: "shotit",
    presets: [
      p("s20", `${EMOJI.shot}4cl 20%`, 0.2, 0.04, 220),
      p("s32", `${EMOJI.shot}4cl 32%`, 0.32, 0.04, 230),
      p("s38", `${EMOJI.shot}4cl 38%`, 0.38, 0.04, 210),
      p("s40", `${EMOJI.shot}4cl 40%`, 0.4, 0.04, 220),
      p("s60", `${EMOJI.shot}4cl 60%`, 0.6, 0.04, 320),
    ],
  },
];

const byId = new Map(CATALOG.flatMap((c) => c.presets).map((preset) => [preset.id, preset]));

export function findPreset(id: string): DrinkPreset | undefined {
  return byId.get(id);
}

/** Shortcut commands kept from the original bot. */
export const KALJA033: DrinkPreset = p("k033", "/kalja033", 0.047, 0.33, 40);
export const KALJA05: DrinkPreset = p("k05", "/kalja05", 0.047, 0.5, 40);
