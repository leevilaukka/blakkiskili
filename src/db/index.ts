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
