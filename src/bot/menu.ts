// The /start inline menu, ported from the original v4 menu tree (app/commands/start*.js).
// Each node is addressed by a short id in callback data ("m:<node>[:<arg>]") and renders a
// View. Nodes that expect typed input set a Pending state; any other navigation clears it.

import type { BotContext } from "./context.ts";
import { contactExtras, displayName, fullName, retentionText, termsHtml } from "./context.ts";
import { back, btn, editView, sendExport, type View } from "./ui.ts";
import { PLATFORM_NAMES, S, randomDrinkResponse } from "../strings.ts";
import { formatLinkCode, LINK_CODE_TTL_MS } from "../services/identities.ts";
import { isPlatform } from "../lib/ids.ts";
import { normalizeEan } from "../lib/ean.ts";
import { CATALOG, findPreset, type DrinkCategory } from "../lib/catalog.ts";
import { dateTime, drinkList, fmt, hoursMinutes, num, raw } from "../lib/format.ts";
import { alcoholMgFromClPercent, DAY_MS, HOUR_MS, MINUTE_MS, roundTo, STANDARD_DRINK_GRAMS } from "../lib/units.ts";
import type { Profile } from "../services/accounts.ts";
import type { Gender } from "../lib/alcomath.ts";
import type { InlineKeyboardButton } from "grammy/types";
import {
  cl,
  customServing,
  emojiFor,
  euros,
  packCount,
  pricePerStandardDrink,
  resolveServing,
  servingDescription,
  splitAmount,
  standardDrinksText,
  type CatalogDrink,
  type Serving,
} from "../lib/servings.ts";
import type { Energy } from "../services/drinks.ts";

type Handler = (ctx: BotContext, arg: string | undefined) => View | Promise<View>;

const genderLabel = (g: Gender) => (g === "mies" ? S.male : S.female);

// ---------- shared view pieces ----------

function header(title: string, profile?: Profile | null, ctx?: BotContext): string {
  let h = fmt(S.header, { title });
  if (profile && ctx) {
    const e = ctx.kili.services.drinks.ebacFor(profile);
    h += fmt(S.header_permilles, { permilles: num(e.permilles), permilles30Min: num(e.permilles30Min) });
  }
  return h;
}

/** "1 450": rounded to 10 kcal, since it's an estimate. */
const kcalText = (kcal: number) => (Math.round(kcal / 10) * 10).toLocaleString("fi-FI");

/** S.energy.unknown when some drinks have no energy data. */
const unknownEnergy = (e: Energy) => raw(e.unknown > 0 ? fmt(S.energy.unknown, { count: e.unknown }) : "");

/** "Tämän illan juomissa on noin 640 kcal." for the ongoing session, or "" (none, or no data). */
export function sessionEnergyText(ctx: BotContext, profile: Profile): string {
  const e = ctx.kili.services.drinks.sessionEnergy(profile.id);
  if (!e || e.kcal <= 0) return "";
  return fmt(S.energy.session, { kcal: kcalText(e.kcal), unknown: unknownEnergy(e) });
}

/** The "drink saved" confirmation, with the evening's energy. */
export function drankText(ctx: BotContext, profile: Profile, description: string): string {
  const energy = sessionEnergyText(ctx, profile);
  return fmt(S.juo.on_drink, {
    drink_response: randomDrinkResponse(),
    drink: description,
    energy: raw(energy ? "\n" + energy : ""),
  });
}

export function shortPermilles(ctx: BotContext, profile: Profile): string {
  const e = ctx.kili.services.drinks.ebacFor(profile);
  return fmt(S.short_permilles, { permilles: num(e.permilles), permilles30Min: num(e.permilles30Min) });
}

// ---------- root ----------

export function startView(ctx: BotContext, notice = ""): View {
  const p = ctx.kili.profile;
  const prefix = notice ? notice + "\n\n" : "";
  if (!p) {
    return {
      text: header(S.start.title) + prefix + S.start.on_select_nonuser,
      keyboard: [
        [btn(S.register.button, "r"), btn(S.import.button, "i")],
        [btn(S.help.button, "h")],
      ],
    };
  }
  const { drinks } = ctx.kili.services;
  const e = drinks.ebacFor(p);
  const recent = drinks.since(p.id, ctx.kili.services.deps.now() - 3 * HOUR_MS);
  const hm = hoursMinutes(e.burnHours);
  const energy = sessionEnergyText(ctx, p);
  return {
    text:
      header(S.start.title, p, ctx) +
      prefix +
      fmt(S.start.on_select, {
        grams: roundTo(e.grams, 0),
        standard_drinks: num(e.grams / STANDARD_DRINK_GRAMS),
        hours: hm.hours,
        minutes: hm.minutes,
        energy: raw(energy ? " " + energy : ""),
        drink_list: raw(recent.length ? fmt(S.start.drinks3h, { list: raw(drinkList(recent)) }) : ""),
      }),
    keyboard: [
      [btn(S.juo.button, "j"), btn(S.tilastoja.button, "t")],
      [btn(S.asetukset.button, "a"), btn(S.help.button, "h")],
    ],
  };
}

// ---------- Juo ----------

export function juoView(ctx: BotContext, profile: Profile, body: string = S.juo.on_select): View {
  const { drinks } = ctx.kili.services;
  const lastHour = drinks.since(profile.id, ctx.kili.services.deps.now() - HOUR_MS);
  const latest = drinks.recentUnique(profile.id, 2, S.juo.late.drink_name);
  const cat = (c: DrinkCategory["id"]) => btn(S.juo[c].button, `jc:${c}`);
  return {
    text:
      header(S.juo.title, profile, ctx) +
      (lastHour.length ? fmt(S.juo.drinks1h, { list: raw(drinkList(lastHour)) }) : "") +
      body,
    keyboard: [
      ...(ctx.kili.services.products.ready ? [[searchButton(ctx)]] : []),
      [cat("miedot"), cat("viinit"), cat("shotit")],
      [btn(S.juo.oma.button, "jo"), btn(S.juo.late.button, "jk"), btn(S.juo.undo.button, "ju")],
      ...latest.map((d) => [btn(d.description, `jl:${d.id}`)]),
      back("s"),
    ],
  };
}

/**
 * With inline mode enabled in BotFather, the button opens as-you-type search in the message
 * field ("@bot karhu"); otherwise it starts the typed search in the menu.
 */
function searchButton(ctx: BotContext): InlineKeyboardButton {
  return ctx.me?.supports_inline_queries
    ? { text: S.search.button, switch_inline_query_current_chat: "" }
    : btn(S.search.button, "jh");
}

// ---------- Product search (Alkometriikka) ----------

/** "🍺 Karjala · 50 cl" (one serving or a typed amount) or "🥃 Jaloviina *** · 38 %". */
function productButtonText(d: CatalogDrink, amount?: Serving): string {
  const one = amount ?? (d.servings.length === 1 ? d.servings[0] : undefined);
  return `${emojiFor(d.product)} ${d.name} · ${one ? one.label : `${d.product.abv} %`}`;
}

export const servingButtonText = (s: Serving) =>
  [s.label, standardDrinksText(s), s.kcal === null ? null : `${s.kcal} kcal`].filter(Boolean).join(" · ");

/**
 * Search results. With an amount at the end of the query ("jallu 3 cl") every result logs
 * that amount with one tap; otherwise a tap opens the product to pick the amount.
 */
export function searchResultsView(ctx: BotContext, profile: Profile, text: string): View {
  const { products, drinks } = ctx.kili.services;
  const { query, litres } = splitAmount(text);
  const results = products.search(query, 8, drinks.recentProductIds(profile.id, 10));
  const rows = results.flatMap((d) => {
    if (litres === undefined) return [[btn(productButtonText(d), `p:${d.id}`)]];
    const r = customServing(d, litres);
    return "serving" in r ? [[btn(productButtonText(d, r.serving), `ps:${d.id}:${r.serving.key}`)]] : [];
  });
  const shown = litres === undefined ? query : `${query} (${cl(litres)} cl)`;
  const body = fmt(rows.length ? S.search.results : litres !== undefined && results.length ? S.search.custom_too_much : S.search.none, { q: shown });
  return { text: header(S.search.title) + body, keyboard: [...rows, back("j")] };
}

/** Logs a catalogue serving and returns the description that was stored. */
export function logServing(ctx: BotContext, profile: Profile, drink: CatalogDrink, serving: Serving): string {
  const description = servingDescription(drink, serving);
  ctx.kili.services.drinks.add(profile.id, serving.mg, description, { productId: serving.productId, kcal: serving.kcal });
  return description;
}

const goneView = (): View => ({
  text: header(S.search.title) + S.search.gone,
  keyboard: [[btn(S.search.button, "jh")], back("j")],
});

/** A product: one button per usual serving, plus a custom amount. */
export function productView(ctx: BotContext, drinkId: string, notice = ""): View {
  const { products } = ctx.kili.services;
  const drink = products.get(drinkId);
  if (!drink) return goneView();
  return {
    text:
      header(S.search.title) +
      (notice ? notice + "\n\n" : "") +
      fmt(S.search.product, { name: `${emojiFor(drink.product)} ${drink.name}`, details: raw(productDetails(ctx, drink)) }),
    keyboard: [
      ...drink.servings.map((sv) => [btn(servingButtonText(sv), `ps:${drink.id}:${sv.key}`)]),
      [btn(S.search.custom_button, `pc:${drink.id}`)],
      [btn(S.search.more, "jh")],
      back("j"),
    ],
  };
}

// ---------- Barcodes ----------

/** What a scanned or typed barcode leads to: its product, or why there isn't one. */
export async function barcodeView(ctx: BotContext, input: string): Promise<View> {
  const { barcodes, products } = ctx.kili.services;
  const ean = normalizeEan(input);
  const message = (text: string): View => ({ text: header(S.barcode.title) + text, keyboard: [[btn(S.search.button, "jh")], back("j")] });
  if (!ean) return message(S.barcode.invalid);

  // Alkometriikka's catalogue knows the barcodes it has seen; the API Worker asks Alko for the rest.
  let productId = products.productIdByEan(ean) ?? null;
  if (!productId) {
    const hit = await barcodes.resolve(ean);
    if (!hit.ok) return message(fmt(hit.reason === "rate-limited" ? S.barcode.rate_limited : S.barcode.unavailable, { ean }));
    productId = hit.productId;
  }
  if (!productId) return message(fmt(S.barcode.unknown, { ean }));
  if (products.get(productId)) return productView(ctx, productId, fmt(S.barcode.found, { ean }));
  const skipped = products.notDrinkable(productId);
  if (skipped) return message(fmt(S.barcode.alcohol_free, { ean, name: skipped.name }));
  return message(fmt(S.barcode.gone, { ean }));
}

export function customAmountView(drink: CatalogDrink, error = ""): View {
  return {
    text:
      header(S.search.title) +
      (error ? error + "\n\n" : "") +
      fmt(S.search.custom_prompt, { name: `${emojiFor(drink.product)} ${drink.name}`, abv: drink.product.abv }),
    keyboard: [back(`p:${drink.id}`)],
  };
}

/** "50 cl", "6 × 33 cl", "3 l" */
function packageText(p: CatalogDrink["product"]): string {
  const n = packCount(p.name);
  if (n > 1) return `${n} × ${cl(p.sizeL / n)} cl`;
  return p.sizeL >= 1 ? `${roundTo(p.sizeL, 2)} l` : `${cl(p.sizeL)} cl`;
}

/**
 * Lines under the product name (HTML): maker, country and ABV; energy and the representative
 * package's Alko price; a link to the product on Alkometriikka.
 */
function productDetails(ctx: BotContext, d: CatalogDrink): string {
  const p = d.product;
  const lines = [fmt("{x}", { x: [p.maker, p.country, `${p.abv} %`].filter(Boolean).join(" · ") })];
  const perDrink = pricePerStandardDrink(p);
  const facts = [
    p.kcal100 === null ? null : `${p.kcal100} kcal / 100 ml`,
    p.price === null ? null : fmt(S.search.price, { price: euros(p.price), size: packageText(p) }),
    perDrink === null ? null : fmt(S.search.per_standard_drink, { price: euros(perDrink) }),
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(" · "));
  const url = ctx.kili.services.products.pageUrl(p.id);
  if (url) lines.push(fmt('<a href="{url}">{text}</a>', { url, text: S.search.product_link }));
  return lines.join("\n");
}

function drankView(ctx: BotContext, profile: Profile, drinkName: string): View {
  return juoView(ctx, profile, drankText(ctx, profile, drinkName));
}

function categoryView(category: DrinkCategory): View {
  const buttons = category.presets.map((p) => btn(p.name, `d:${p.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return {
    text: header(S.juo[category.id].title) + S.juo[category.id].on_select,
    keyboard: [...rows, back("j")],
  };
}

export function customDrinkView(body: string = fmt(S.juo.oma.on_select, { help: raw(S.juo.oma.help) })): View {
  return { text: header(S.juo.oma.title) + body, keyboard: [back("j")] };
}

export function lateView(body: string, canSave = false): View {
  return {
    text: header(S.juo.late.title) + body,
    keyboard: [...(canSave ? [[btn(S.juo.late.save, "jks")]] : []), back("j")],
  };
}

// ---------- Tilastoja ----------

export function consumptionView(ctx: BotContext, profile: Profile, days?: number): View {
  const c = ctx.kili.services.drinks.consumption(profile.id, days);
  const std = c.grams / STANDARD_DRINK_GRAMS;
  const text =
    fmt(S.tilastoja.kulutus.text, {
      day_count: c.dayCount,
      grams: num(c.grams, 1),
      standard_drinks: num(std, 1),
      avg: num(std / c.dayCount, 1),
    }) +
    (c.energy.kcal > 0
      ? fmt(S.tilastoja.kulutus.energy, { kcal: kcalText(c.energy.kcal), unknown: unknownEnergy(c.energy) })
      : "") +
    S.tilastoja.kulutus.hint;
  const d = (n: number) => btn(S.tilastoja.kulutus.days(n), `tk:${n}`);
  return {
    text: header(S.tilastoja.title) + text,
    keyboard: [[d(7), d(14)], [d(30), d(60)], back("t")],
  };
}

// ---------- Asetukset ----------

function profileView(profile: Profile, notice = ""): View {
  const m = S.asetukset.muokkaa;
  return {
    text:
      header(S.asetukset.title) +
      (notice ? notice + "\n\n" : "") +
      fmt(m.on_select, {
        name: profile.name,
        weight: profile.weight,
        height: profile.height,
        gender: genderLabel(profile.gender),
        created: dateTime(profile.createdAt),
      }),
    keyboard: [
      [btn(m.paino.button, "amw"), btn(m.pituus.button, "amh")],
      [btn(m.sukupuoli.button, "amg"), btn(S.asetukset.paivita.button, "amn")],
      back("a"),
    ],
  };
}

export function profileViewFor(ctx: BotContext, notice = ""): View {
  const p = ctx.kili.profile ? ctx.kili.services.accounts.get(ctx.kili.profile.id) : null;
  return p ? profileView(p, notice) : startView(ctx);
}

function settingsView(ctx: BotContext, notice = ""): View {
  return {
    text: header(S.asetukset.title) + (notice ? notice + "\n\n" : "") + S.asetukset.on_select,
    keyboard: [
      [btn(S.asetukset.muokkaa.button, "am")],
      ...(ctx.kili.config.accountLinking ? [[btn(S.asetukset.linkit.button, "al")]] : []),
      [btn(S.asetukset.data.button, "ax")],
      [btn(S.asetukset.poista.button, "ad")],
      back("s"),
    ],
  };
}

/** Platforms linked to the account; this one (Telegram) can't be unlinked from here. */
function linksView(ctx: BotContext, p: Profile, notice = ""): View {
  const ids = ctx.kili.services.identities.list(p.id);
  const list = ids
    .map((i) =>
      fmt(i.id === ctx.kili.identityId ? S.asetukset.linkit.item_current : S.asetukset.linkit.item, {
        platform: PLATFORM_NAMES[i.platform],
      }),
    )
    .join("\n");
  const unlink = ids
    .filter((i) => i.id !== ctx.kili.identityId)
    .map((i) => [btn(fmt(S.asetukset.linkit.unlink, { platform: PLATFORM_NAMES[i.platform] }), `alu:${i.platform}`)]);
  return {
    text: header(S.asetukset.title) + (notice ? notice + "\n\n" : "") + fmt(S.asetukset.linkit.on_select, { list: raw(list) }),
    keyboard: [[btn(S.asetukset.linkit.create, "alc")], ...unlink, back("a")],
  };
}

// ---------- Registration ----------

export function registerView(body: string, keyboard: View["keyboard"] = [back("s")]): View {
  return { text: header(S.register.title) + body, keyboard };
}

export const genderKeyboard = (prefix: string) => [[btn(S.male, `${prefix}:m`), btn(S.female, `${prefix}:f`)]];

export function registerTermsView(ctx: BotContext): View {
  return registerView(fmt(S.register.terms, { terms: raw(termsHtml(ctx.kili.config)) }), [
    [btn(S.yes, "r:t:y"), btn(S.no, "r:t:n")],
  ]);
}

// ---------- Help ----------

const textNode = (title: string, text: string, parent: string): View => ({
  text: header(title) + text,
  keyboard: [back(parent)],
});

// ---------- node table ----------

/** Nodes that continue the current pending flow instead of cancelling it. */
const KEEPS_PENDING = new Set(["jks", "r:g", "r:t", "i:y"]);

const withProfile =
  (h: (ctx: BotContext, p: Profile, arg: string | undefined) => View | Promise<View>): Handler =>
  (ctx, arg) => {
    const p = ctx.kili.profile;
    return p ? h(ctx, p, arg) : startView(ctx, S.user404);
  };

const NODES: Record<string, Handler> = {
  s: (ctx) => startView(ctx),

  // Juo
  j: withProfile((ctx, p) => juoView(ctx, p)),
  jc: withProfile((ctx, p, arg) => {
    const c = CATALOG.find((x) => x.id === arg);
    return c ? categoryView(c) : juoView(ctx, p);
  }),
  d: withProfile((ctx, p, arg) => {
    const preset = findPreset(arg ?? "");
    if (!preset) return juoView(ctx, p);
    ctx.kili.services.drinks.add(p.id, preset.mg, preset.name, { kcal: preset.kcal });
    return drankView(ctx, p, preset.name);
  }),
  jl: withProfile((ctx, p, arg) => {
    const source = ctx.kili.services.drinks.get(p.id, Number(arg));
    if (!source) return juoView(ctx, p);
    ctx.kili.services.drinks.add(p.id, source.alcoholMg, source.description, { productId: source.productId, kcal: source.kcal });
    return drankView(ctx, p, source.description);
  }),
  jh: withProfile((ctx, p) => {
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "productSearch" });
    return { text: header(S.search.title) + S.search.prompt, keyboard: [back("j")] };
  }),
  p: withProfile((ctx, p, arg) => productView(ctx, arg ?? "")),
  ps: withProfile((ctx, p, arg) => {
    const [drinkId, key] = (arg ?? "").split(":");
    const drink = ctx.kili.services.products.get(drinkId ?? "");
    const serving = drink && resolveServing(drink, key ?? "");
    if (!drink || !serving) return goneView();
    return drankView(ctx, p, logServing(ctx, p, drink, serving));
  }),
  // ✏️ Muu määrä: the next message is the amount
  pc: withProfile((ctx, p, arg) => {
    const drink = ctx.kili.services.products.get(arg ?? "");
    if (!drink) return goneView();
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "productAmount", drinkId: drink.id });
    return customAmountView(drink);
  }),
  jo: withProfile((ctx, p) => {
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "customDrink" });
    return customDrinkView();
  }),
  jk: withProfile((ctx, p) => {
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "late", drinks: [] });
    return lateView(S.juo.late.on_select);
  }),
  jks: withProfile((ctx, p) => {
    const { pending, drinks } = ctx.kili.services;
    const state = pending.get(ctx.kili.identityId!);
    pending.clear(ctx.kili.identityId!);
    if (state?.kind !== "late" || state.hours === undefined || state.drinks.length === 0) {
      return lateView(S.juo.late.nothing_to_save);
    }
    drinks.addLate(
      p.id,
      state.drinks.map((d) => ({
        description: `${S.juo.late.drink_name} ${d.cl}cl ${d.vol}%`,
        mg: alcoholMgFromClPercent(d.cl, d.vol),
      })),
      state.hours,
    );
    return juoView(
      ctx,
      p,
      fmt(S.juo.late.saved, {
        drink_response: randomDrinkResponse(),
        count: state.drinks.length,
        short: raw(shortPermilles(ctx, p)),
      }),
    );
  }),
  ju: withProfile((ctx, p) => {
    const last = ctx.kili.services.drinks.last(p.id);
    if (!last) return { text: header(S.juo.undo.title) + S.juo.undo.no_drinks, keyboard: [back("j")] };
    return {
      text: header(S.juo.undo.title) + fmt(S.juo.undo.on_select, { name: last.description, created: dateTime(last.createdAt) }),
      keyboard: [[btn(S.yes, `juy:${last.id}`)], back("j")],
    };
  }),
  juy: withProfile((ctx, p, arg) => {
    const { drinks } = ctx.kili.services;
    const last = drinks.last(p.id);
    // Only undo the drink that was shown in the confirmation.
    if (!last || String(last.id) !== arg) return juoView(ctx, p, S.juo.undo.no_drinks);
    drinks.undoLast(p.id);
    const e = drinks.ebacFor(p);
    return juoView(ctx, p, fmt(S.juo.undo.success, { permilles: num(e.permilles), permilles30Min: num(e.permilles30Min) }));
  }),

  // Tilastoja
  t: withProfile(() => ({
    text: header(S.tilastoja.title) + S.tilastoja.on_select,
    keyboard: [[btn(S.tilastoja.kulutus.button, "tk"), btn(S.tilastoja.otinko.button, "to")], back("s")],
  })),
  tk: withProfile((ctx, p, arg) => {
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "consumptionDays" });
    const days = arg ? Number(arg) : undefined;
    return consumptionView(ctx, p, days && days > 0 ? days : undefined);
  }),
  to: withProfile((ctx, p) => {
    const list = ctx.kili.services.drinks.since(p.id, ctx.kili.services.deps.now() - 3 * DAY_MS);
    return {
      text: header(S.tilastoja.title) + fmt(S.tilastoja.otinko.text, { list: raw(drinkList(list, true)) }),
      keyboard: [back("t")],
    };
  }),

  // Asetukset
  a: withProfile((ctx) => settingsView(ctx)),
  am: withProfile((_ctx, p) => profileView(p)),
  amw: withProfile((ctx, p) => {
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "editWeight" });
    return { text: header(S.asetukset.title) + fmt(S.asetukset.muokkaa.paino.on_select, { weight: p.weight }), keyboard: [back("am")] };
  }),
  amh: withProfile((ctx, p) => {
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "editHeight" });
    return { text: header(S.asetukset.title) + fmt(S.asetukset.muokkaa.pituus.on_select, { height: p.height }), keyboard: [back("am")] };
  }),
  amg: withProfile((ctx, p, arg) => {
    if (arg === "m" || arg === "f") {
      ctx.kili.services.accounts.updateGender(p.id, arg === "m" ? "mies" : "nainen");
      return profileViewFor(ctx, S.asetukset.muokkaa.sukupuoli.changed);
    }
    return {
      text: header(S.asetukset.title) + fmt(S.asetukset.muokkaa.sukupuoli.on_select, { gender: genderLabel(p.gender) }),
      keyboard: [...genderKeyboard("amg"), back("am")],
    };
  }),
  amn: withProfile((ctx, p) => {
    const name = ctx.from ? displayName(ctx.from) : p.name;
    ctx.kili.services.accounts.updateName(p.id, name, ctx.from ? fullName(ctx.from) : undefined);
    return profileViewFor(ctx, fmt(S.asetukset.paivita.done, { name }));
  }),
  ax: withProfile(async (ctx) => {
    if (ctx.from) await sendExport(ctx, ctx.from.id);
    return settingsView(ctx);
  }),
  // Yhdistetyt palvelut
  al: withProfile((ctx, p) => (ctx.kili.config.accountLinking ? linksView(ctx, p) : settingsView(ctx))),
  alc: withProfile((ctx, p) => {
    if (!ctx.kili.config.accountLinking) return settingsView(ctx);
    const { code } = ctx.kili.services.identities.createLinkCode(p.id);
    return {
      text:
        header(S.asetukset.title) +
        fmt(S.asetukset.linkit.code, { code: formatLinkCode(code), minutes: LINK_CODE_TTL_MS / MINUTE_MS }),
      keyboard: [back("al")],
    };
  }),
  alu: withProfile((ctx, p, arg) => {
    if (!ctx.kili.config.accountLinking || !arg || !isPlatform(arg)) return settingsView(ctx);
    return {
      text: header(S.asetukset.title) + fmt(S.asetukset.linkit.unlink_confirm, { platform: PLATFORM_NAMES[arg] }),
      keyboard: [[btn(S.yes, `aluy:${arg}`), btn(S.no, "al")]],
    };
  }),
  aluy: withProfile((ctx, p, arg) => {
    if (!ctx.kili.config.accountLinking || !arg || !isPlatform(arg)) return settingsView(ctx);
    // Never the login this message came from: that would lock the user out mid-conversation.
    const current = ctx.kili.services.identities.list(p.id).find((i) => i.id === ctx.kili.identityId);
    if (current?.platform === arg) return linksView(ctx, p);
    const r = ctx.kili.services.identities.unlink(p.id, arg);
    return linksView(ctx, p, r === "ok" ? fmt(S.asetukset.linkit.unlinked, { platform: PLATFORM_NAMES[arg] }) : "");
  }),
  ad: withProfile(() => ({
    text: header(S.asetukset.title) + S.asetukset.poista.on_select,
    keyboard: [[btn(S.yes, "ad1"), btn(S.no, "a")]],
  })),
  ad1: withProfile(() => ({
    text: header(S.asetukset.title) + S.asetukset.poista.double_confirm,
    keyboard: [[btn(S.no, "a"), btn(S.yes, "ad2")]],
  })),
  ad2: withProfile((ctx, p) => {
    ctx.kili.services.accounts.delete(p.id);
    ctx.kili.profile = null;
    return startView(ctx, S.asetukset.poista.deleted);
  }),

  // Registration (also used to update body data)
  r: (ctx) => {
    if (!ctx.kili.identityId) return startView(ctx);
    ctx.kili.services.pending.set(ctx.kili.identityId, { kind: "register", step: "weight" });
    return registerView(S.register.on_select);
  },
  "r:g": (ctx, arg) => {
    const { identityId: userId, services } = ctx.kili;
    const state = userId ? services.pending.get(userId) : null;
    if (!userId || state?.kind !== "register" || state.step !== "gender" || (arg !== "m" && arg !== "f")) {
      return startView(ctx);
    }
    services.pending.set(userId, { ...state, step: "terms", gender: arg === "m" ? "mies" : "nainen" });
    return registerTermsView(ctx);
  },
  "r:t": (ctx, arg) => {
    const { identityId: userId, services } = ctx.kili;
    const state = userId ? services.pending.get(userId) : null;
    if (!userId || !ctx.from || state?.kind !== "register" || state.step !== "terms") return startView(ctx);
    services.pending.clear(userId);
    if (arg !== "y" || !state.weight || !state.height || !state.gender) {
      return registerView(S.register.terms_rejected);
    }
    const name = displayName(ctx.from);
    const { created, profile } = services.accounts.register({ platform: "telegram", platformUserId: ctx.from.id }, {
      name,
      fullName: fullName(ctx.from),
      weight: state.weight,
      height: state.height,
      gender: state.gender,
    });
    ctx.kili.profile = profile;
    return startView(ctx, created ? fmt(S.register.created, { name }) : S.register.updated);
  },

  // Import from the original bot
  i: (ctx) => importIntro(ctx),
  "i:y": (ctx) => {
    const { identityId: userId, services } = ctx.kili;
    if (!userId) return startView(ctx);
    services.pending.set(userId, { kind: "import", step: "files" });
    return { text: header(S.import.title) + S.import.send_files, keyboard: [back("s")] };
  },

  // Help
  h: () => ({
    text: header(S.help.title) + S.help.on_select,
    keyboard: [
      [btn(S.help.general.button, "hg"), btn(S.help.faq.button, "hf"), btn(S.help.privacy.button, "hp")],
      back("s"),
    ],
  }),
  hg: () => textNode(S.help.general.title, S.help.general.text, "h"),
  hp: (ctx) =>
    textNode(
      S.help.privacy.title,
      fmt(S.help.privacy.text, { ...contactExtras(ctx.kili.config), retention: retentionText(ctx.kili.config) }),
      "h",
    ),
  hf: () => ({
    text: header(S.help.faq.title) + S.help.faq.on_select,
    keyboard: [
      [btn(S.help.faq.juominen.button, "hfj"), btn(S.help.faq.ryhmat.button, "hfr"), btn(S.help.faq.koodi.button, "hfk")],
      back("h"),
    ],
  }),
  hfj: () => textNode(S.help.faq.juominen.title, S.help.faq.juominen.text, "hf"),
  hfr: () => textNode(S.help.faq.ryhmat.title, S.help.faq.ryhmat.text, "hf"),
  hfk: (ctx) => textNode(S.help.faq.koodi.title, fmt(S.help.faq.koodi.text, contactExtras(ctx.kili.config)), "hf"),
};

export function importIntro(ctx: BotContext): View {
  const { identityId: userId, services } = ctx.kili;
  if (userId) services.pending.set(userId, { kind: "import", step: "terms" });
  return {
    text: header(S.import.title) + fmt(S.import.intro, { terms: raw(termsHtml(ctx.kili.config)) }),
    keyboard: [[btn(S.yes, "i:y"), btn(S.no, "s")]],
  };
}

/** Splits "r:g:m" into node "r:g" + arg "m", and "d:b33a" into "d" + "b33a". */
function route(data: string): { node: string; arg?: string } {
  const parts = data.split(":");
  if (parts.length >= 2 && NODES[`${parts[0]}:${parts[1]}`]) {
    return { node: `${parts[0]}:${parts[1]}`, arg: parts.slice(2).join(":") || undefined };
  }
  return { node: parts[0]!, arg: parts.slice(1).join(":") || undefined };
}

/** Renders a node without editing anything (used by commands that open a menu). */
export async function renderNode(ctx: BotContext, data: string): Promise<View> {
  const { node, arg } = route(data);
  return (NODES[node] ?? NODES.s!)(ctx, arg);
}

export async function handleMenuCallback(ctx: BotContext, data: string) {
  const { node, arg } = route(data);
  const handler = NODES[node] ?? NODES.s!;
  const { identityId: userId, services } = ctx.kili;
  if (userId && !KEEPS_PENDING.has(node)) services.pending.clear(userId);
  await editView(ctx, await handler(ctx, arg));
}

