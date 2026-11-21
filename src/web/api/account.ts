// The person's data: download everything, import the original bot's export, delete the account.

import { importResultText } from "../../bot/context.ts";
import { zip } from "../../lib/zip.ts";
import type { ImportOutcome, LocalDrink, LocalImportResult } from "../../../shared/api.ts";
import { isAlkoProductId } from "../../lib/servings.ts";
import { isAlcoholAmountOutOfLimits, MINUTE_MS } from "../../lib/units.ts";
import { fail, json } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { user } from "./guards.ts";

/** Telegram's import limit in the bot; the same here. */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** A local account's drinks go up in batches of at most this many (the browser splits them). */
export const LOCAL_IMPORT_BATCH = 500;
const LOCAL_IMPORT_BYTES = 256 * 1024;
/** Nothing from before the original bot existed. */
const OLDEST_DRINK = Date.parse("2015-01-01T00:00:00Z");

/** One drink from a local account, checked like the bot checks what it logs; null if it isn't acceptable. */
function localDrink(raw: unknown, now: number, withTime: boolean): LocalDrink | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const { alcoholMg, description, createdAt, productId, kcal } = d;
  if (!(typeof alcoholMg === "number" && Number.isSafeInteger(alcoholMg) && alcoholMg > 0 && !isAlcoholAmountOutOfLimits(alcoholMg))) return null;
  if (typeof description !== "string" || !description.trim() || description.length > 200 || /[\p{Cc}]/u.test(description)) return null;
  if (withTime && !(typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= OLDEST_DRINK && createdAt <= now + MINUTE_MS)) return null;
  if (!(productId === null || productId === undefined || (typeof productId === "string" && isAlkoProductId(productId)))) return null;
  if (!(kcal === null || kcal === undefined || (typeof kcal === "number" && Number.isFinite(kcal) && kcal >= 0 && kcal <= 10_000))) return null;
  return {
    alcoholMg,
    description: description.trim(),
    createdAt: withTime ? Math.min(createdAt as number, now) : 0,
    productId: (productId as string | null | undefined) ?? null,
    kcal: kcal === null || kcal === undefined ? null : Math.round(kcal as number),
  };
}

export function accountRoutes({ services, cookies, now }: Api): Routes {
  /**
   * The Telegram id behind the account's login, which the export format needs (`userid` is
   * the original bot's sha256 of it, so the files can be imported again). The server holds it
   * only encrypted, for the inactivity warning.
   */
  const telegramId = (accountId: string): number | null => {
    const contact = services.identities.contacts(accountId).find((x) => x.platform === "telegram");
    const id = Number(contact?.address);
    return Number.isSafeInteger(id) ? id : null;
  };

  return {
    // All the account's data as CSV files in a zip, like /data in the bot.
    "/api/account/export": {
      GET: user((c) => {
        const id = telegramId(c.user.id);
        const files = id === null ? null : services.accounts.exportCsv(c.user.id, id);
        if (!files) return fail(409, "no_telegram");
        const archive = zip(
          files.map((f) => ({ name: f.filename, data: f.csv })),
          now(),
        );
        const day = new Date(now()).toISOString().slice(0, 10);
        return new Response(archive, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="blakkiskili-${day}.zip"`,
            "cache-control": "no-store",
          },
        });
      }),
    },

    // One CSV file per request (user.csv, drinks.csv or groups.csv), as the raw text.
    "/api/account/import": {
      POST: user(async (c) => {
        const length = Number(c.req.headers.get("content-length") ?? 0);
        if (length > MAX_IMPORT_BYTES) return fail(413, "too_big");
        const text = await c.req.text();
        if (text.length > MAX_IMPORT_BYTES) return fail(413, "too_big");
        const id = telegramId(c.user.id);
        if (id === null) return fail(409, "no_telegram");
        const result = services.importer.import(text, id, c.user.name);
        // Importing user.csv may change the name or body data; the open pages follow.
        return json({ ok: result.ok, message: importResultText(result) } satisfies ImportOutcome);
      }),
    },

    // A local account (the website without an account, data in the browser) moving online: its
    // drinks and favourites join the signed-in account. Drinks already there are skipped, so a
    // batch sent twice (a dropped connection) adds nothing twice.
    "/api/account/local-import": {
      POST: user(async (c) => {
        const data = await c.body(LOCAL_IMPORT_BYTES);
        if (!data || !Array.isArray(data.drinks) || data.drinks.length > LOCAL_IMPORT_BATCH) return fail(400, "bad_request");
        const favs = data.favorites === undefined ? [] : data.favorites;
        if (!Array.isArray(favs) || favs.length > 50) return fail(400, "bad_request");
        const t = now();
        const valid = data.drinks.map((d) => localDrink(d, t, true)).filter((d): d is LocalDrink => d !== null);
        const inserted = services.drinks.addMany(c.user.id, valid);
        let favorites = 0;
        for (const f of favs) {
          const fav = localDrink(f, t, false);
          if (fav && services.favorites.add(c.user.id, fav) === "added") favorites += 1;
        }
        return json({
          inserted,
          duplicates: valid.length - inserted,
          invalid: data.drinks.length - valid.length,
          favorites,
        } satisfies LocalImportResult);
      }),
    },

    // Deletes the account and everything with it, for good. The body must confirm.
    "/api/account": {
      DELETE: user(async (c) => {
        const data = await c.body();
        if (data?.confirm !== true) return fail(400, "bad_request");
        services.accounts.delete(c.user.id);
        return json({ ok: true }, 200, { "set-cookie": cookies.clear(cookies.session) });
      }),
    },
  };
}
