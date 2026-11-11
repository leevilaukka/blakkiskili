import { Database } from "bun:sqlite";

// Append-only list of migrations. PRAGMA user_version tracks how many have run.
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id                TEXT PRIMARY KEY,          -- HMAC of Telegram user id
    name_enc          TEXT NOT NULL,             -- AES-GCM encrypted display name
    weight            INTEGER NOT NULL,          -- kg
    height            INTEGER NOT NULL,          -- cm
    gender            TEXT NOT NULL CHECK (gender IN ('mies', 'nainen')),
    accepted_terms_at INTEGER,                   -- epoch ms
    created_at        INTEGER NOT NULL,          -- epoch ms
    tg_id_enc         TEXT,                      -- AES-GCM encrypted Telegram id, only for warning DMs
    last_active_at    INTEGER NOT NULL,          -- epoch ms, drives inactivity deletion
    inactivity_warned_at INTEGER                 -- epoch ms, set when the deletion warning was sent
  ) STRICT;
  CREATE INDEX users_last_active ON users (last_active_at);

  CREATE TABLE drinks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alcohol_mg  INTEGER NOT NULL CHECK (alcohol_mg >= 0),
    description TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    -- natural key: lets CSV imports be re-run without duplicating history
    UNIQUE (user_id, created_at, alcohol_mg, description)
  ) STRICT;
  CREATE INDEX drinks_user_time ON drinks (user_id, created_at);
  CREATE INDEX drinks_time ON drinks (created_at);

  CREATE TABLE groups (
    id         TEXT PRIMARY KEY,                 -- HMAC of Telegram chat id
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE group_members (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, group_id)
  ) STRICT;
  CREATE INDEX group_members_group ON group_members (group_id);

  -- Group memberships imported from the original bot (sha256 of chat id). Converted to
  -- real memberships, and deleted, the first time the group uses the new bot.
  CREATE TABLE legacy_group_memberships (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    legacy_group_id TEXT NOT NULL,
    PRIMARY KEY (user_id, legacy_group_id)
  ) STRICT;
  CREATE INDEX legacy_group_memberships_group ON legacy_group_memberships (legacy_group_id);

  -- In-progress multi-step input (registration, custom drink, ...). Not tied to users(id)
  -- because unregistered people have flows too.
  CREATE TABLE pending (
    user_id    TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,

  /* 2: announcements */ `
  -- Announcements published after this moment haven't been shown to the user yet.
  -- Existing users start from "now", so they don't get a backlog.
  ALTER TABLE users ADD COLUMN announcements_seen_at INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET announcements_seen_at = CAST(unixepoch('subsec') * 1000 AS INTEGER);
  `,

  /* 3: full Telegram name for charts */ `
  -- AES-GCM encrypted first + last name; NULL until the user next uses the bot.
  ALTER TABLE users ADD COLUMN full_name_enc TEXT;
  `,

  /* 4: product catalogue (Alkometriikka) */ `
  -- Alko product number when the drink was picked from the catalogue; NULL for presets and
  -- custom drinks.
  ALTER TABLE drinks ADD COLUMN product_id TEXT;
  `,

  /* 5: energy */ `
  -- Estimated energy of the drink (kcal), set when it is logged: from Alko's data for catalogue
  -- drinks, a typical value for presets. NULL when unknown (custom drinks, old imports).
  ALTER TABLE drinks ADD COLUMN kcal INTEGER CHECK (kcal >= 0);
  `,

  /* 6: platform identities */ `
  -- One account can be used from several chat platforms. users.id is now an opaque account id:
  -- existing accounts keep theirs (the Telegram HMAC), new ones get a random id. Each platform
  -- login is an identity pointing at its account, at most one per platform.
  CREATE TABLE identities (
    id          TEXT PRIMARY KEY,                -- HMAC of the platform user id (Crypto.identityKey)
    account_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,                   -- 'telegram', 'discord', ...
    contact_enc TEXT,                            -- AES-GCM encrypted platform user id, only for warning DMs
    created_at  INTEGER NOT NULL,                -- epoch ms
    UNIQUE (account_id, platform)
  ) STRICT;
  INSERT INTO identities (id, account_id, platform, contact_enc, created_at)
    SELECT id, id, 'telegram', tg_id_enc, created_at FROM users;
  ALTER TABLE users DROP COLUMN tg_id_enc;

  -- One-time codes for linking another platform to an account. pending.user_id is an
  -- identity id from now on (typed input belongs to one conversation).
  CREATE TABLE link_codes (
    code_hash  TEXT PRIMARY KEY,                 -- HMAC of the code (Crypto.linkCodeKey)
    account_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL                  -- epoch ms
  ) STRICT;
  `,

  /* 7: chart name choice */ `
  -- Which name /kuvaaja shows for the user: 'full' (Telegram first + last name, as the original
  -- bot did) or 'username' (the name shown in group listings: @username, else full name).
  ALTER TABLE users ADD COLUMN chart_name TEXT NOT NULL DEFAULT 'full' CHECK (chart_name IN ('full', 'username'));
  `,

  /* 8: website sessions */ `
  -- Browser sessions of the website. Only the HMAC of the random token is stored, so a leaked
  -- database can't be used to sign in. They end with the account (cascade) or when revoked.
  CREATE TABLE web_sessions (
    token_hash   TEXT PRIMARY KEY,               -- Crypto.webTokenKey
    account_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_id  TEXT REFERENCES identities(id) ON DELETE CASCADE,  -- the login it came from
    created_at   INTEGER NOT NULL,               -- epoch ms
    last_seen_at INTEGER NOT NULL,               -- epoch ms
    expires_at   INTEGER NOT NULL                -- epoch ms, slides forward while in use
  ) STRICT;
  CREATE INDEX web_sessions_account ON web_sessions (account_id);
  CREATE INDEX web_sessions_expires ON web_sessions (expires_at);

  -- Single-use links the bot's /web command sends, redeemed for a session.
  CREATE TABLE web_login_links (
    token_hash  TEXT PRIMARY KEY,                -- Crypto.webTokenKey
    account_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_id TEXT REFERENCES identities(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL                 -- epoch ms
  ) STRICT;
  CREATE INDEX web_login_links_expires ON web_login_links (expires_at);
  `,

  /* 9: web groups and screen links */ `
  -- Groups made on the website ('web') next to the Telegram chats ('telegram', id = HMAC of the
  -- chat id). The name is encrypted like other names; Telegram groups get theirs from the chat
  -- title when someone says /moro. owner_id is NULL when the owner's account was deleted: the
  -- earliest member then counts as the owner.
  ALTER TABLE groups ADD COLUMN name_enc TEXT;
  ALTER TABLE groups ADD COLUMN kind TEXT NOT NULL DEFAULT 'telegram' CHECK (kind IN ('telegram', 'web'));
  ALTER TABLE groups ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  -- A member can appear as "Nimetön" on shared screens.
  ALTER TABLE group_members ADD COLUMN hide_on_screen INTEGER NOT NULL DEFAULT 0 CHECK (hide_on_screen IN (0, 1));

  -- Invite links of web groups: only the hash of the code is stored, one live invite per group.
  CREATE TABLE group_invites (
    code_hash  TEXT PRIMARY KEY,                 -- Crypto.webTokenKey
    group_id   TEXT NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL                  -- epoch ms
  ) STRICT;

  -- Read-only links for event screens: show one group's (or one person's) live chart without
  -- signing in. Revocable, expiring, only the hash of the token is stored.
  CREATE TABLE screen_tokens (
    token_hash TEXT PRIMARY KEY,                 -- Crypto.webTokenKey
    group_id   TEXT REFERENCES groups(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,                 -- epoch ms
    expires_at INTEGER NOT NULL,                 -- epoch ms
    CHECK ((group_id IS NULL) != (account_id IS NULL))
  ) STRICT;
  CREATE INDEX screen_tokens_group ON screen_tokens (group_id);
  CREATE INDEX screen_tokens_account ON screen_tokens (account_id);
  CREATE INDEX screen_tokens_expires ON screen_tokens (expires_at);
  `,

  /* 10: Telegram group photos on event screens */ `
  -- AES-GCM encrypted Telegram chat id, only so the website can ask Telegram for the group's photo.
  -- Recorded when someone says /moro or uses a command in the group; NULL for web groups.
  ALTER TABLE groups ADD COLUMN chat_enc TEXT;
  `,

  /* 11: user-added barcode products */ `
  -- Products outside Alko's catalogue (grocery-store beers, imports) that users have added for a
  -- barcode Alko doesn't know. Shared: every user scanning the barcode gets the product. Kept in
  -- the bot only, never sent to Alkometriikka. added_by lets the adder fix it; NULL once that
  -- account is deleted (admins can still edit).
  CREATE TABLE custom_products (
    ean        TEXT PRIMARY KEY,                 -- normalised EAN-13 or EAN-8
    kind       TEXT NOT NULL CHECK (kind IN ('olut', 'viini', 'kuohu', 'vakeva')),
    name       TEXT NOT NULL,
    size_l     REAL NOT NULL CHECK (size_l > 0), -- one container
    abv        REAL NOT NULL CHECK (abv > 0 AND abv < 100),
    kcal100    REAL CHECK (kcal100 >= 0),        -- energy per 100 ml, NULL when unknown
    added_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,                 -- epoch ms
    updated_at INTEGER NOT NULL                  -- epoch ms
  ) STRICT;
  CREATE INDEX custom_products_added_by ON custom_products (added_by);
  `,

  /* 12: error reports on user-added products */ `
  -- "Ilmoita virheestä": a user tells the admins a user-added product is wrong. One open report per
  -- user and product (reporting again replaces the message). Gone when an admin marks it handled,
  -- the product is deleted, or the reporter's account is deleted. Admins see the message, not who sent it.
  CREATE TABLE custom_product_reports (
    ean         TEXT NOT NULL REFERENCES custom_products(ean) ON DELETE CASCADE,
    reported_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,                -- epoch ms
    PRIMARY KEY (ean, reported_by)
  ) STRICT;
  CREATE INDEX custom_product_reports_by ON custom_product_reports (reported_by);
  `,

  /* 13: "muu" kind for user-added products (mixed drinks, RTDs) */ `
  -- The kind CHECK can't be altered, so the table is rebuilt. The reports are set aside first
  -- because dropping custom_products would cascade-delete them.
  CREATE TEMP TABLE reports_keep AS SELECT * FROM custom_product_reports;
  DROP TABLE custom_product_reports;
  ALTER TABLE custom_products RENAME TO custom_products_old;
  DROP INDEX custom_products_added_by;
  CREATE TABLE custom_products (
    ean        TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('olut', 'viini', 'kuohu', 'vakeva', 'muu')),
    name       TEXT NOT NULL,
    size_l     REAL NOT NULL CHECK (size_l > 0),
    abv        REAL NOT NULL CHECK (abv > 0 AND abv < 100),
    kcal100    REAL CHECK (kcal100 >= 0),
    added_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO custom_products SELECT * FROM custom_products_old;
  DROP TABLE custom_products_old;
  CREATE INDEX custom_products_added_by ON custom_products (added_by);
  CREATE TABLE custom_product_reports (
    ean         TEXT NOT NULL REFERENCES custom_products(ean) ON DELETE CASCADE,
    reported_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (ean, reported_by)
  ) STRICT;
  CREATE INDEX custom_product_reports_by ON custom_product_reports (reported_by);
  INSERT INTO custom_product_reports SELECT * FROM reports_keep;
  DROP TABLE reports_keep;
  `,
  /* 14: favourite drinks (a snapshot of a logged drink, so they outlive it) */ `
  CREATE TABLE favorites (
    id          INTEGER PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    alcohol_mg  INTEGER NOT NULL,
    product_id  TEXT,
    kcal        INTEGER,
    created_at  INTEGER NOT NULL,
    UNIQUE (user_id, description, alcohol_mg)
  ) STRICT;
  `,
];

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Runs the pending migrations, up to `target` (tests use it to build an old schema). */
export function migrate(db: Database, target = MIGRATIONS.length): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = current; v < target; v += 1) {
    db.transaction(() => {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
