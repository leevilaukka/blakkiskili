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

/**
 * Limits on what parseCsv builds, checked while reading, so a small hostile file can't make it
 * allocate far more than its size (a wide header turned every one-character row into an object
 * with thousands of keys). Exports have at most 8 columns and cells of a few hundred characters.
 */
export interface CsvLimits {
  maxColumns: number;
  /** Each row is an object however short it is, so rows are capped too (a heavy user has ~10k drinks). */
  maxRows: number;
  /** Rows × header columns, i.e. the row objects' keys in total. */
  maxCells: number;
  maxCellLength: number;
}

export const CSV_LIMITS: CsvLimits = { maxColumns: 32, maxRows: 100_000, maxCells: 500_000, maxCellLength: 10_000 };

/** The file is over CsvLimits. */
export class CsvLimitError extends Error {}

/** Yields the records (arrays of cells) of CSV text one by one. Throws on unterminated quotes. */
function* readRecords(text: string, limits: CsvLimits): Generator<string[]> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;

  const endCell = () => {
    if (record.length >= limits.maxColumns) throw new CsvLimitError("CSV: too many columns");
    record.push(cell);
    cell = "";
  };
  // An empty line is one empty cell: skipped.
  const finished = () => {
    const done = record;
    record = [];
    return done.length === 1 && done[0] === "" ? null : done;
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (cell.length >= limits.maxCellLength) throw new CsvLimitError("CSV: cell too long");
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
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endCell();
      const done = finished();
      if (done) yield done;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new Error("CSV: unterminated quoted field");
  if (cell !== "" || record.length > 0) {
    endCell();
    const done = finished();
    if (done) yield done;
  }
}

const toColumns = (header: string[]) => header.map((c) => c.trim().toLowerCase());

/** Just the column names (lower-cased): reads only the first record. */
export function parseCsvHeader(text: string, limits = CSV_LIMITS): string[] {
  for (const header of readRecords(text, limits)) return toColumns(header);
  return [];
}

/**
 * Parses CSV text into header + records. Throws on unterminated quotes, and CsvLimitError when
 * the file is over `limits`.
 */
export function parseCsv(text: string, limits = CSV_LIMITS): { columns: string[]; rows: CsvRow[] } {
  let columns: string[] | null = null;
  const rows: CsvRow[] = [];
  let cells = 0;
  for (const cellsOfRecord of readRecords(text, limits)) {
    if (!columns) {
      columns = toColumns(cellsOfRecord);
      continue;
    }
    cells += columns.length;
    if (cells > limits.maxCells || rows.length >= limits.maxRows) throw new CsvLimitError("CSV: too many rows");
    const row: CsvRow = {};
    columns.forEach((c, idx) => (row[c] = cellsOfRecord[idx] ?? ""));
    rows.push(row);
  }
  return { columns: columns ?? [], rows };
}

/** Undoes the formula guard that toCsv adds to user-entered text. */
export function unescapeFormulaGuard(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell;
}
