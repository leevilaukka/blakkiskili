# Bläkkiskili

A Telegram bot that estimates your blood alcohol concentration (‰) from the drinks you log. It also shows group listings (`/promillet`, `/annokset`) for the chats you join with `/moro`.

Bläkkiskili is a Bun + TypeScript bot based on the original [BläkkisVuohi](https://gitlab.com/ultsi-projects/blakkisvuohi) by Joonas Ulmanen, which shuts down in November 2026. It is an independent project and isn't maintained by or affiliated with the original author. The BAC math is ported unchanged, so estimates match the old bot exactly (checked against the original code). Users can bring their history over from the old bot's `/data` export.

## Features

- `/start` menu (private chat):
  - **Juo:** presets, custom drink, late logging (*Jälkikellotus*), undo, quick buttons for the two latest drinks.
  - **Tilastoja:** consumption over N days, last 72 h.
  - **Asetukset:** edit profile, export data, delete the account.
  - **Help.**
- Group commands: `/moro`, `/poistu`, `/promillet`, `/annokset`, `/stats [days]`, `/stats2 [days]`.
- `/kuvaaja`: a chart image of everyone's estimated ‰ over the last hours plus a 12 h forecast, in a group or for yourself.
- **Alko product search** using [Alkometriikka](https://alkometriikka.fi)'s catalogue (about 11,000 products, refreshed every 6 h, cached on disk):
  - **Inline mode** (`@blakkiskilibot karhu`) shows results as you type, and a tap logs the drink.
  - **Typed search** in the Juo menu is the fallback.
  - Every package size of a drink is one entry. Jaloviina's eight bottle sizes become one "2 / 4 / 6 cl" choice, and Karhu offers its 33 cl and 50 cl cans. You pick the amount you drank, not the package.
  - The usual amounts are offered as plain amounts (33 cl, 16 cl, 75 cl, 4 cl), each button showing the standard drinks it equals.
  - ✏️ *Muu määrä* takes any amount (`3`, `3 cl`, `0,5 l`, `250 ml`). An amount at the end of a search (`jallu 3 cl`, `karhu 40cl`) gives one-tap results with exactly that amount, both inline and in the menu.
  - Nicknames such as *jallu*, *kossu* and *lonkka* work.
  - Search only works in the private chat, so drinks are never posted to groups.
- **Barcodes**: send a barcode number or a photo of one and the bot opens the product. Barcodes aren't in Alko's API, so people link them: when a barcode is unknown the bot asks for the product name, and a product's page has a *Linkitä viivakoodi* button. Links are stored by Alkometriikka's backend (`ALKOMETRIIKKA_API_URL`, `ALKOMETRIIKKA_API_KEY`) and count once two people agree. The bot sends only an opaque voter id, derived with a key of its own, never a Telegram id. Photos are decoded locally with zxing-wasm and not stored.
- Shortcuts kept from the old bot: `/juoma`, `/kalja033`, `/kalja05`, `/jalkikellotus`, `/laatta`, `/tunnus`, `/whoami`.
- `/data` exports everything as CSV. `/tuo` imports CSVs from the old bot or from this one.
- `/admin_stats` for the IDs listed in `ADMIN_IDS`.

Every command of the original is here. Its runtime `/loglevel` admin command and New Relic monitoring were dropped on purpose.

**Announcements:** add an entry to [`src/announcements.ts`](src/announcements.ts) and deploy. Every existing user sees it once, in their private chat, the next time they use the bot. People who register later never see older ones.

## Running

Requires [Bun](https://bun.sh) ≥ 1.4.

```sh
bun install
cp .env.example .env          # set BOT_TOKEN and APP_SECRET (openssl rand -base64 48)
bun run dev                   # long polling, restarts on file changes
bun test                      # unit + end-to-end tests (fake Telegram API)
bun run typecheck
```

### Production (VPS, Docker)

Follow **[deploy/RUNBOOK.md](deploy/RUNBOOK.md)**. It covers secrets, the server ([cloud-init](deploy/cloud-init.yml)), off-site backups, the restore drill and incident response. In short:

```sh
cp .env.example .env && cp backup.env.example backup.env && chmod 600 .env backup.env   # fill in
mkdir -m 700 data backups && sudo chown 1000:1000 data backups
docker compose up -d --build
```

By default the bot uses long polling, so it needs no public URL or open ports. For webhooks, set:
- `BOT_MODE=webhook`
- `WEBHOOK_URL=https://your.host/telegram`
- `WEBHOOK_SECRET`

Then expose port 8080 on localhost behind a TLS reverse proxy. `GET /healthz` returns `ok`.

### BotFather settings for inline search

Set these once for the bot (and for your dev bot):
- `/setinline`: turn inline mode on, with the placeholder `Hae Alkon valikoimasta…`.
- `/setinlinefeedback`: set to **Enabled**. Without it, Telegram doesn't tell the bot which result was picked, so nothing gets logged. The bot detects this and tells the user to use the menu search instead.

Without inline mode, the 🔎 button in the Juo menu falls back to typed search automatically. To turn search off entirely, set `ALKOMETRIIKKA_URL=` (empty).

## Migrating users from the old bot

1. Before the old bot shuts down, everyone runs `/data` in the **old** bot and saves the three files.
2. In the new bot, they run `/tuo`, accept the terms and send `user.csv`, `drinks.csv` and `groups.csv`, in any order.
3. Each row's `userid` must equal `sha256(sender's Telegram id)`. That's how the old bot stored IDs, so a file only imports into the account that downloaded it.
4. Drinks are de-duplicated, so importing twice is harmless.
5. `groups.csv` memberships are remembered as old-format group hashes. The first time someone uses a command in that group with the new bot, those members are added automatically, so nobody has to `/moro` again.

## Privacy and security

Data minimisation was the reason the original bot was shut down, so:

- Telegram user and chat IDs are stored only as HMAC-SHA256 under a key derived from `APP_SECRET`. The old bot used unsalted sha256, which can be reversed by brute force.
- Display names are encrypted with AES-256-GCM.
- What is stored: name (@username or full name) and the full Telegram name (used in charts), weight, height, gender, drinks (amount, description, time) and group memberships. No message contents: the bot only receives commands in groups (privacy mode).
- Deleting the account (*Asetukset → Poista tunnus*) removes everything immediately.
- **Inactive accounts are deleted** after `INACTIVE_DELETE_DAYS` (default 730, about 24 months). The user gets a private warning `INACTIVE_WARN_DAYS` (default 30) days before, and any use of the bot cancels it. For the warning, the Telegram ID is also stored encrypted with AES-256-GCM, like names. A job runs every 6 hours.
  - The notice period is always respected, even if warnings go out late.
  - Users who blocked the bot count as warned and are deleted after the notice period.
  - Network errors are retried on the next run.
  - The terms and privacy texts state the rule automatically. `0` keeps accounts forever and removes the sentence.
- Typed-input state lives in a `pending` table and expires after 24 h.
- **Backups:**
  - Every hour the bot writes a consistent snapshot of the database (`VACUUM INTO`, integrity-checked, mode 600).
  - The `backup` service uses restic to ship it off-site, encrypted client-side, keeping 7 daily, 4 weekly and 3 monthly snapshots.
  - It optionally pings a dead-man's switch, and failures are DMed to `ADMIN_IDS`.
  - The backup service has its own credentials file (`backup.env`) and never sees `APP_SECRET`.
- **Containers:** read-only root filesystem, all capabilities dropped, `no-new-privileges`, non-root user, memory and process limits, and log rotation. The process umask is 077.
- **Rate limit:** 30 updates per minute per user, against floods and database stuffing.

## Code layout

```
src/index.ts          entry point: config, DB, bot, polling/webhook
src/config.ts         environment variables
src/db/index.ts       SQLite schema + migrations (PRAGMA user_version)
src/lib/              pure code: alcomath (BAC), units, drink catalog, CSV, ids/crypto, formatting
src/services/         domain logic, no Telegram dependency (accounts, drinks, groups, stats, importer, pending)
src/bot/              Telegram layer (grammY): menu router, typed-input flows, commands
src/strings.ts        all user-facing texts (Finnish, Telegram HTML)
test/                 bun test, including an end-to-end test against a fake Telegram API
```

### Integration points (e.g. Alkometriikka)

`src/services/` is plain TypeScript over SQLite and doesn't depend on Telegram. A future integration could:

- add an HTTP API with `Bun.serve` (the webhook server in `src/index.ts` already has routes) that calls the services, authenticated per user, or
- replace or extend the static presets in `src/lib/catalog.ts` with a product catalogue lookup.

## License

GPL-3.0-or-later. Derived from BläkkisVuohi © 2017 Joonas Ulmanen (GPL-3.0-or-later); see [LICENSE](LICENSE). Keep the license and the copyright notices.

Running the bot on your own server doesn't oblige you to publish the source; plain GPL only requires that when you give copies of the program to others. Publishing it anyway is good practice. Set `SOURCE_URL` so `/about` links to it.
