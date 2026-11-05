// Consistent online snapshots of the SQLite database.
//
// VACUUM INTO writes a complete, defragmented copy of the live database in one read
// transaction, so it is safe while the bot is running (copying the .sqlite/-wal files is not).
// The snapshot is written to a temp file, integrity-checked, then atomically renamed, so the
// off-site backup job never picks up a half-written file. Off-site copies and history are
// handled by restic (see deploy/backup.sh); this keeps only the latest snapshot locally.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_NAME = "kili-snapshot.sqlite";

export function writeSnapshot(db: Database, dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, SNAPSHOT_NAME);
  const tmp = join(dir, `.${SNAPSHOT_NAME}.tmp`);
  rmSync(tmp, { force: true });

  db.run("VACUUM INTO ?", [tmp]);
  chmodSync(tmp, 0o600);

  const check = new Database(tmp, { readonly: true });
  try {
    const { integrity_check } = check.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity_check !== "ok") throw new Error(`Snapshot integrity check failed: ${integrity_check}`);
  } finally {
    check.close();
  }

  renameSync(tmp, target);
  return target;
}
