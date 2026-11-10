/*
    Alcohol related math, ported as-is from the original Bläkkisvuohi app/lib/alcomath.js
    (Copyright (C) 2017 Joonas Ulmanen, GPL-3.0-or-later). Ported to TypeScript and modified
    in November 2026. Behaviour is kept identical on purpose so that estimates match what the
    users are used to; only `now` is injectable for testing.

    Variation of the Widmark equation, from "The Estimation of Blood Alcohol Concentration"
    (DOI: 10.1385/Forensic Sci. Med. Pathol.:3:1:33), with absorption taken into account:

        BAC = (A * (1 - e^(-t * ln2 / t_half)) - beta * t) / (r * W)

    where t_half = 0.1066 h (empty stomach). The total is the sum of per-drink absorption,
    minus elimination since the start of the current drinking session.

    Widmark factor r from Seidl et al.:
        r(female) = 0.31223 - 0.006446 W + 0.4466 H
        r(male)   = 0.31608 - 0.004821 W + 0.4632 H

    NOTE: the original feeds H in centimetres (the paper uses metres) and compensates with
    MAGIC_NUMBER, which was tuned "by trial and error when comparing to multiple measurements".
    Do not "fix" one without re-tuning the other.
*/

import { HOUR_MS, METABOLISM_RATE } from "./units.ts";

export type Gender = "mies" | "nainen";

export interface BodyProfile {
  weight: number; // kg
  height: number; // cm
  gender: Gender;
}

export interface DrinkSample {
  alcoholMg: number;
  createdAt: number; // epoch ms
}

export interface Ebac {
  permilles: number;
  permilles30Min: number;
  grams: number; // unburned alcohol in the body
  burnHours: number; // until sober, counted from 30 minutes from now
}

const MAGIC_NUMBER = 6.9;
const ABSORPTION_HALF_LIFE_H = 0.1066;

export function widmarkFactor(user: BodyProfile): number {
  const H = user.height;
  const W = user.weight;
  return user.gender === "mies"
    ? 0.31608 - 0.004821 * W + 0.4632 * H
    : 0.31223 - 0.006446 * W + 0.4466 * H;
}

export function metabolismRate(_user?: BodyProfile): number {
  return METABOLISM_RATE;
}

/** Alcohol absorbed = (A * (1 - e^(-t ln2 / t_half))) / (r W), in permilles. */
export function estimateAbsorbedAlcoholConcentration(
  user: BodyProfile,
  milligrams: number,
  hoursSinceDrink: number,
): number {
  const A = milligrams / 1000 / MAGIC_NUMBER;
  const r = widmarkFactor(user);
  const t = hoursSinceDrink;
  const eaac =
    ((A * (1 - Math.exp((-t * Math.LN2) / ABSORPTION_HALF_LIFE_H))) / (r * user.weight)) * 1000;
  return eaac > 0 ? eaac : 0;
}

/** Inverse of the above at t = 0.5 h: grams of alcohol that correspond to `ebac` permilles. */
export function estimateUnburnedAlcohol(user: BodyProfile, ebac: number): number {
  const r = widmarkFactor(user);
  const t = 0.5;
  const A =
    (((ebac / 1000) * (r * user.weight)) / (1 - Math.exp((-t * Math.LN2) / ABSORPTION_HALF_LIFE_H))) *
    MAGIC_NUMBER;
  return A > 0 ? A : 0;
}

/** `drinks` must be sorted by createdAt ascending. */
export function calculateEbac(
  user: BodyProfile,
  drinks: readonly DrinkSample[],
  now: number = Date.now(),
): Ebac {
  const in30Mins = now + HOUR_MS * 0.5;
  const MR = metabolismRate(user);

  const first = drinks[0];
  if (!first) {
    return { permilles: 0, permilles30Min: 0, grams: 0, burnHours: 0 };
  }

  let absorbed = 0;
  let absorbedIn30 = 0;
  let startTime = first.createdAt;
  for (const drink of drinks) {
    const burnTime = (drink.createdAt - startTime) / HOUR_MS;
    if (absorbed - MR * burnTime <= 0) {
      // Previous session fully burned: start a new one from this drink.
      absorbed = 0;
      absorbedIn30 = 0;
      startTime = drink.createdAt;
    }
    absorbed += estimateAbsorbedAlcoholConcentration(
      user,
      drink.alcoholMg,
      (now - drink.createdAt) / HOUR_MS,
    );
    absorbedIn30 += estimateAbsorbedAlcoholConcentration(
      user,
      drink.alcoholMg,
      (in30Mins - drink.createdAt) / HOUR_MS,
    );
  }

  const permilles = Math.max(absorbed - MR * Math.max((now - startTime) / HOUR_MS, 0), 0);
  const permilles30Min = Math.max(
    absorbedIn30 - MR * Math.max((in30Mins - startTime) / HOUR_MS, 0),
    0,
  );
  let burnHours = permilles30Min / MR;
  burnHours = burnHours > 0 ? burnHours + 0.5 : burnHours;

  return {
    permilles,
    permilles30Min,
    grams: estimateUnburnedAlcohol(user, permilles),
    burnHours,
  };
}

export interface HourlyEbac {
  permilles: number;
  time: number; // epoch ms, start of the hour
}

/** Hourly estimate from `lastNHours` ago to `predictNHours` ahead (for a future chart). */
export function calculateEbacByHour(
  user: BodyProfile,
  drinks: readonly DrinkSample[],
  lastNHours: number,
  predictNHours: number,
  now: number = Date.now(),
): HourlyEbac[] {
  const startTime = now - HOUR_MS * lastNHours - (now % HOUR_MS);
  const MR = metabolismRate(user);
  const out: HourlyEbac[] = [];
  const first = drinks[0];

  for (let i = 0; i < lastNHours + predictNHours + 1; i += 1) {
    const time = startTime + HOUR_MS * i;
    let absorbed = 0;
    let absorptionStart = first ? first.createdAt : time;
    for (const drink of drinks) {
      if (time - drink.createdAt > 0) {
        const burnTime = (drink.createdAt - absorptionStart) / HOUR_MS;
        if (absorbed - MR * burnTime <= 0) {
          absorbed = 0;
          absorptionStart = drink.createdAt;
        }
        absorbed += estimateAbsorbedAlcoholConcentration(
          user,
          drink.alcoholMg,
          (time - drink.createdAt) / HOUR_MS,
        );
      }
    }
    out.push({
      permilles: Math.max(absorbed - MR * Math.max((time - absorptionStart) / HOUR_MS, 0), 0),
      time,
    });
  }
  return out;
}
