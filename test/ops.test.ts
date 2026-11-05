import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { createAdminAlerts } from "../src/bot/admin.ts";
import { RateLimiter } from "../src/bot/ratelimit.ts";
import type { Config } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { SNAPSHOT_NAME, writeSnapshot } from "../src/ops/backup.ts";
import { startJobs } from "../src/ops/scheduler.ts";

describe("backup snapshot", () => {
  test("writes a consistent, private copy of the live WAL database", () => {
    const dir = mkdtempSync(join(tmpdir(), "kili-test-"));
    try {
      const db = openDatabase(join(dir, "live.sqlite"));
      db.run("INSERT INTO groups (id, created_at) VALUES ('g1', 1)");
      const out = writeSnapshot(db, join(dir, "backups"));
      db.run("INSERT INTO groups (id, created_at) VALUES ('g2', 2)"); // after the snapshot

      expect(out).toBe(join(dir, "backups", SNAPSHOT_NAME));
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "backups")).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(dir, "backups"))).toEqual([SNAPSHOT_NAME]); // no temp file left

      const copy = new Database(out, { readonly: true });
      expect(copy.query("SELECT id FROM groups").all()).toEqual([{ id: "g1" }]);
      expect(copy.query("PRAGMA user_version").get()).toEqual(db.query("PRAGMA user_version").get() as object);
      copy.close();

      writeSnapshot(db, join(dir, "backups")); // replaces the previous one
      const copy2 = new Database(out, { readonly: true });
      expect(copy2.query("SELECT count(*) AS n FROM groups").get()).toEqual({ n: 2 });
      copy2.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rate limiter", () => {
  test("allows the limit, warns once, then drops until the window resets", () => {
    const clock = { now: 0 };
    const rl = new RateLimiter(3, 60_000, () => clock.now);
    expect([1, 2, 3].map(() => rl.hit(7))).toEqual(["ok", "ok", "ok"]);
    expect(rl.hit(7)).toBe("warn");
    expect(rl.hit(7)).toBe("drop");
    expect(rl.hit(8)).toBe("ok"); // per user
    clock.now += 60_000;
    expect(rl.hit(7)).toBe("ok");
  });
});

describe("admin alerts", () => {
  test("messages every admin, at most once per cooldown per key", async () => {
    const sent: { id: number; text: string }[] = [];
    const api = { sendMessage: async (id: number, text: string) => void sent.push({ id, text }) } as unknown as Api;
    const clock = { now: 0 };
    const origError = console.error;
    console.error = () => {};
    try {
      const alert = createAdminAlerts(api, { adminIds: [1, 2] } as Config, 1000, () => clock.now);
      await alert("backup snapshot", "disk <full>");
      await alert("backup snapshot", "again");
      await alert("other", "x");
      clock.now += 1000;
      await alert("backup snapshot", "later");
    } finally {
      console.error = origError;
    }
    expect(sent.map((s) => s.id)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(sent[0]!.text).toContain("disk &lt;full&gt;");
    expect(sent[4]!.text).toContain("later");
  });
});

describe("scheduler", () => {
  test("runs jobs, reports errors and never overlaps a slow run", async () => {
    let runs = 0;
    const errors: string[] = [];
    let release!: () => void;
    const stop = startJobs(
      [
        { name: "slow", everyMs: 5, firstDelayMs: 0, run: () => { runs += 1; return new Promise<void>((r) => (release = r)); } },
        { name: "broken", everyMs: 1000, firstDelayMs: 0, run: () => { throw new Error("boom"); } },
      ],
      (job, err) => errors.push(`${job}: ${(err as Error).message}`),
    );
    await Bun.sleep(40);
    expect(runs).toBe(1);
    expect(errors).toEqual(["broken: boom"]);
    release();
    await Bun.sleep(20);
    expect(runs).toBeGreaterThan(1);
    stop();
    release();
  });
});
