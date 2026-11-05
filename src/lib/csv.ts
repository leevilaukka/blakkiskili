// RFC 4180 CSV, compatible with the files the original bot's /data command produced:
// UTF-8 BOM, CRLF line endings, quoted cells when needed, and a leading "'" added to
// string cells that start with = + - @ tab or CR (spreadsheet formula injection guard).

export type CsvRow = Record<string, string>;

const FORMULA_START = /^[=+\-@\t\r]/;

function toCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let cell = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && FORMULA_START.test(cell)) cell = "'" + cell;
  return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(toCell), ...rows.map((row) => columns.map((c) => toCell(row[c])))];
  return "﻿" + lines.map((line) => line.join(",") + "\r\n").join("");
}

/** Parses CSV text into header + records. Throws on unterminated quotes. */
export function parseCsv(text: string): { columns: string[]; rows: CsvRow[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  const endCell = () => {
    record.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    // Skip completely empty lines.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRecord();
    } else if (ch === "\n") {
      endRecord();
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new Error("CSV: unterminated quoted field");
  if (cell !== "" || record.length > 0) endRecord();

  const [header, ...body] = records;
  if (!header) return { columns: [], rows: [] };
  const columns = header.map((c) => c.trim().toLowerCase());
  const rows = body.map((cells) => {
    const row: CsvRow = {};
    columns.forEach((c, idx) => (row[c] = cells[idx] ?? ""));
    return row;
  });
  return { columns, rows };
}

/** Undoes the formula guard that toCsv adds to user-entered text. */
export function unescapeFormulaGuard(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell;
}
