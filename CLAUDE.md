# Bläkkiskili

Telegram BAC-estimation bot. Bun + TypeScript + grammY + bun:sqlite. See README.md.

## Commands

- `bun test`: unit tests plus `test/bot.test.ts`, which drives the real bot against a fake Telegram API and checks that every message is valid Telegram HTML
- `bun check`: type check (use this rather than `tsc`)
- `bun run dev`: run locally with long polling (needs `.env`)

## Conventions

- Use Bun APIs: `bun:sqlite`, `Bun.serve`, `bun test`. Bun loads `.env` automatically.
- `src/lib/alcomath.ts` must stay numerically identical to the original Bläkkisvuohi's `alcomath.js`. Users compare estimates, and the height-in-cm quirk is compensated by `MAGIC_NUMBER`.
- Services (`src/services/`) take derived keys (HMACs), never raw Telegram IDs, except where the legacy sha256 format is needed for import and export, and an `IdentityRef` where a login is created or linked (it derives the key and stores the encrypted contact). They must not import grammY.
- Accounts vs logins: `profile.id` is the account (drinks, groups, body data). `ctx.kili.identityId` is the Telegram login (`identities` table, see `src/services/identities.ts`), and pending typed input is keyed by it, never by `profile.id`. Create accounts with `accounts.register(ref, …)`; `upsert` alone makes an account no login can reach.
- All messages use `parse_mode: "HTML"`. Build text with `fmt()` from `src/lib/format.ts`, which escapes values. Use `raw()` only for HTML you built yourself.
- Use `ctx.kili.services.deps.now()` for time, not `Date.now()`, so tests can control the clock.
- Schema changes: append a new entry to `MIGRATIONS` in `src/db/index.ts`. Never edit an existing one.
- Menu nodes live in `NODES` in `src/bot/menu.ts`. Callback data is `m:<node>[:<arg>]`, max 64 bytes. Any navigation clears the pending typed-input state unless the node is in `KEEPS_PENDING`.
- Operations (backups, secrets, server, incidents) are documented in `deploy/RUNBOOK.md`. If you change data retention or the backup policy, update the privacy texts in `src/strings.ts` to match.
- `/kuvaaja`: `src/lib/chart.ts` builds the SVG (a pure function, palette validated with the dataviz skill) and `src/lib/render.ts` converts it to PNG with resvg. The Docker image needs `font-dejavu` for text. After layout changes, render a sample and look at it.
- Announcements live in `src/announcements.ts` (Telegram HTML, newest last).
- Alko catalogue: `src/services/products.ts` (load, refresh and search over Alkometriikka's data.json, columns looked up by name), `src/lib/servings.ts` (product → servings with alcohol, kcal and price, the merging of package sizes into one `CatalogDrink`, and the logged description), `src/bot/inline.ts` (inline mode). Drinks picked from the catalogue store `product_id`. Every logging path passes `kcal` to `drinks.add` (the serving's or preset's; null for custom drinks).
- Barcodes: `src/services/barcodes.ts` mirrors Alkometriikka's confirmed EAN links (ETag refresh, disk cache) and votes with `crypto.voterKey(account id)`, one opaque voter per account unrelated to every other key. `src/lib/ean.ts` must stay in step with the backend's `normalizeEan`. Menu views are in `menu.ts` (`barcodeView`, `linkBarcode`, nodes `el`/`eb`/`ep`); photo decoding is in `src/bot/barcode.ts` and replaced via `BotOptions.barcodeIO` in tests. If you change what is sent to the backend, update the privacy text in `src/strings.ts`.
