# Bläkkiskili

A Telegram bot that estimates your blood alcohol concentration (‰) from the drinks you log. It also shows group listings (`/promillet`, `/annokset`) for the chats you join with `/moro`.

Bläkkiskili is a Bun + TypeScript bot based on the original [BläkkisVuohi](https://gitlab.com/ultsi-projects/blakkisvuohi) by Joonas Ulmanen, which shuts down in November 2026. It is an independent project and isn't maintained by or affiliated with the original author. The BAC math is ported unchanged, so estimates match the old bot exactly (checked against the original code). Users can bring their history over from the old bot's `/data` export.

## Features

- `/start` menu (private chat):
  - **Juo:** presets, custom drink, late logging (*Jälkikellotus*), undo, quick buttons for the two latest drinks.
  - **Tilastoja:** consumption (alcohol and energy) over N days, last 72 h.
  - **Asetukset:** edit profile, export data, delete the account.
  - **Help.**
- Group commands: `/moro`, `/poistu`, `/promillet`, `/annokset`, `/stats [days]`, `/stats2 [days]`.
- `/kuvaaja`: a chart image of everyone's estimated ‰ over the last hours plus a 12 h forecast, in a group or for yourself.
- **Alko product search** using [Alkometriikka](https://alkometriikka.fi)'s catalogue (about 11,000 products, refreshed every 6 h, cached on disk):
  - **Inline mode** (`@blakkiskilibot karhu`) shows results as you type, one result per product. Picking one opens it in the private chat to choose the serving (with an amount in the query, a tap logs that amount).
  - **Typed search** in the Juo menu is the fallback.
  - Every package size of a drink is one entry. Jaloviina's eight bottle sizes become one "2 / 4 / 6 cl" choice, and Karhu offers its 33 cl and 50 cl cans. You pick the amount you drank, not the package.
  - The usual amounts are offered as plain amounts (33 cl, 16 cl, 75 cl, 4 cl), each button showing the standard drinks and kcal it equals.
  - Results show energy and the Alko price of that amount. The product view adds maker, country, kcal/100 ml, the package price, the price per standard drink and a link to the product on Alkometriikka.
  - ✏️ *Muu määrä* takes any amount (`3`, `3 cl`, `0,5 l`, `250 ml`). An amount at the end of a search (`jallu 3 cl`, `karhu 40cl`) gives one-tap results with exactly that amount, both inline and in the menu.
  - Nicknames such as *jallu*, *kossu* and *lonkka* work.
  - Search only works in the private chat, so drinks are never posted to groups.
- **Barcodes**: send a barcode number or a photo of one and the bot opens the product. Alko's API has no barcodes, so Alkometriikka learns them from scans: its `data.minimal.json` has an EAN column, and its API Worker (`ALKOMETRIIKKA_API_URL`) asks Alko for barcodes not yet there. The bot sends only the barcode number. Photos are decoded locally with zxing-wasm and not stored. For barcodes Alko doesn't know (grocery-store beers and the like), any user can add the product (kind, name, size, ABV, optional kcal). It is stored only in the bot's database (`custom_products`), opens for everyone who scans the barcode, and can be edited or deleted by the user who added it and by admins. The website has the same on its Juo page: the camera (or a photo) is read in the browser with the native `BarcodeDetector` or zxing-wasm (its `.wasm` served from our origin, which is why the CSP has `'wasm-unsafe-eval'` and the Permissions-Policy `camera=(self)`), and only the number goes to `GET /api/barcodes/<ean>`.
- Shortcuts kept from the old bot: `/juoma`, `/kalja033`, `/kalja05`, `/jalkikellotus`, `/laatta`, `/tunnus`, `/whoami`.
- **Energy (kcal):** each drink stores an energy estimate when it's logged. Catalogue drinks use Alko's *Energia kcal/100 ml*, and presets use a typical value (the median of comparable Alko products, see [`src/lib/catalog.ts`](src/lib/catalog.ts)). Custom and late-logged drinks, and drinks imported from the old bot, have none. The drink confirmation and the start screen show the current evening's total (drinks with no pause of 6 h or more), Kulutus shows the total for the period, and both say how many drinks had no data.
- `/data` exports everything as CSV. `/tuo` imports CSVs from the old bot or from this one.
- `/admin_stats` for the IDs listed in `ADMIN_IDS`. On the website the same people get an admin page (`/admin`): bot and site numbers, and removing user-added barcode products.

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

### Website (development)

The website is a SvelteKit single-page app in `web/`, served by the bot's own process (`src/web/`). It is off unless `WEB_ENABLED=1`.

```sh
bun run web:build             # build web/ into web/build (installs web/ dependencies)
bun run web:demo              # try the UI with a throwaway database and a demo user, no Telegram needed
```

With the real dev bot: set `WEB_ENABLED=1` and `WEB_ORIGIN=http://localhost:8081` in `.env`, run `bun run dev`, send the bot `/web` and open the link it gives (it is shown as text because Telegram does not link `localhost`). For hot reload run `bun run web:dev` (port 5173, forwards `/api` to the bot) and use `WEB_ORIGIN=http://localhost:5173`. Telegram's login button only works on the registered domain; locally use `/web`. `bun run web:check` type-checks the app.

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

- Platform user IDs (Telegram, and others once linked) and chat IDs are stored only as HMAC-SHA256 under a key derived from `APP_SECRET`. The old bot used unsalted sha256, which can be reversed by brute force.
- Display names are encrypted with AES-256-GCM.
- What is stored: name (@username or full name) and the full Telegram name (used in charts), weight, height, gender, drinks (amount, description, time, estimated energy, and for catalogue drinks the Alko product number) and group memberships. No message contents: the bot only receives commands in groups (privacy mode).
- Deleting the account (*Asetukset → Poista tunnus*) removes everything immediately.
- **Inactive accounts are deleted** after `INACTIVE_DELETE_DAYS` (default 730, about 24 months). The user gets a private warning `INACTIVE_WARN_DAYS` (default 30) days before, and any use of the bot cancels it. For the warning, each login's platform user ID is also stored encrypted with AES-256-GCM, like names. Only Telegram can deliver it for now; an account whose logins are all on platforms without a bot is treated as warned and deleted after the notice period. A job runs every 6 hours.
  - The notice period is always respected, even if warnings go out late.
  - Users who blocked the bot count as warned and are deleted after the notice period.
  - Network errors are retried on the next run.
  - The terms and privacy texts state the rule automatically. `0` keeps accounts forever and removes the sentence.
- Typed-input state lives in a `pending` table, per login, and expires after 24 h.
- **Backups:**
  - Every hour the bot writes a consistent snapshot of the database (`VACUUM INTO`, integrity-checked, mode 600).
  - The `backup` service uses restic to ship it off-site, encrypted client-side, keeping 7 daily, 4 weekly and 3 monthly snapshots.
  - It optionally pings a dead-man's switch, and failures are DMed to `ADMIN_IDS`.
  - The backup service has its own credentials file (`backup.env`) and never sees `APP_SECRET`.
- **Containers:** read-only root filesystem, all capabilities dropped, `no-new-privileges`, non-root user, memory and process limits, and log rotation. The process umask is 077.
- **Rate limit:** 30 updates per minute per user, against floods and database stuffing.

**Website.** Sign-in is the Telegram Login Widget or a single-use `/web` link (token in the URL fragment, so it never reaches a log). Sessions are random tokens in an HttpOnly cookie; only their HMAC is stored, and they expire after 30 idle days. Settings has "sign out everywhere", which ends every session of the account and closes its open live pages. A session is an admin's only if it was signed in with a Telegram login listed in `ADMIN_IDS` (compared as identity keys, and the login must still belong to the account); the admin API answers 404 to everyone else. Writes need the site's own `Origin` and a custom header, the Content-Security-Policy allows no inline styles and only the one hashed bootstrap script, and every API call takes the account from the session, never from the request. Event screens are read-only links (hash stored, expiring in at most 7 days, revocable, members can appear as "Nimetön"); the token is exchanged for a cookie so it is never in a request URL. The server is reached only through a Cloudflare Tunnel; see `deploy/RUNBOOK.md` §7. Rate limits: sign-in 10 per minute per address, other calls 120 per minute per account, at most 5 live streams per account or screen link.

## Several platforms, one account

An account (`users`) is the person: body data, drinks, groups. Each platform login is a row in `identities` (HMAC of the platform user ID → account), at most one per platform. Accounts made before this have their Telegram HMAC as their id. New ones get a random id, so an account doesn't depend on any one login.

Linking (off unless `ACCOUNT_LINKING=1`): *Asetukset → Yhdistetyt palvelut → Luo yhdistämiskoodi* gives a one-time code (10 min, stored as an HMAC). Sending `/yhdista KOODI` on the other platform adds that login to the account. Accounts are never merged. A login that already has an account, or a second login on a platform the account already uses, is refused. The login you're using can't be unlinked (delete the account instead).

To add a platform, e.g. Discord:

- Add it to `PLATFORMS` in `src/lib/ids.ts` (Discord is already there) and `PLATFORM_NAMES` in `src/strings.ts`.
- Write a front end next to `src/bot/` that resolves `services.identities.key({ platform, platformUserId })` → `accounts.byIdentity()`, keys typed input by the identity id, calls `accounts.register()` for sign-up and `identities.redeemLinkCode()` for `/yhdista`.
- Give `runInactivityJob` a sender for the platform's contacts.
- Groups (`groups.ts`) and `/data`/`/tuo` are still Telegram-shaped: group keys are Telegram chat IDs, and the CSV `userid` is the legacy sha256 of the Telegram ID.

## Code layout

```
src/index.ts          entry point: config, DB, bot, polling/webhook
src/config.ts         environment variables
src/db/index.ts       SQLite schema + migrations (PRAGMA user_version)
src/lib/              pure code: alcomath (BAC), units, drink catalog, CSV, ids/crypto, formatting
src/services/         domain logic, no Telegram dependency (identities, accounts, drinks, groups, stats, importer, pending)
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
