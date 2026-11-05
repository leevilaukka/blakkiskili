# Bläkkiskili operations runbook

For the maintainers. The bot stores health-related personal data: alcohol use linked to Telegram accounts. Treat the server and its secrets accordingly.

## 0. People and secrets

At least **two maintainers**, so the bot never depends on one person. Keep everything below in a shared password manager vault (e.g. Bitwarden or 1Password) that only the maintainers can open:

| Secret | Where it's used | If lost | If leaked |
|---|---|---|---|
| `BOT_TOKEN` | `.env` | Get a new one from BotFather | `/revoke` in BotFather, update `.env` |
| `APP_SECRET` | `.env` | **All data unreachable, for good** | Data in a leaked DB/backup becomes readable. See §6 |
| `RESTIC_PASSWORD` | `backup.env` | **Backups can't be restored** | Rotate (`restic key add` / `key remove`) |
| Object storage key | `backup.env` | Create a new one | Delete it in the provider console |
| SSH private keys | maintainers' laptops | Use the other maintainer's key | Remove it from `~/.ssh/authorized_keys` |

Turn on **2FA** for:
- the hosting account,
- the object storage account,
- the password manager,
- the **Telegram account that owns the bot** in BotFather: Telegram → Settings → Privacy → Two-Step Verification.

Never put `APP_SECRET` in the same place as the backups. Backups are only safe because they're useless without it.

## 1. Server

1. Create an Ubuntu 24.04 VPS in Finland or elsewhere in the EU (e.g. Hetzner Helsinki or UpCloud Helsinki). The smallest size is enough.
2. Paste [`cloud-init.yml`](cloud-init.yml) as user data, after replacing the SSH keys in it. It sets up:
   - a `kili` user with key-only SSH, and root login disabled,
   - a firewall that allows only SSH inbound,
   - automatic security updates with reboots at 04:30,
   - fail2ban and Docker.
3. If the provider has a cloud firewall, allow only TCP 22 inbound there too. Optionally allow it only from your Tailscale/WireGuard network.
4. Check: `ssh kili@<ip>` works, while `ssh root@<ip>` and password login are refused, and `sudo ufw status` shows only OpenSSH.

## 2. Off-site backup storage

1. Create an S3-compatible bucket **in the EU** (Hetzner Object Storage, UpCloud Object Storage, Backblaze B2 EU, …). Keep it private and turn on versioning or object lock if offered.
2. Create an access key that can reach **only this bucket**.
3. Optional: create a free check at healthchecks.io with period 6 h and grace 12 h, and put its ping URL in `BACKUP_PING_URL`. You get an email when backups stop or fail.

## 3. Deploy

```sh
ssh kili@<ip>
git clone <repo-url> ~/blakkiskili && cd ~/blakkiskili
cp .env.example .env && cp backup.env.example backup.env
chmod 600 .env backup.env
nano .env          # BOT_TOKEN, APP_SECRET (openssl rand -base64 48), ADMIN_IDS, COMPOSE_PROFILES=backup
nano backup.env    # RESTIC_REPOSITORY, keys, RESTIC_PASSWORD (openssl rand -base64 48), BACKUP_PING_URL
mkdir -m 700 data backups && sudo chown 1000:1000 data backups
docker compose up -d --build
docker compose logs -f
```

You should see:
- `@<bot> started (long polling)` in the `kili` logs,
- within about 6 h, `backup ok` in the `backup` logs.

To test right away, run `docker compose restart backup` after the first snapshot has been written. That happens about 10 s after start.

In BotFather, enable `/setinline` and `/setinlinefeedback` (see the README) so Alko search works as you type.

`ADMIN_IDS` (your numeric Telegram IDs) receive a DM when a backup snapshot or the inactivity job fails.

## 4. Restore drill: do it once now, then every semester

A backup you've never restored isn't a backup.

```sh
cd ~/blakkiskili
docker compose run --rm --entrypoint restic backup snapshots
mkdir -p restore && sudo chown 1000:1000 restore
docker compose run --rm --entrypoint restic -v ./restore:/restore backup restore latest --target /restore
sqlite3 restore/backups/kili-snapshot.sqlite "PRAGMA integrity_check; SELECT count(*) FROM users;"
```

**Real restore** (e.g. a new server):
1. Set up §1–3 with the **same** `APP_SECRET` and `backup.env`.
2. `docker compose stop kili`
3. `rm -f data/kili.sqlite*`
4. `cp restore/backups/kili-snapshot.sqlite data/kili.sqlite && sudo chown 1000:1000 data/kili.sqlite`
5. `docker compose start kili`

Delete `restore/` when done. It contains the whole database.

## 5. Routine

- **Updates:** `git pull && docker compose up -d --build`. The OS patches itself.
- **Telling users about an update:** add an entry to `src/announcements.ts` before deploying. Users see it once, privately, on their next interaction.
- **Dependencies:** run `bun audit` and `bun outdated` now and then, and before deploys.
- **Who has access:** check `~/.ssh/authorized_keys` and the vault members when maintainers change, and remove people who have left.
- **Retention:** accounts are deleted after 24 months of inactivity, and backups keep 7 daily, 4 weekly and 3 monthly snapshots. The privacy text promises "about 3 months" for backups. If you change the policy in `deploy/backup.sh`, update `src/strings.ts` too.

## 6. If something goes wrong

**Suspected compromise** (unknown SSH login, strange processes, leaked `.env`):
1. `docker compose down`. If the server itself is suspect, power it off from the provider console.
2. Revoke the bot token in BotFather. Rotate the object storage key and `RESTIC_PASSWORD`.
3. Work out what leaked. If the database or a backup leaked **together with** `APP_SECRET`, names and platform user IDs (Telegram, and any linked platform) can be decrypted.
4. **GDPR:** a breach that risks people's rights must be reported to the Data Protection Ombudsman (tietosuoja.fi) **within 72 hours** of finding out, and users must be told when the risk is high. Write down what happened and when, even if you decide not to report.
5. Rebuild on a fresh server from §1 and restore from a backup taken before the compromise.

**Backups failing** (healthchecks email or admin DM): check `docker compose logs backup`. Usual causes are an expired or rotated key, a full bucket, or the bot being down, which shows as "snapshot is older than…".

**Lost `APP_SECRET`:** the data can't be recovered, by design. Start fresh, and tell users they can re-import their `/data` exports.
