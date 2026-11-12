import { describe, expect, test } from "bun:test";
import { readDate, readTime, showDate, showTime } from "../web/src/lib/fidate.ts";

const now = new Date(2026, 10, 12);

describe("Finnish dates and times in the website's fields", () => {
  test("dates are read in the usual Finnish forms", () => {
    for (const text of ["24.12.2026", "24.12.26", "24.12.", "24.12", "24122026", " 24.12.2026 ", "24/12/2026"]) {
      expect(readDate(text, now)).toBe("2026-12-24");
    }
    expect(readDate("1.2.2026", now)).toBe("2026-02-01");
  });

  test("days that don't exist and plain nonsense are refused", () => {
    for (const text of ["31.2.2026", "0.1.2026", "32.1.2026", "24.13.2026", "huomenna", "2026-12-24", ""]) {
      expect(readDate(text, now)).toBeNull();
    }
    expect(readDate("29.2.2028", now)).toBe("2028-02-29");
    expect(readDate("29.2.2027", now)).toBeNull();
  });

  test("dates are shown as d.m.yyyy", () => {
    expect(showDate("2026-12-04")).toBe("4.12.2026");
    expect(showDate("")).toBe("");
  });

  test("times are read as 18.30, 18:30, 1830 or 18", () => {
    for (const text of ["18.30", "18:30", "1830", " 18.30 "]) expect(readTime(text)).toBe("18:30");
    expect(readTime("8")).toBe("08:00");
    expect(readTime("0.05")).toBe("00:05");
    for (const text of ["24.00", "18.60", "abc", ""]) expect(readTime(text)).toBeNull();
    expect(showTime("18:30")).toBe("18.30");
  });
});
