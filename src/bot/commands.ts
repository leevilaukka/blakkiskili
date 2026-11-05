import type { Bot } from "grammy";
import type { BotContext } from "./context.ts";
import { contactExtras, isPrivate, termsHtml } from "./context.ts";
import { importIntro, juoView, lateView, registerView, renderNode, sessionEnergyText, shortPermilles, startView } from "./menu.ts";
import { sendExport, sendHtml, sendView } from "./ui.ts";
import { InputFile } from "grammy";
import { buildPermilleChart, type ChartSeries } from "../lib/chart.ts";
import { svgToPng } from "../lib/render.ts";
import { EBAC_WINDOW_MS } from "../services/drinks.ts";
import { S, randomDrinkResponse } from "../strings.ts";
import { KALJA033, KALJA05, type DrinkPreset } from "../lib/catalog.ts";
import { dateTime, drinkList, escapeHtml, fmt, hoursMinutes, num, raw } from "../lib/format.ts";
import { DAY_MS, parseIntStrict, roundTo, STANDARD_DRINK_GRAMS } from "../lib/units.ts";
import type { Profile } from "../services/accounts.ts";
import type { Config } from "../config.ts";

type Scope = "private" | "group" | "all";

interface CommandDef {
  name: string;
  description: string;
  scope: Scope;
  needsUser: boolean;
  /** Off-by-config commands behave as unknown and are left out of menus and /komennot. */
  enabled?: (config: Config) => boolean;
  run: (ctx: BotContext, profile: Profile | null, args: string) => Promise<unknown>;
}

const chatTitle = (ctx: BotContext) =>
  ctx.chat && "title" in ctx.chat && ctx.chat.title ? ctx.chat.title : "Ryhmä";

const daysArg = (args: string) => {
  const n = parseIntStrict(args.split(/\s+/)[0]);
  return n > 0 && n <= 3650 ? n : undefined;
};

async function drinkShortcut(ctx: BotContext, p: Profile, preset: DrinkPreset) {
  ctx.kili.services.drinks.add(p.id, preset.mg, preset.name, { kcal: preset.kcal });
  const energy = sessionEnergyText(ctx, p);
  await sendHtml(ctx, `${escapeHtml(randomDrinkResponse())}\n\n${shortPermilles(ctx, p)}${energy ? "\n" + energy : ""}`);
}

/** Private /promillet and /annokset: the long personal summary. */
async function personalSummary(ctx: BotContext, p: Profile) {
  const { drinks } = ctx.kili.services;
  const e = drinks.ebacFor(p);
  const hm = hoursMinutes(e.burnHours);
  const recent = drinks.since(p.id, ctx.kili.services.deps.now() - 3 * DAY_MS);
  await sendHtml(
    ctx,
    fmt(S.long_permilles, {
      permilles: num(e.permilles),
      permilles30Min: num(e.permilles30Min),
      grams: roundTo(e.grams, 0),
      standard_drinks: num(e.grams / STANDARD_DRINK_GRAMS),
      hours: hm.hours,
      minutes: hm.minutes,
      drink_list: raw(drinkList(recent, true)),
    }),
  );
}

async function groupListing(ctx: BotContext, kind: "permilles" | "standardDrinks") {
  const statuses = ctx.kili.services.groups
    .memberStatuses(ctx.chat!.id)
    .filter((s) => s[kind] > 0)
    .sort((a, b) => b[kind] - a[kind]);
  const item = kind === "permilles" ? S.commands.promillet_item : S.commands.annokset_item;
  const list = statuses
    .map((s) =>
      fmt(item, {
        name: s.name,
        permilles: num(s.permilles),
        standard_drinks: num(s.standardDrinks),
        std12h: num(s.std12h),
        std24h: num(s.std24h),
      }),
    )
    .join("\n");
  const template = kind === "permilles" ? S.commands.promillet_group : S.commands.annokset_group;
  await sendHtml(ctx, fmt(template, { chat_title: chatTitle(ctx), list: raw(list || S.commands.nobody) }));
}

async function stats(ctx: BotContext, p: Profile | null, args: string, metric: "count" | "grams") {
  const days = daysArg(args);
  if (isPrivate(ctx)) {
    if (!p) return sendHtml(ctx, S.user404);
    const c = ctx.kili.services.drinks.consumption(p.id, days);
    const std = c.grams / STANDARD_DRINK_GRAMS;
    return sendHtml(
      ctx,
      fmt(S.commands.stats_private, { day_count: c.dayCount, grams: num(c.grams, 1), standard_drinks: num(std, 1), avg: num(std / c.dayCount, 1) }),
    );
  }
  const g = ctx.kili.services.stats.group(ctx.chat!.id, metric, days);
  const std = g.grams / STANDARD_DRINK_GRAMS;
  const list = g.top
    .map((t) => `${escapeHtml(t.name)} - ${metric === "count" ? t.value : roundTo(t.value / STANDARD_DRINK_GRAMS, 0)}`)
    .join("\n");
  return sendHtml(
    ctx,
    fmt(S.commands.stats_group, {
      day_count: g.dayCount,
      grams: num(g.grams, 1),
      standard_drinks: num(std, 1),
      avg: num(std / g.dayCount, 1),
      global:
        metric === "count" ? `${g.globalCount} juomaa` : `${roundTo(g.globalGrams / STANDARD_DRINK_GRAMS, 0)} annosta`,
      unit: metric === "count" ? "juomina" : "annoksina",
      list: raw(list || S.commands.nobody),
    }),
  );
}

/** /kuvaaja: the group's (or your own) estimated permilles as a chart image. */
async function chart(ctx: BotContext, p: Profile | null) {
  const { services } = ctx.kili;
  const now = services.deps.now();
  let series: ChartSeries[];
  let name: string;
  if (isPrivate(ctx)) {
    if (!p) return sendHtml(ctx, S.user404);
    series = [{ id: p.id, name: p.fullName ?? p.name, body: p, drinks: services.drinks.since(p.id, now - EBAC_WINDOW_MS) }];
    name = p.name;
  } else {
    series = services.groups.memberHistories(ctx.chat!.id).map((m) => ({ id: m.userId, name: m.fullName ?? m.name, body: m.body, drinks: m.drinks }));
    name = chatTitle(ctx);
  }
  const title = fmt(S.commands.kuvaaja_title, { name });
  const result = buildPermilleChart({ title: name ? `Promillekuvaaja feat. ${name}` : "Promillekuvaaja", series, now });
  if (!result) return sendHtml(ctx, S.commands.kuvaaja_empty);
  await ctx.replyWithPhoto(new InputFile(svgToPng(result.svg), "kuvaaja.png"), { caption: title, parse_mode: "HTML" });
}

export const COMMANDS: CommandDef[] = [
  {
    name: "start",
    description: "Bläkkiskili-valikko",
    scope: "private",
    needsUser: false,
    // Deep links from inline-mode buttons: /start juo, /start tunnus
    run: async (ctx, p, args) => {
      if (args === "juo" && p) return sendView(ctx, juoView(ctx, p));
      if (args === "tunnus" && ctx.kili.identityId) {
        ctx.kili.services.pending.set(ctx.kili.identityId, { kind: "register", step: "weight" });
        return sendView(ctx, registerView(S.register.on_select));
      }
      return sendView(ctx, startView(ctx));
    },
  },
  {
    name: "promillet",
    description: "näytä sinun tai ryhmän promillet",
    scope: "all",
    needsUser: false,
    run: (ctx, p) => (isPrivate(ctx) ? (p ? personalSummary(ctx, p) : sendHtml(ctx, S.user404)) : groupListing(ctx, "permilles")),
  },
  {
    name: "annokset",
    description: "näytä ryhmän veressä olevat annokset",
    scope: "all",
    needsUser: false,
    run: (ctx, p) => (isPrivate(ctx) ? (p ? personalSummary(ctx, p) : sendHtml(ctx, S.user404)) : groupListing(ctx, "standardDrinks")),
  },
  { name: "kuvaaja", description: "promillekuvaaja: 24 h + ennuste", scope: "all", needsUser: false, run: (ctx, p) => chart(ctx, p) },
  { name: "moro", description: "liity ryhmän listauksiin", scope: "group", needsUser: true, run: async (ctx, p) => {
      ctx.kili.services.groups.join(p!.id, ctx.chat!.id);
      await sendHtml(ctx, fmt(S.commands.moro, { chat_title: chatTitle(ctx) }));
    } },
  { name: "poistu", description: "poistu ryhmän listauksista", scope: "group", needsUser: true, run: async (ctx, p) => {
      ctx.kili.services.groups.leave(p!.id, ctx.chat!.id);
      await sendHtml(ctx, fmt(S.commands.poistu, { chat_title: chatTitle(ctx) }));
    } },
  { name: "stats", description: "kulutustilastot juomina, esim. /stats 7", scope: "all", needsUser: false, run: (ctx, p, a) => stats(ctx, p, a, "count") },
  { name: "stats2", description: "kulutustilastot annoksina, esim. /stats2 7", scope: "all", needsUser: false, run: (ctx, p, a) => stats(ctx, p, a, "grams") },
  { name: "juoma", description: "lisää juoma", scope: "private", needsUser: true, run: (ctx, p) => sendView(ctx, juoView(ctx, p!)) },
  { name: "kalja033", description: "pikanäppäin 0.33l 4.7% oluelle", scope: "private", needsUser: true, run: (ctx, p) => drinkShortcut(ctx, p!, KALJA033) },
  { name: "kalja05", description: "pikanäppäin 0.5l 4.7% oluelle", scope: "private", needsUser: true, run: (ctx, p) => drinkShortcut(ctx, p!, KALJA05) },
  { name: "jalkikellotus", description: "kellota unohtuneet juomat", scope: "private", needsUser: true, run: async (ctx, p) => {
      ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "late", drinks: [] });
      await sendView(ctx, lateView(S.juo.late.on_select));
    } },
  { name: "laatta", description: "poista viimeisin juoma", scope: "private", needsUser: true, run: async (ctx) => sendView(ctx, await renderNode(ctx, "ju")) },
  { name: "tunnus", description: "luo tai päivitä tunnus", scope: "private", needsUser: false, run: async (ctx) => {
      ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "register", step: "weight" });
      await sendView(ctx, registerView(S.register.on_select));
    } },
  { name: "tuo", description: "tuo tiedot vanhasta Bläkkisvuohesta", scope: "private", needsUser: false, run: (ctx) => sendView(ctx, importIntro(ctx)) },
  { name: "data", description: "lataa omat tietosi", scope: "private", needsUser: false, run: (ctx) => sendExport(ctx, ctx.from!.id) },
  { name: "yhdista", description: "yhdistä tunnus toisesta palvelusta koodilla", scope: "private", needsUser: false,
    enabled: (c) => c.accountLinking, run: (ctx, _p, args) => redeemLinkCode(ctx, args) },
  { name: "whoami", description: "näytä omat tietosi", scope: "private", needsUser: true, run: (ctx, p) =>
      sendHtml(ctx, fmt(S.commands.whoami, { name: p!.name, weight: p!.weight, height: p!.height, gender: p!.gender === "mies" ? S.male : S.female, created: dateTime(p!.createdAt) })) },
  { name: "help", description: "ohjeet", scope: "all", needsUser: false, run: (ctx) => sendHtml(ctx, S.commands.help) },
  { name: "komennot", description: "kaikki komennot", scope: "all", needsUser: false, run: (ctx) =>
      sendHtml(ctx, "<b>Komennot</b>\n\n" + COMMANDS.filter((c) => !c.name.startsWith("admin") && isEnabled(c, ctx.kili.config)).map((c) => `/${c.name} - ${escapeHtml(c.description)}`).join("\n")) },
  { name: "terms", description: "käyttöehdot", scope: "all", needsUser: false, run: (ctx) => sendHtml(ctx, termsHtml(ctx.kili.config)) },
  { name: "about", description: "tietoa botista", scope: "all", needsUser: false, run: (ctx) => sendHtml(ctx, fmt(S.about, contactExtras(ctx.kili.config))) },
  { name: "admin_stats", description: "botin tilastot (admin)", scope: "private", needsUser: false, run: async (ctx) => {
      if (!ctx.from || !ctx.kili.config.adminIds.includes(ctx.from.id)) return sendHtml(ctx, S.unauthorized);
      const g = ctx.kili.services.stats.global();
      return sendHtml(ctx, fmt(S.commands.admin_stats, {
        users: g.users, active14: g.activeUsers14, active7: g.activeUsers7,
        groups: g.groups, groups14: g.activeGroups14, groups7: g.activeGroups7, drinks: g.drinks,
        list: g.top.map((t) => `${t.name} - ${t.value}`).join("\n"),
      }));
    } },
];

export function registerCommands(bot: Bot<BotContext>) {
  for (const def of COMMANDS) {
    bot.command(def.name, async (ctx) => {
      if (!isEnabled(def, ctx.kili.config)) return ctx.chat?.type === "private" ? sendHtml(ctx, S.unknown_text) : undefined;
      const priv = isPrivate(ctx);
      if (def.scope === "private" && !priv) return sendHtml(ctx, S.use_only_in_private);
      if (def.scope === "group" && priv) return sendHtml(ctx, S.use_only_in_chats);

      const { identityId, services } = ctx.kili;
      // A command abandons whatever typed-input flow was in progress.
      if (priv && identityId) services.pending.clear(identityId);

      if (!priv && ctx.chat) {
        const adopted = services.groups.adoptLegacyMembers(ctx.chat.id);
        if (adopted > 0) await sendHtml(ctx, fmt(S.commands.adopted, { count: adopted }));
      }

      const profile = ctx.kili.profile;
      if (def.needsUser && !profile) return sendHtml(ctx, priv ? S.user404 : S.user404_group);
      if (def.needsUser && profile && !profile.acceptedTerms) return sendHtml(ctx, S.terms_required);
      await def.run(ctx, profile, typeof ctx.match === "string" ? ctx.match : "");
    });
  }
}

const isEnabled = (def: CommandDef, config: Config) => def.enabled?.(config) ?? true;

/** /yhdista KOODI: links this Telegram login to an account made on another platform. */
async function redeemLinkCode(ctx: BotContext, args: string) {
  const { services } = ctx.kili;
  const t = S.commands.yhdista;
  if (!args.trim() || !ctx.from) return sendHtml(ctx, t.usage);
  const r = services.identities.redeemLinkCode(args, { platform: "telegram", platformUserId: ctx.from.id });
  if (!r.ok) return sendHtml(ctx, t[r.reason]);
  const profile = services.accounts.get(r.accountId)!;
  ctx.kili.profile = profile;
  return sendHtml(ctx, fmt(t.done, { name: profile.name }));
}

/** Commands shown in Telegram's "/" menu. */
export function commandMenus(config: Config) {
  const toMenu = (scopes: Scope[]) =>
    COMMANDS.filter((c) => scopes.includes(c.scope) && !c.name.startsWith("admin") && isEnabled(c, config)).map((c) => ({
      command: c.name,
      description: c.description,
    }));
  return { private: toMenu(["private", "all"]), group: toMenu(["group", "all"]) };
}
