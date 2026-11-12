// The person's data: download everything, import the original bot's export, delete the account.

import { importResultText } from "../../bot/context.ts";
import { zip } from "../../lib/zip.ts";
import type { ImportOutcome } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Routes } from "./context.ts";
import { user } from "./guards.ts";

/** Telegram's import limit in the bot; the same here. */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

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
