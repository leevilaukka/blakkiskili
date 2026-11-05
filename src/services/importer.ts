// Imports the CSV files produced by the original bot's /data command (and by our own /data,
// which uses the same format). Every row's `userid` must equal sha256(sender's Telegram id),
// which proves the export belongs to the person sending it.

import { isGender, isValidHeight, isValidWeight, type Accounts } from "./accounts.ts";
import { parseCsv, unescapeFormulaGuard, type CsvRow } from "../lib/csv.ts";
import { legacyHash } from "../lib/ids.ts";
import { SINGLE_DRINK_ALCOHOL_LIMIT_MG } from "../lib/units.ts";
import type { Deps } from "./index.ts";

export type CsvKind = "user" | "drinks" | "groups";

export type ImportResult =
  | { ok: true; kind: "user"; created: boolean }
  | { ok: true; kind: "drinks"; inserted: number; duplicates: number; invalid: number }
  | { ok: true; kind: "groups"; groups: number }
  | { ok: false; reason: "unknown_format" | "not_yours" | "empty" | "invalid_profile" | "no_account" | "parse_error" };

export function detectKind(columns: readonly string[]): CsvKind | null {
  const has = (...c: string[]) => c.every((x) => columns.includes(x));
  if (has("userid", "nick", "weight", "gender", "height")) return "user";
  if (has("userid", "alcohol", "created")) return "drinks";
  if (has("userid", "groupid")) return "groups";
  return null;
}

/** Old exports have timestamps like 2024-05-01T18:30:00.000Z; be lenient with other ISO forms. */
function parseTime(s: string | undefined): number {
  if (!s) return NaN;
  return Date.parse(s.trim());
}

export class Importer {
  constructor(
    private readonly deps: Deps,
    private readonly accounts: Accounts,
  ) {}

  /** Parses just enough to tell which file it is (to order processing). */
  peek(text: string): CsvKind | null {
    try {
      return detectKind(parseCsv(text).columns);
    } catch {
      return null;
    }
  }

  import(text: string, telegramUserId: number, userId: string, fallbackName: string): ImportResult {
    let parsed: { columns: string[]; rows: CsvRow[] };
    try {
      parsed = parseCsv(text);
    } catch {
      return { ok: false, reason: "parse_error" };
    }
    const kind = detectKind(parsed.columns);
    if (!kind) return { ok: false, reason: "unknown_format" };
    if (parsed.rows.length === 0) return { ok: false, reason: "empty" };

    const expected = legacyHash(telegramUserId);
    if (!parsed.rows.every((r) => r.userid?.trim().toLowerCase() === expected)) {
      return { ok: false, reason: "not_yours" };
    }

    switch (kind) {
      case "user":
        return this.importUser(parsed.rows[0]!, userId, telegramUserId, fallbackName);
      case "drinks":
        return this.importDrinks(parsed.rows, userId);
      case "groups":
        return this.importGroups(parsed.rows, userId);
    }
  }

  private importUser(row: CsvRow, userId: string, telegramUserId: number, fallbackName: string): ImportResult {
    const weight = Number(row.weight);
    const height = Number(row.height);
    const gender = (row.gender ?? "").trim().toLowerCase();
    if (!isValidWeight(weight) || !isValidHeight(height) || !isGender(gender)) {
      return { ok: false, reason: "invalid_profile" };
    }
    const created = parseTime(row.created);
    const { created: isNew } = this.accounts.upsert(userId, {
      telegramId: telegramUserId,
      // The current Telegram name wins over the exported one; it's what friends recognise.
      name: fallbackName || unescapeFormulaGuard(row.nick ?? "") || "?",
      weight,
      height,
      gender,
      createdAt: Number.isFinite(created) ? created : undefined,
    });
    return { ok: true, kind: "user", created: isNew };
  }

  private importDrinks(rows: CsvRow[], userId: string): ImportResult {
    if (!this.accounts.get(userId)) return { ok: false, reason: "no_account" };
    const insert = this.deps.db.query(
      "INSERT OR IGNORE INTO drinks (user_id, alcohol_mg, description, created_at, product_id) VALUES (?, ?, ?, ?, ?)",
    );
    let inserted = 0;
    let duplicates = 0;
    let invalid = 0;
    const now = this.deps.now();
    this.deps.db.transaction(() => {
      for (const r of rows) {
        const mg = Number(r.alcohol);
        const at = parseTime(r.created);
        if (!Number.isInteger(mg) || mg < 0 || mg > SINGLE_DRINK_ALCOHOL_LIMIT_MG * 2 || !Number.isFinite(at) || at > now + 60_000) {
          invalid += 1;
          continue;
        }
        const description = unescapeFormulaGuard(r.description ?? "").slice(0, 200);
        // Only exports from this bot have product_id; the original bot's don't.
        const productId = /^\d{1,10}$/.test(r.product_id ?? "") ? r.product_id! : null;
        if (insert.run(userId, mg, description, at, productId).changes > 0) inserted += 1;
        else duplicates += 1;
      }
    })();
    return { ok: true, kind: "drinks", inserted, duplicates, invalid };
  }

  private importGroups(rows: CsvRow[], userId: string): ImportResult {
    if (!this.accounts.get(userId)) return { ok: false, reason: "no_account" };
    const insert = this.deps.db.query(
      "INSERT OR IGNORE INTO legacy_group_memberships (user_id, legacy_group_id) VALUES (?, ?)",
    );
    let groups = 0;
    this.deps.db.transaction(() => {
      for (const r of rows) {
        const gid = (r.groupid ?? "").trim().toLowerCase();
        // Only the original bot's sha256 format can be matched to a chat later.
        if (/^[0-9a-f]{64}$/.test(gid) && insert.run(userId, gid).changes > 0) groups += 1;
      }
    })();
    return { ok: true, kind: "groups", groups };
  }
}
