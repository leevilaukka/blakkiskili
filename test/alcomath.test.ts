import { describe, expect, test } from "bun:test";
import {
  calculateEbac,
  calculateEbacByHour,
  estimateAbsorbedAlcoholConcentration,
  estimateUnburnedAlcohol,
  widmarkFactor,
  type BodyProfile,
} from "../src/lib/alcomath.ts";
import { alcoholMg, HOUR_MS, STANDARD_DRINK_GRAMS } from "../src/lib/units.ts";

const male: BodyProfile = { weight: 90, height: 190, gender: "mies" };
const female: BodyProfile = { weight: 90, height: 190, gender: "nainen" };
const now = Date.parse("2026-11-06T22:00:00Z");
const beer = 12241; // 0.33l 4.7% (the original test comment says 12379, but its formula gives 12241)

describe("units", () => {
  test("0.33l 4.7% beer, same formula as the original constants.js", () => {
    expect(alcoholMg(0.047, 0.33)).toBe(beer);
  });
});

// Ported from the original test/lib/alcomath.js
describe("alcomath (original behaviour)", () => {
  test("widmark factor depends on gender, height and weight", () => {
    expect(widmarkFactor(male)).not.toBe(widmarkFactor(female));
    expect(widmarkFactor(male)).not.toBe(widmarkFactor({ ...male, height: 180 }));
    expect(widmarkFactor(male)).not.toBe(widmarkFactor({ ...male, weight: 80 }));
  });

  test("absorption is 0 at t=0 and increases over time", () => {
    const mg = STANDARD_DRINK_GRAMS * 1000;
    const at = (t: number) => estimateAbsorbedAlcoholConcentration(male, mg, t);
    expect(at(0)).toBe(0);
    expect(at(0)).toBeLessThan(at(0.25));
    expect(at(0.25)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(24));
  });

  test("unburned alcohol is positive for 0.5 permilles", () => {
    expect(estimateUnburnedAlcohol(male, 0.5)).toBeGreaterThan(0);
  });

  test("a drink right now: ~0 now, more in 30 min", () => {
    const e = calculateEbac(male, [{ createdAt: now, alcoholMg: beer }], now);
    expect(e.permilles).toBeLessThan(0.01);
    expect(e.permilles).toBeLessThan(e.permilles30Min);
  });

  test("a drink an hour ago is already burning", () => {
    const e = calculateEbac(male, [{ createdAt: now - HOUR_MS, alcoholMg: beer }], now);
    expect(e.permilles).toBeGreaterThan(e.permilles30Min);
  });

  test("a drink a day ago is gone", () => {
    const e = calculateEbac(male, [{ createdAt: now - 24 * HOUR_MS, alcoholMg: beer }], now);
    expect(e).toEqual({ permilles: 0, permilles30Min: 0, grams: 0, burnHours: 0 });
  });

  test("females get higher estimates than males", () => {
    const d = [{ createdAt: now - HOUR_MS, alcoholMg: beer }];
    expect(calculateEbac(female, d, now).permilles).toBeGreaterThan(calculateEbac(male, d, now).permilles);
  });

  test("no drinks → zeros", () => {
    expect(calculateEbac(male, [], now).permilles).toBe(0);
  });

  test("hourly series has lastN + predictN + 1 points, 0 until the drink", () => {
    const d = [{ createdAt: now, alcoholMg: beer }];
    expect(calculateEbacByHour(male, d, 0, 0, now)).toHaveLength(1);
    const series = calculateEbacByHour(male, d, 12, 1, now);
    expect(series).toHaveLength(14);
    for (const h of series) {
      if (h.time <= now) expect(h.permilles).toBe(0);
      else expect(h.permilles).toBeGreaterThan(0);
    }
  });
});

// Values produced by running the original app/lib/alcomath.js on the same input.
describe("alcomath parity with the original implementation", () => {
  const session = [
    [-3, 12379],
    [-2.5, 12379],
    [-2, 18752],
    [-1, 12627],
    [-0.25, 12627],
  ].map(([h, mg]) => ({ createdAt: now + h! * HOUR_MS, alcoholMg: mg! }));

  test("male 80kg 180cm", () => {
    const e = calculateEbac({ weight: 80, height: 180, gender: "mies" }, session, now);
    expect(e.permilles).toBeCloseTo(0.9309016546065028, 12);
    expect(e.permilles30Min).toBeCloseTo(0.8982440071724812, 12);
    expect(e.grams).toBeCloseTo(44.53234172957618, 10);
    expect(e.burnHours).toBeCloseTo(5.783788277485183, 10);
  });

  test("female 60kg 165cm", () => {
    const e = calculateEbac({ weight: 60, height: 165, gender: "nainen" }, session, now);
    expect(e.permilles).toBeCloseTo(1.6641437446435223, 12);
    expect(e.permilles30Min).toBeCloseTo(1.6581219303145809, 12);
    expect(e.grams).toBeCloseTo(52.76046973265466, 10);
    expect(e.burnHours).toBeCloseTo(10.253658413615181, 10);
  });
});
