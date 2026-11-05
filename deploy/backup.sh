#!/bin/sh
# Off-site backup loop (runs in the `backup` compose service as uid 1000).
#
# The bot writes a consistent snapshot to /backups/kili-snapshot.sqlite (see src/ops/backup.ts).
# This ships it to a restic repository: encrypted client-side with RESTIC_PASSWORD before
# upload, deduplicated, with a retention policy. Optionally pings a dead-man's switch
# (e.g. healthchecks.io) so a silently broken backup gets noticed.
#
# Retention: 7 daily, 4 weekly, 3 monthly snapshots. Deleted accounts therefore disappear
# from backups within ~3 months; the privacy text in src/strings.ts says so. Keep them in sync.
set -u

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in backup.env}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in backup.env}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
MAX_AGE_MIN="${BACKUP_MAX_SNAPSHOT_AGE_MINUTES:-180}"
SNAPSHOT=/backups/kili-snapshot.sqlite

ping() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  wget -q -T 10 -O /dev/null "${BACKUP_PING_URL}$1" || echo "warning: could not ping $BACKUP_PING_URL$1"
}

if ! restic cat config >/dev/null 2>&1; then
  echo "No restic repository found at $RESTIC_REPOSITORY, initialising"
  restic init || { echo "restic init failed (wrong password or unreachable repository?)"; exit 1; }
fi

while true; do
  if [ ! -s "$SNAPSHOT" ]; then
    echo "$(date -Iseconds) FAILED: no snapshot at $SNAPSHOT (is BACKUP_DIR set for the bot?)"
    ping /fail
  elif [ -z "$(find "$SNAPSHOT" -mmin "-$MAX_AGE_MIN")" ]; then
    echo "$(date -Iseconds) FAILED: snapshot is older than $MAX_AGE_MIN minutes, the bot isn't writing new ones"
    ping /fail
  elif restic backup --quiet --host kili --tag db "$SNAPSHOT" \
    && restic forget --quiet --host kili --tag db --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune \
    && restic check --quiet; then
    echo "$(date -Iseconds) backup ok"
    ping ""
  else
    echo "$(date -Iseconds) FAILED: restic error, see above"
    ping /fail
  fi
  sleep "$INTERVAL"
done
