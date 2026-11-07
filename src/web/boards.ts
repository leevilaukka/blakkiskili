// Turns the members of a group (or one person) into what the website shows: a chart and a
// leaderboard. Used by the group page and by event screens; screens anonymise members who asked
// to be hidden.

import { calculateEbac } from "../lib/alcomath.ts";
import { buildChartData, type ChartSeries } from "../lib/chart.ts";
import { chartLabel } from "../services/accounts.ts";
import type { Member } from "../services/groups.ts";
import type { Services } from "../services/index.ts";
import { HOUR_MS, STANDARD_DRINK_GRAMS } from "../lib/units.ts";
import type { BoardRow, ChartData } from "../../shared/api.ts";

export interface Board {
  chart: ChartData;
  rows: BoardRow[];
}

/** A stable opaque handle for a member inside one group; reveals nothing about the account. */
export const memberRef = (services: Services, groupId: string, accountId: string) =>
  services.deps.crypto.webTokenKey(`member:${groupId}:${accountId}`).slice(0, 16);

export function buildBoard(
  services: Services,
  groupId: string,
  members: readonly Member[],
  now: number,
  opts: { viewerId?: string; anonymize: boolean },
): Board {
  // "Nimetön 1, 2, ...": numbered in the order of their handles, so the numbers stay put.
  const hidden = members
    .filter((m) => opts.anonymize && m.hideOnScreen)
    .map((m) => memberRef(services, groupId, m.userId))
    .sort();
  const nameOf = (m: Member) => (opts.anonymize && m.hideOnScreen ? `Nimetön ${hidden.indexOf(memberRef(services, groupId, m.userId)) + 1}` : chartLabel(m));

  const series: ChartSeries[] = members.map((m) => ({
    id: memberRef(services, groupId, m.userId),
    name: nameOf(m),
    body: m.body,
    drinks: m.drinks,
  }));
  const rows = members.map((m): BoardRow => {
    const ebac = calculateEbac(m.body, m.drinks, now);
    const grams12h = m.drinks.filter((d) => d.createdAt > now - 12 * HOUR_MS).reduce((sum, d) => sum + d.alcoholMg, 0) / 1000;
    return {
      ref: memberRef(services, groupId, m.userId),
      name: nameOf(m),
      permille: ebac.permilles,
      standardDrinks12h: grams12h / STANDARD_DRINK_GRAMS,
      hidden: m.hideOnScreen,
      isMe: m.userId === opts.viewerId,
    };
  });
  rows.sort((a, b) => b.permille - a.permille || a.name.localeCompare(b.name, "fi"));
  return { chart: buildChartData(series, now), rows };
}
