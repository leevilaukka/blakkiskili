// Typed-input steps of the menu flows (private chat only), and CSV import via documents.

import type { BotContext } from "./context.ts";
import { displayName } from "./context.ts";
import {
  consumptionView,
  customDrinkView,
  drankText,
  genderKeyboard,
  juoView,
  lateView,
  logServing,
  searchResultsView,
  customAmountView,
  profileViewFor,
  registerTermsView,
  registerView,
} from "./menu.ts";
import { back, sendHtml, sendView } from "./ui.ts";
import { S } from "../strings.ts";
import { fmt, raw } from "../lib/format.ts";
import {
  alcoholMgFromClPercent,
  isAlcoholAmountOutOfLimits,
  parseIntStrict,
  parseNumber,
} from "../lib/units.ts";
import { isValidHeight, isValidWeight } from "../services/accounts.ts";
import type { ImportResult } from "../services/importer.ts";
import { customServing, parseAmount } from "../lib/servings.ts";

/** Handles a private text message. Returns false if no flow was waiting for it. */
export async function handleFlowText(ctx: BotContext, text: string): Promise<boolean> {
  const { identityId: userId, services, profile } = ctx.kili;
  if (!userId) return false;
  const state = services.pending.get(userId);
  if (!state) return false;
  const words = text.trim().split(/\s+/).filter(Boolean);

  switch (state.kind) {
    case "register": {
      if (state.step === "weight") {
        const weight = parseIntStrict(words[0]);
        if (!isValidWeight(weight)) return reply(ctx, registerView(S.register.weight_error));
        services.pending.set(userId, { ...state, step: "height", weight });
        return reply(ctx, registerView(S.register.height));
      }
      if (state.step === "height") {
        const height = parseIntStrict(words[0]);
        if (!isValidHeight(height)) return reply(ctx, registerView(S.register.height_error));
        services.pending.set(userId, { ...state, step: "gender", height });
        return reply(ctx, registerView(S.register.gender, [...genderKeyboard("r:g"), back("s")]));
      }
      // gender and terms are answered with buttons; repeat the question.
      if (state.step === "gender") {
        return reply(ctx, registerView(S.register.gender, [...genderKeyboard("r:g"), back("s")]));
      }
      return reply(ctx, registerTermsView(ctx));
    }

    case "customDrink": {
      if (!profile) return false;
      const help = raw(S.juo.oma.help);
      if (words.length !== 2) return reply(ctx, customDrinkView(fmt(S.juo.oma.error_words, { help })));
      const cl = parseNumber(words[0], "cl");
      const vol = parseNumber(words[1], "%");
      if (!Number.isFinite(cl) || cl <= 0) return reply(ctx, customDrinkView(fmt(S.juo.oma.error_cl, { help })));
      if (!Number.isFinite(vol) || vol <= 0 || vol >= 100) return reply(ctx, customDrinkView(fmt(S.juo.oma.error_vol, { help })));
      const mg = alcoholMgFromClPercent(cl, vol);
      if (isAlcoholAmountOutOfLimits(mg)) return reply(ctx, customDrinkView(S.juo.oma.error_exceeds));
      const name = fmt(S.juo.oma.description, { cl, vol });
      services.drinks.add(profile.id, mg, name);
      // Stay in the flow so another custom drink can be typed right away.
      return reply(ctx, juoView(ctx, profile, drankText(ctx, profile, name)));
    }

    case "late": {
      if (!profile) return false;
      if (state.hours === undefined) {
        const hours = parseNumber(words[0]);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24) return reply(ctx, lateView(S.juo.late.hours_error));
        services.pending.set(userId, { ...state, hours });
        return reply(ctx, lateView(S.juo.late.input_drinks));
      }
      if (words.length < 2 || words.length % 2 !== 0) return reply(ctx, lateView(S.juo.late.words_error, state.drinks.length > 0));
      const added: { cl: number; vol: number }[] = [];
      for (let i = 0; i < words.length; i += 2) {
        const cl = parseNumber(words[i], "cl");
        const vol = parseNumber(words[i + 1], "%");
        const n = i / 2 + 1;
        if (!Number.isFinite(cl) || !Number.isFinite(vol) || cl <= 0 || cl > 250 || vol <= 0 || vol >= 100) {
          return reply(ctx, lateView(fmt(S.juo.late.drink_error, { drink: n }), state.drinks.length > 0));
        }
        if (isAlcoholAmountOutOfLimits(alcoholMgFromClPercent(cl, vol))) {
          return reply(ctx, lateView(fmt(S.juo.late.out_of_limits, { drink: n }), state.drinks.length > 0));
        }
        added.push({ cl, vol });
      }
      const drinks = [...state.drinks, ...added];
      services.pending.set(userId, { ...state, drinks });
      return reply(
        ctx,
        lateView(
          fmt(S.juo.late.drinks_correct, {
            count: added.length,
            list: drinks.map((d) => `${d.cl}cl ${d.vol}%`).join("\n"),
          }),
          true,
        ),
      );
    }

    case "editWeight":
    case "editHeight": {
      if (!profile) return false;
      const value = parseIntStrict(words[0]);
      const m = S.asetukset.muokkaa;
      if (state.kind === "editWeight") {
        if (!isValidWeight(value)) return reply(ctx, { text: m.weight_error, keyboard: [back("am")] });
        services.accounts.updateWeight(profile.id, value);
      } else {
        if (!isValidHeight(value)) return reply(ctx, { text: m.height_error, keyboard: [back("am")] });
        services.accounts.updateHeight(profile.id, value);
      }
      services.pending.clear(userId);
      return reply(ctx, profileViewFor(ctx, state.kind === "editWeight" ? m.paino.changed : m.pituus.changed));
    }

    case "consumptionDays": {
      if (!profile) return false;
      const days = parseIntStrict(words[0]);
      return reply(ctx, consumptionView(ctx, profile, days > 0 && days <= 3650 ? days : undefined));
    }

    case "productAmount": {
      if (!profile) return false;
      const drink = services.products.get(state.drinkId);
      if (!drink) {
        services.pending.clear(userId);
        return reply(ctx, juoView(ctx, profile, S.search.gone));
      }
      const litres = parseAmount(text);
      const r = litres === null ? ({ error: "invalid" } as const) : customServing(drink, litres);
      if ("error" in r) {
        const error = r.error === "too_much" ? fmt(S.search.custom_too_much, { q: text.trim().slice(0, 30) }) : S.search.custom_invalid;
        return reply(ctx, customAmountView(drink, error));
      }
      services.pending.clear(userId);
      return reply(ctx, juoView(ctx, profile, drankText(ctx, profile, logServing(ctx, profile, drink, r.serving))));
    }

    case "productSearch":
      if (!profile) return false;
      // Stay in the flow: the user can refine the search by typing again.
      return reply(ctx, searchResultsView(ctx, profile, text.trim().slice(0, 100)));

    case "import":
      if (state.step === "files") {
        await sendHtml(ctx, S.import.send_files, [back("s")]);
        return true;
      }
      return false;
  }
}

async function reply(ctx: BotContext, view: Parameters<typeof sendView>[1]): Promise<true> {
  await sendView(ctx, view);
  return true;
}

// ---------- import ----------

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

async function downloadText(ctx: BotContext, fileId: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path");
  const res = await fetch(`https://api.telegram.org/file/bot${ctx.kili.config.botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  return await res.text();
}

function resultText(r: ImportResult): string {
  if (!r.ok) return S.import[r.reason];
  switch (r.kind) {
    case "user":
      return r.created ? S.import.user_created : S.import.user_updated;
    case "drinks":
      return fmt(S.import.drinks, { inserted: r.inserted, duplicates: r.duplicates, invalid: r.invalid });
    case "groups":
      return fmt(S.import.groups, { groups: r.groups });
  }
}

/** Handles a document sent in private chat. */
export async function handleImportDocument(ctx: BotContext) {
  const doc = ctx.message?.document;
  const { identityId: userId, services } = ctx.kili;
  if (!doc || !userId || !ctx.from) return;

  const state = services.pending.get(userId);
  if (state?.kind !== "import" || state.step !== "files") {
    await sendHtml(ctx, S.import.not_in_flow);
    return;
  }
  if ((doc.file_size ?? 0) > MAX_IMPORT_BYTES) {
    await sendHtml(ctx, S.import.too_big);
    return;
  }

  const text = await downloadText(ctx, doc.file_id);
  const kind = services.importer.peek(text);
  if ((kind === "drinks" || kind === "groups") && !services.accounts.byIdentity(userId)) {
    // user.csv may arrive after drinks.csv in the same batch: keep this one for later.
    services.pending.set(userId, { ...state, waitingDrinkFiles: [...(state.waitingDrinkFiles ?? []), doc.file_id] });
    await sendHtml(ctx, S.import.waiting_for_user);
    return;
  }

  const name = displayName(ctx.from);
  const result = services.importer.import(text, ctx.from.id, name);
  await sendHtml(ctx, resultText(result));

  if (result.ok && result.kind === "user") {
    ctx.kili.profile = services.accounts.byIdentity(userId);
    const waiting = services.pending.get(userId);
    if (waiting?.kind === "import" && waiting.waitingDrinkFiles?.length) {
      services.pending.set(userId, { kind: "import", step: "files" });
      for (const fileId of waiting.waitingDrinkFiles) {
        const r = services.importer.import(await downloadText(ctx, fileId), ctx.from.id, name);
        await sendHtml(ctx, resultText(r));
      }
    }
  }
}
