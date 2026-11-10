// The /start inline menu, ported from the original v4 menu tree (app/commands/start*.js).
// Each node is addressed by a short id in callback data ("m:<node>[:<arg>]") and renders a
// View. Nodes that expect typed input set a Pending state; any other navigation clears it.
// Copyright (C) 2017 Joonas Ulmanen, GPL-3.0-or-later; ported and modified November 2026.

import type { BotContext } from "./context.ts";
import { contactExtras, displayName, fullName, isAdmin, retentionText, termsHtml, webPrivacyText } from "./context.ts";
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
  CUSTOM_KINDS,
  customCatalogDrink,
  customDrinkId,
  customServing,
  eanOfCustomDrinkId,
  isAlkoProductId,
  isCustomKind,
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
import type { CustomProduct } from "../services/customproducts.ts";

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
  // drinks.product_id is an Alko product number; user-added products have none.
  const productId = isAlkoProductId(serving.productId) ? serving.productId : null;
  ctx.kili.services.drinks.add(profile.id, serving.mg, description, { productId, kcal: serving.kcal });
  return description;
}

/** A drink by id: an Alko product from the catalogue, or a user-added barcode product ("e<ean>"). */
export function findDrink(ctx: BotContext, id: string): CatalogDrink | undefined {
  const ean = eanOfCustomDrinkId(id);
  if (!ean) return ctx.kili.services.products.get(id);
  const custom = ctx.kili.services.customProducts.get(ean);
  return custom ? customCatalogDrink(custom) : undefined;
}

const goneView = (): View => ({
  text: header(S.search.title) + S.search.gone,
  keyboard: [[btn(S.search.button, "jh")], back("j")],
});

/** A product: one button per usual serving, plus a custom amount. */
export function productView(ctx: BotContext, drinkId: string, notice = ""): View {
  const drink = findDrink(ctx, drinkId);
  if (!drink) return goneView();
  const ean = eanOfCustomDrinkId(drink.id);
  const custom = ean ? ctx.kili.services.customProducts.get(ean) : null;
  const editable = custom && canEditCustom(ctx, custom);
  return {
    text:
      header(S.search.title) +
      (notice ? notice + "\n\n" : "") +
      fmt(S.search.product, {
        name: `${emojiFor(drink.product)} ${drink.name}`,
        details: raw(custom ? customDetails(custom) : productDetails(ctx, drink)),
      }),
    keyboard: [
      ...drink.servings.map((sv) => [btn(servingButtonText(sv), `ps:${drink.id}:${sv.key}`)]),
      [btn(S.search.custom_button, `pc:${drink.id}`)],
      ...(editable ? [[btn(S.custom.edit_button, `bn:${custom.ean}`), btn(S.custom.delete_button, `bd:${custom.ean}`)]] : []),
      ...(custom && !editable ? [[btn(S.custom.report_button, `br:${custom.ean}`)]] : []),
      [btn(S.search.more, "jh")],
      back("j"),
    ],
  };
}

// ---------- Barcodes ----------

/** What a scanned or typed barcode leads to: its product, or why there isn't one. */
export async function barcodeView(ctx: BotContext, input: string): Promise<View> {
  const { barcodes, products, customProducts } = ctx.kili.services;
  const ean = normalizeEan(input);
  const message = (text: string, canAdd = false): View => ({
    text: header(S.barcode.title) + text,
    keyboard: [...(canAdd && ean ? [[btn(S.custom.add_button, `bn:${ean}`)]] : []), [btn(S.search.button, "jh")], back("j")],
  });
  if (!ean) return message(S.barcode.invalid);

  // Alkometriikka's catalogue knows the barcodes it has seen. Next come the products users have
  // added here, and only then is the API Worker asked (it asks Alko).
  let productId = products.productIdByEan(ean) ?? null;
  if (!productId) {
    if (customProducts.get(ean)) return productView(ctx, customDrinkId(ean), fmt(S.barcode.found_custom, { ean }));
    const hit = await barcodes.resolve(ean);
    if (!hit.ok) return message(fmt(hit.reason === "rate-limited" ? S.barcode.rate_limited : S.barcode.unavailable, { ean }));
    productId = hit.productId;
  }
  if (!productId) return message(fmt(S.barcode.unknown, { ean }), true);
  if (products.get(productId)) return productView(ctx, productId, fmt(S.barcode.found, { ean }));
  const skipped = products.notDrinkable(productId);
  if (skipped) return message(fmt(S.barcode.alcohol_free, { ean, name: skipped.name }));
  // Discontinued at Alko, but maybe still sold elsewhere.
  return message(fmt(S.barcode.gone, { ean }), true);
}

// ---------- User-added barcode products ----------

export const canEditCustom = (ctx: BotContext, p: CustomProduct) =>
  !!ctx.kili.profile && ctx.kili.services.customProducts.canEdit(p, ctx.kili.profile.id, isAdmin(ctx));

/** Lines under a user-added product's name (HTML). */
function customDetails(p: CustomProduct): string {
  const lines = [fmt(S.custom.details, { kind: S.custom.kind_names[p.kind], abv: num(p.abv) })];
  if (p.kcal100 !== null) lines.push(`${num(p.kcal100)} kcal / 100 ml`);
  lines.push(fmt(S.custom.added_by_users, { ean: p.ean }));
  return lines.join("\n");
}

const customHeader = (editing: boolean) => header(editing ? S.custom.title_edit : S.custom.title_add);

/** "Nyt: …" under a prompt when editing an existing product. */
const currentValue = (value: string | null | undefined) => raw(value ? fmt(S.custom.current, { value }) : "");

/** Step 1 of adding (or editing) a product for a barcode: what kind of drink it is. */
function customKindView(ctx: BotContext, ean: string): View {
  const existing = ctx.kili.services.customProducts.get(ean);
  const kind = (k: (typeof CUSTOM_KINDS)[number]) => btn(S.custom.kinds[k], `bk:${ean}:${k}`);
  return {
    text:
      customHeader(!!existing) +
      (existing ? fmt(S.custom.kind_prompt_edit, { ean, name: existing.name }) : fmt(S.custom.kind_prompt, { ean })),
    keyboard: [[kind("olut")], [kind("viini"), kind("kuohu")], [kind("vakeva")], back("j")],
  };
}

/** The typed steps of adding a product: name, then size and ABV, then energy (skippable). */
export function customStepView(ctx: BotContext, ean: string, step: "name" | "amount" | "kcal", error = ""): View {
  const existing = ctx.kili.services.customProducts.get(ean);
  const prefix = error ? error + "\n\n" : "";
  const keyboard = [...(step === "kcal" ? [[btn(S.custom.skip_button, "bs")]] : []), back("j")];
  const prompt =
    step === "name"
      ? fmt(S.custom.name_prompt, { current: currentValue(existing?.name) })
      : step === "amount"
        ? fmt(S.custom.amount_prompt, { current: currentValue(existing && `${cl(existing.sizeL)} cl ${num(existing.abv)} %`) })
        : fmt(S.custom.kcal_prompt, { current: currentValue(existing?.kcal100 != null ? `${num(existing.kcal100)} kcal` : null) });
  return { text: customHeader(!!existing) + prefix + prompt, keyboard };
}

/** Saves the product typed in the flow and opens it, or explains why it couldn't be saved. */
export function saveCustomProduct(
  ctx: BotContext,
  profile: Profile,
  data: { ean: string; kind: (typeof CUSTOM_KINDS)[number]; name: string; sizeL: number; abv: number; kcal100: number | null },
): View {
  const { products, customProducts } = ctx.kili.services;
  // The catalogue may have learnt the barcode meanwhile; it always wins.
  const alkoId = products.productIdByEan(data.ean);
  if (alkoId && products.get(alkoId)) return productView(ctx, alkoId, fmt(S.custom.in_catalogue, { ean: data.ean }));
  const r = customProducts.save(data, profile.id, isAdmin(ctx));
  if (!r.ok) {
    if (r.reason === "not_allowed") return productView(ctx, customDrinkId(data.ean), S.custom.not_allowed);
    return juoView(ctx, profile, S.custom.no_serving); // the flow validates first; not expected
  }
  if (r.created) console.log(`Custom barcode product added: ${r.product.ean} ${JSON.stringify(r.product.name)}`);
  return productView(ctx, customDrinkId(data.ean), r.created ? fmt(S.custom.saved, { ean: data.ean }) : S.custom.updated);
}

/** Why the add/edit flow can't go on for this barcode (Alko knows it, or not the user's product), or null. */
function customBlockedView(ctx: BotContext, ean: string): View | null {
  const { products, customProducts } = ctx.kili.services;
  const alkoId = products.productIdByEan(ean);
  if (alkoId && products.get(alkoId)) return productView(ctx, alkoId, fmt(S.custom.in_catalogue, { ean }));
  const existing = customProducts.get(ean);
  if (existing && !canEditCustom(ctx, existing)) return productView(ctx, customDrinkId(ean), S.custom.not_allowed);
  return null;
}

/** "Ilmoita virheestä": asks what is wrong with a user-added product. */
export function reportView(p: CustomProduct, error = ""): View {
  return {
    text: header(S.custom.title_report) + (error ? error + "\n\n" : "") + fmt(S.custom.report_prompt, { name: p.name, ean: p.ean }),
    keyboard: [back(`p:${customDrinkId(p.ean)}`)],
  };
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
 * package's Alko price; links to the product on Alkometriikka and Alko.
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
  const links: string[] = [];
  const add = (url: string | undefined, text: string) => {
    if (url) links.push(fmt('<a href="{url}">{text}</a>', { url, text }));
  };
  add(ctx.kili.services.products.pageUrl(p.id), S.search.product_link);
  add(ctx.kili.services.products.alkoUrl(p.id), S.search.alko_link);
  if (links.length) lines.push(links.join(" · "));
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
      [btn(fmt(S.asetukset.kuvaaja.button, { choice: profile.chartName === "username" ? S.asetukset.kuvaaja.username : S.asetukset.kuvaaja.full }), "amk")],
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
      ...(ctx.kili.config.web.enabled ? [[btn(S.asetukset.nimettomyys.button, "an")]] : []),
      ...(ctx.kili.config.accountLinking ? [[btn(S.asetukset.linkit.button, "al")]] : []),
      [btn(S.asetukset.data.button, "ax")],
      [btn(S.asetukset.poista.button, "ad")],
      back("s"),
    ],
  };
}

/**
 * Per group: show as "Nimetön N" on the website's event screens. In private, so choosing it isn't
 * announced to the group. Buttons carry the first 16 hex characters of the group id (callback
 * data has 64 bytes); a press only ever matches the user's own groups.
 */
export function anonymityView(ctx: BotContext, p: Profile): View {
  const t = S.asetukset.nimettomyys;
  const groups = ctx.kili.services.groups.listFor(p.id);
  return {
    text: header(S.asetukset.title) + t.on_select + (groups.length ? "" : "\n\n" + t.none),
    keyboard: [
      // Button labels are plain text, not HTML: the name goes in as is (fmt would escape it).
      ...groups.map((g) => [btn((g.hideOnScreen ? t.hidden : t.shown).replace("{name}", g.name ?? t.unnamed), `ant:${g.id.slice(0, 16)}`)]),
      back("a"),
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
const KEEPS_PENDING = new Set(["jks", "r:g", "r:t", "i:y", "bs"]);

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
    const drink = findDrink(ctx, drinkId ?? "");
    const serving = drink && resolveServing(drink, key ?? "");
    if (!drink || !serving) return goneView();
    return drankView(ctx, p, logServing(ctx, p, drink, serving));
  }),
  // ✏️ Muu määrä: the next message is the amount
  pc: withProfile((ctx, p, arg) => {
    const drink = findDrink(ctx, arg ?? "");
    if (!drink) return goneView();
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "productAmount", drinkId: drink.id });
    return customAmountView(drink);
  }),
  // ➕ Lisää tuote / ✏️ Muokkaa tuotetta (user-added barcode products): pick the kind of drink
  bn: withProfile((ctx, p, arg) => {
    const ean = normalizeEan(arg ?? "");
    if (!ean) return juoView(ctx, p);
    return customBlockedView(ctx, ean) ?? customKindView(ctx, ean);
  }),
  // The kind was picked: the next message is the name
  bk: withProfile((ctx, p, arg) => {
    const [rawEan, kind] = (arg ?? "").split(":");
    const ean = normalizeEan(rawEan ?? "");
    if (!ean || !kind || !isCustomKind(kind)) return juoView(ctx, p);
    const blocked = customBlockedView(ctx, ean);
    if (blocked) return blocked;
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "customProduct", ean, productKind: kind, step: "name" });
    return customStepView(ctx, ean, "name");
  }),
  // Ohita: no energy given. When editing, the old value stays.
  bs: withProfile((ctx, p) => {
    const { pending, customProducts } = ctx.kili.services;
    const state = pending.get(ctx.kili.identityId!);
    pending.clear(ctx.kili.identityId!);
    if (state?.kind !== "customProduct" || state.step !== "kcal" || !state.name || !state.sizeL || !state.abv) return juoView(ctx, p);
    const { ean, productKind: kind, name, sizeL, abv } = state;
    return saveCustomProduct(ctx, p, { ean, kind, name, sizeL, abv, kcal100: customProducts.get(ean)?.kcal100 ?? null });
  }),
  bd: withProfile((ctx, p, arg) => {
    const product = ctx.kili.services.customProducts.get(arg ?? "");
    if (!product) return juoView(ctx, p, S.custom.gone);
    if (!canEditCustom(ctx, product)) return productView(ctx, customDrinkId(product.ean), S.custom.not_allowed);
    return {
      text: header(S.custom.title_edit) + fmt(S.custom.delete_confirm, { ean: product.ean, name: product.name }),
      keyboard: [[btn(S.yes, `bdy:${product.ean}`), btn(S.no, `p:${customDrinkId(product.ean)}`)]],
    };
  }),
  bdy: withProfile((ctx, p, arg) => {
    const { customProducts } = ctx.kili.services;
    const product = customProducts.get(arg ?? "");
    if (!product) return juoView(ctx, p, S.custom.gone);
    if (!customProducts.delete(product.ean, p.id, isAdmin(ctx))) return productView(ctx, customDrinkId(product.ean), S.custom.not_allowed);
    console.log(`Custom barcode product deleted: ${product.ean} ${JSON.stringify(product.name)}`);
    return juoView(ctx, p, S.custom.deleted);
  }),
  // ⚠️ Ilmoita virheestä: the next message is the report
  br: withProfile((ctx, p, arg) => {
    const product = ctx.kili.services.customProducts.get(arg ?? "");
    if (!product) return juoView(ctx, p, S.custom.gone);
    ctx.kili.services.pending.set(ctx.kili.identityId!, { kind: "productReport", ean: product.ean });
    return reportView(product);
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
  amk: withProfile((ctx, p, arg) => {
    if (arg === "f" || arg === "u") {
      ctx.kili.services.accounts.updateChartName(p.id, arg === "u" ? "username" : "full");
      return profileViewFor(ctx, S.asetukset.kuvaaja.changed);
    }
    return {
      text: header(S.asetukset.title) + fmt(S.asetukset.kuvaaja.on_select, { full: p.fullName ?? p.name, username: p.name, now: p.chartName === "username" ? S.asetukset.kuvaaja.username : S.asetukset.kuvaaja.full }),
      keyboard: [[btn(S.asetukset.kuvaaja.full, "amk:f"), btn(S.asetukset.kuvaaja.username, "amk:u")], back("am")],
    };
  }),
  ax: withProfile(async (ctx) => {
    if (ctx.from) await sendExport(ctx, ctx.from.id);
    return settingsView(ctx);
  }),
  // Nimettömyys näytöillä
  an: withProfile((ctx, p) => (ctx.kili.config.web.enabled ? anonymityView(ctx, p) : settingsView(ctx))),
  ant: withProfile((ctx, p, arg) => {
    if (!ctx.kili.config.web.enabled) return settingsView(ctx);
    const g = arg && /^[0-9a-f]{16}$/.test(arg) ? ctx.kili.services.groups.listFor(p.id).find((x) => x.id.startsWith(arg)) : undefined;
    if (g) ctx.kili.services.groups.setHidden(p.id, g.id, !g.hideOnScreen);
    return anonymityView(ctx, p);
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
      fmt(S.help.privacy.text, { ...contactExtras(ctx.kili.config), retention: retentionText(ctx.kili.config), web: webPrivacyText(ctx.kili.config) }),
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
  hfr: (ctx) =>
    textNode(S.help.faq.ryhmat.title, S.help.faq.ryhmat.text + (ctx.kili.config.web.enabled ? S.help.faq.ryhmat.web : ""), "hf"),
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

