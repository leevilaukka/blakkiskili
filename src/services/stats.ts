import { DAY_MS } from "../lib/units.ts";
import type { Deps } from "./index.ts";

export interface TopEntry {
  name: string;
  value: number; // drink count, or grams of alcohol
}

export class Stats {
  constructor(private readonly deps: Deps) {}

  private top(rows: { name_enc: string; value: number }[]): TopEntry[] {
    return rows.map((r) => ({ name: this.deps.crypto.decrypt(r.name_enc), value: r.value }));
  }

  /** Group totals and top 10 for `days` back (or the group's whole history). */
  group(chatId: number, metric: "count" | "grams", days?: number) {
    const now = this.deps.now();
    const since = days ? now - days * DAY_MS : 0;
    const groupId = this.deps.crypto.groupKey(chatId);
    const valueExpr = metric === "count" ? "count(*)" : "sum(d.alcohol_mg) / 1000.0";

    const top = this.top(
      this.deps.db
        .query(
          `SELECT u.name_enc, ${valueExpr} AS value
           FROM group_members m JOIN users u ON u.id = m.user_id
           JOIN drinks d ON d.user_id = u.id AND d.created_at > ?
           WHERE m.group_id = ?
           GROUP BY u.id ORDER BY value DESC LIMIT 10`,
        )
        .all(since, groupId) as { name_enc: string; value: number }[],
    );
    const total = this.deps.db
      .query(
        `SELECT coalesce(sum(d.alcohol_mg), 0) AS mg, min(d.created_at) AS first
         FROM group_members m JOIN drinks d ON d.user_id = m.user_id AND d.created_at > ?
         WHERE m.group_id = ?`,
      )
      .get(since, groupId) as { mg: number; first: number | null };
    const global = this.deps.db
      .query("SELECT count(*) AS count, coalesce(sum(alcohol_mg), 0) AS mg FROM drinks")
      .get() as { count: number; mg: number };

    const dayCount = Math.max(1, days ?? Math.ceil((now - (total.first ?? now)) / DAY_MS));
    return { top, grams: total.mg / 1000, dayCount, globalCount: global.count, globalGrams: global.mg / 1000 };
  }

  /** Bot-wide numbers for /admin_stats. */
  global() {
    const now = this.deps.now();
    const one = (sql: string, ...params: number[]) =>
      (this.deps.db.query(sql).get(...params) as { n: number }).n;
    const activeUsers = (days: number) =>
      one("SELECT count(DISTINCT user_id) AS n FROM drinks WHERE created_at > ?", now - days * DAY_MS);
    const activeGroups = (days: number) =>
      one(
        `SELECT count(DISTINCT m.group_id) AS n FROM group_members m
         JOIN drinks d ON d.user_id = m.user_id WHERE d.created_at > ?`,
        now - days * DAY_MS,
      );
    return {
      users: one("SELECT count(*) AS n FROM users"),
      activeUsers7: activeUsers(7),
      activeUsers14: activeUsers(14),
      groups: one("SELECT count(*) AS n FROM groups"),
      activeGroups7: activeGroups(7),
      activeGroups14: activeGroups(14),
      drinks: one("SELECT count(*) AS n FROM drinks"),
      top: this.top(
        this.deps.db
          .query(
            `SELECT u.name_enc, count(*) AS value FROM drinks d JOIN users u ON u.id = d.user_id
             GROUP BY u.id ORDER BY value DESC LIMIT 10`,
          )
          .all() as { name_enc: string; value: number }[],
      ),
    };
  }
}
