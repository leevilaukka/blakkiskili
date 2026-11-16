import { describe, expect, test } from "bun:test";
import { CsvLimitError, parseCsv, parseCsvHeader, toCsv, unescapeFormulaGuard } from "../src/lib/csv.ts";

// Exactly what the original bot's utils.toCsv produced (BOM, CRLF, quoting, formula guard).
const OLD_DRINKS_CSV =
  "﻿id,userid,alcohol,description,created\r\n" +
  "1,abc,12379,🍺 33cl 4.7%,2024-05-01T18:30:00.000Z\r\n" +
  '2,abc,15000,"Oma juoma - 33cl 5,5%",2024-05-01T19:00:00.000Z\r\n' +
  '3,abc,1000,"say ""hi""\nnext line",2024-05-01T19:30:00.000Z\r\n' +
  "4,abc,1000,'=SUM(A1),2024-05-01T20:00:00.000Z\r\n" +
  "5,abc,1000,,2024-05-01T20:30:00.000Z\r\n";

describe("csv", () => {
  test("parses the original export format", () => {
    const { columns, rows } = parseCsv(OLD_DRINKS_CSV);
    expect(columns).toEqual(["id", "userid", "alcohol", "description", "created"]);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.description).toBe("🍺 33cl 4.7%");
    expect(rows[1]!.description).toBe("Oma juoma - 33cl 5,5%");
    expect(rows[2]!.description).toBe('say "hi"\nnext line');
    expect(unescapeFormulaGuard(rows[3]!.description!)).toBe("=SUM(A1)");
    expect(rows[4]!.description).toBe("");
  });

  test("round-trips through toCsv", () => {
    const rows = [
      { a: "plain", b: 'quote " and, comma', c: "=formula" },
      { a: "multi\r\nline", b: 42, c: null },
    ];
    const parsed = parseCsv(toCsv(["a", "b", "c"], rows));
    expect(parsed.rows[0]).toEqual({ a: "plain", b: 'quote " and, comma', c: "'=formula" });
    expect(unescapeFormulaGuard(parsed.rows[0]!.c!)).toBe("=formula");
    expect(parsed.rows[1]).toEqual({ a: "multi\r\nline", b: "42", c: "" });
  });

  test("leaves apostrophes that aren't a formula guard alone", () => {
    expect(unescapeFormulaGuard("'tis")).toBe("'tis");
  });

  test("rejects unterminated quotes", () => {
    expect(() => parseCsv('a,b\r\n"open,1\r\n')).toThrow();
  });

  // A wide header made every one-character row an object with thousands of keys: 44 KB of
  // file grew the process by ~54 MB. Limits are checked while reading.
  test("refuses files over the limits before building them", () => {
    const limits = { maxColumns: 4, maxRows: 5, maxCells: 12, maxCellLength: 10 };
    expect(() => parseCsv("a,b,c,d,e\r\n", limits)).toThrow(CsvLimitError); // wide header
    expect(() => parseCsv("a,b\r\n1,2,3,4,5\r\n", limits)).toThrow(CsvLimitError); // wide row
    expect(() => parseCsv("a,b,c,d\r\n" + ",\r\n".repeat(4), limits)).toThrow(CsvLimitError); // 4 rows × 4 columns
    expect(parseCsv("a,b,c,d\r\n" + ",\r\n".repeat(3), limits).rows).toHaveLength(3);
    expect(() => parseCsv("a\r\n" + "x\r\n".repeat(6), limits)).toThrow(CsvLimitError); // 6 rows
    expect(parseCsv("a\r\n" + "x\r\n".repeat(5), limits).rows).toHaveLength(5);
    expect(() => parseCsv("a\r\n" + "x".repeat(11) + "\r\n", limits)).toThrow(CsvLimitError); // long cell
    expect(() => parseCsv(Array.from({ length: 4000 }, (_, i) => `c${i}`).join(",") + "\n" + ",\n".repeat(9000))).toThrow(CsvLimitError);
  });

  test("the header alone, without reading the rest", () => {
    expect(parseCsvHeader(OLD_DRINKS_CSV)).toEqual(["id", "userid", "alcohol", "description", "created"]);
    expect(parseCsvHeader('A,B\r\n"unterminated')).toEqual(["a", "b"]);
    expect(parseCsvHeader("")).toEqual([]);
  });
});
