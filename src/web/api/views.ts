// Turns the services' data into the shapes of shared/api.ts. Used by the handlers and by the live
// updates (live.ts), which push the same views.

import { calculateEbac } from "../../lib/alcomath.ts";
import { buildChartData } from "../../lib/chart.ts";
import { emojiFor, isAlkoProductId, type CatalogDrink } from "../../lib/servings.ts";
import { HOUR_MS, toStandardDrinks } from "../../lib/units.ts";
import { chartLabel, type Profile } from "../../services/accounts.ts";
import { EBAC_WINDOW_MS, type Drink } from "../../services/drinks.ts";
import type { GroupInfo, Member } from "../../services/groups.ts";
import type { Services } from "../../services/index.ts";
import type { ScreenAccess } from "../../services/screens.ts";
import type { Dashboard, DrinkItem, GroupSummary, GroupView, Me, ProductItem, ScreenLinkItem, ScreenView } from "../../../shared/api.ts";
import { buildBoard, memberRef, type Board } from "../boards.ts";

export const toBody = (p: Profile): Omit<Me, "admin"> => ({
  name: p.name,
  chartName: p.chartName,
  chartLabel: chartLabel(p),
  weight: p.weight,
  height: p.height,
  gender: p.gender,
});

export const toMe = (p: Profile, admin: boolean): Me => ({ ...toBody(p), admin });

export const toItem = (d: Drink): DrinkItem => ({
  id: d.id,
  description: d.description,
  alcoholMg: d.alcoholMg,
  standardDrinks: toStandardDrinks(d.alcoholMg / 1000),
  kcal: d.kcal,
  createdAt: d.createdAt,
});

export const toProduct = (d: CatalogDrink): ProductItem => ({
  id: d.id,
  name: d.name,
  maker: d.product.maker,
  abv: d.product.abv,
  type: d.product.type,
  emoji: emojiFor(d.product),
  photo: isAlkoProductId(d.id),
  servings: d.servings.map((s) => ({
    key: s.key,
    label: s.label,
    standardDrinks: s.standardDrinks,
    kcal: s.kcal,
    priceEur: s.priceEur,
  })),
});

export function createViews(services: Services, now: () => number) {
  function dashboard(p: Profile): Dashboard {
    const t = now();
    const recent = services.drinks.since(p.id, t - EBAC_WINDOW_MS);
    const ebac = calculateEbac(p, recent, t);
    const session = services.drinks.session(p.id, t);
    return {
      now: t,
      me: toBody(p),
      permille: ebac.permilles,
      soberAt: ebac.burnHours > 0 ? t + ebac.burnHours * HOUR_MS : null,
      session: {
        drinks: session.map(toItem),
        standardDrinks: toStandardDrinks(session.reduce((sum, d) => sum + d.alcoholMg, 0) / 1000),
        kcal: session.reduce((sum, d) => sum + (d.kcal ?? 0), 0),
        unknownKcal: session.filter((d) => d.kcal === null).length,
      },
      chart: buildChartData([{ id: p.id, name: chartLabel(p), body: p, drinks: recent }], t),
    };
  }

  // The same board is shown to everyone watching a group, so it is built once for a moment and
  // shared; any change announced on the bus drops it.
  const boards = new Map<string, { at: number; board: Board }>();
  services.bus.subscribe(() => boards.clear());
  function board(key: string, groupId: string, members: () => Member[], anonymize: boolean): Board {
    const t = now();
    const hit = boards.get(key);
    if (hit && Math.abs(t - hit.at) < 2000) return hit.board;
    const built = buildBoard(services, groupId, members(), t, { anonymize });
    boards.set(key, { at: t, board: built });
    return built;
  }

  const summary = (info: GroupInfo, p: Profile, hideOnScreen: boolean): GroupSummary => ({
    id: info.id,
    name: info.name ?? "Telegram-ryhmä",
    kind: info.kind,
    memberCount: info.memberCount,
    isOwner: services.groups.ownerOf(info.id) === p.id,
    hideOnScreen,
  });

  const screenItems = (links: ReturnType<Services["screens"]["list"]>, p: Profile): ScreenLinkItem[] =>
    links.map((l) => ({ ref: l.ref, createdAt: l.createdAt, expiresAt: l.expiresAt, mine: l.createdBy === p.id }));

  function groupView(p: Profile, groupId: string): GroupView | null {
    const info = services.groups.get(groupId);
    const mine = services.groups.listFor(p.id).find((g) => g.id === groupId);
    if (!info || !mine) return null;
    const b = board(`g:${groupId}`, groupId, () => services.groups.members(groupId), false);
    const me = memberRef(services, groupId, p.id);
    const isOwner = services.groups.ownerOf(groupId) === p.id;
    return {
      now: now(),
      group: summary(info, p, mine.hideOnScreen),
      chart: b.chart,
      members: b.rows.map((r) => ({ ...r, isMe: r.ref === me })),
      inviteExpiresAt: isOwner ? services.groups.hasInvite(groupId) : null,
      screens: screenItems(services.screens.list({ groupId }), p),
    };
  }

  /** The account as a one-person group, for the personal screen. */
  function personAsMember(p: Profile): Member {
    return { userId: p.id, name: p.name, fullName: p.fullName, chartName: p.chartName, body: p, drinks: services.drinks.since(p.id, now() - EBAC_WINDOW_MS), joinedAt: 0, hideOnScreen: false };
  }

  function screenView(access: ScreenAccess): ScreenView | null {
    if (access.groupId) {
      const info = services.groups.get(access.groupId);
      if (!info) return null;
      const b = board(`s:${access.groupId}`, access.groupId, () => services.groups.members(access.groupId!), true);
      return {
        now: now(),
        title: info.name ?? "Ryhmä",
        kind: "group",
        chart: b.chart,
        members: b.rows.map(({ name, permille, standardDrinks12h }) => ({ name, permille, standardDrinks12h })),
        expiresAt: access.expiresAt,
        photo: info.kind === "telegram" && services.groups.telegramChatId(access.groupId) !== null,
        groupId: access.groupId,
      };
    }
    const p = access.accountId ? services.accounts.get(access.accountId) : null;
    if (!p) return null;
    const b = board(`p:${p.id}`, p.id, () => [personAsMember(p)], false);
    return { now: now(), title: chartLabel(p), kind: "person", chart: b.chart, members: [], expiresAt: access.expiresAt, photo: false, groupId: null };
  }

  return { dashboard, summary, screenItems, groupView, screenView };
}

export type Views = ReturnType<typeof createViews>;
