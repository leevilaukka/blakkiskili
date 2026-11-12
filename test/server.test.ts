// The real HTTP server (not just the request handler): things only Bun.serve does, like closing
// idle connections, are invisible to the other web tests.

import { afterEach, describe, expect, test } from "bun:test";
import { findPreset } from "../src/lib/catalog.ts";
import { MINUTE_MS } from "../src/lib/units.ts";
import { startWebServer } from "../src/web/server.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { setup, tg } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: { shutdown(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.shutdown();
});

/** Reads server-sent events; `next` gives null when nothing arrives in time, `closed` when the server hung up. */
function events(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let closed = false;
  // A read that timed out is still pending; the next call must wait on that same read or it would swallow the chunk.
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
  return {
    get closed() {
      return closed;
    },
    async next(timeoutMs = 1000): Promise<any | null> {
      for (;;) {
        const end = buf.indexOf("\n\n");
        if (end >= 0) {
          const raw = buf.slice(0, end);
          buf = buf.slice(end + 2);
          if (!raw.includes("event:")) continue; // a keepalive comment
          return { event: /event: (\w+)/.exec(raw)![1], data: JSON.parse(/data: (.*)/.exec(raw)![1]!) };
        }
        pending ??= r.read().catch(() => ({ done: true, value: undefined }));
        const chunk = await Promise.race([pending, sleep(timeoutMs).then(() => null)]);
        if (chunk === null) return null;
        pending = null;
        if (chunk.done) {
          closed = true;
          return null;
        }
        buf += dec.decode(chunk.value!);
      }
    },
    cancel: () => r.cancel().catch(() => {}),
  };
}

describe("live streams on the real server", () => {
  test("every kind of stream outlives Bun's idle timeout", async () => {
    const w = setup();
    const alice = w.services.accounts.register(tg(1), { name: "alice", fullName: "Alice", weight: 70, height: 170, gender: "nainen" }).profile;
    const group = w.services.groups.createWeb(alice.id, "Bileet");
    if (group === "limit") throw new Error("unexpected");
    const link = w.services.screens.create({ groupId: group.id }, alice.id);
    if (link === "limit") throw new Error("unexpected");

    const config: Config = { ...loadConfig(), botToken: "0:x", web: { enabled: true, origin: "http://localhost", port: 0, distDir: "/nonexistent" } };
    // A 1 s idle timeout and a tick much slower than that: without the timeout switched off for
    // streams, the server hangs up long before the first tick.
    const server = startWebServer({ config, services: w.services, botUsername: "b", idleTimeout: 1, live: { tickMs: 60_000, minGapMs: 10 } });
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const session = w.services.webSessions.createSession(alice.id, null).sessionToken;

    const open = await fetch(`${base}/api/screen/open`, {
      method: "POST",
      headers: { origin: "http://localhost", "x-kili": "1", "content-type": "application/json" },
      body: JSON.stringify({ token: link.token }),
    });
    const screenCookie = open.headers.get("set-cookie")!.split(";")[0]!;

    const open_ = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } }).then(events);
    // One after the other, each left silent for longer than the idle timeout, the way pages are
    // opened in real life (that is when the group page and the screen were cut off).
    const all: Record<string, ReturnType<typeof events>> = {};
    for (const [name, path, cookie] of [
      ["mine", "/api/events", `kili=${session}`],
      ["groupPage", `/api/groups/${group.id}/events`, `kili=${session}`],
      ["screen", "/api/screen/events", screenCookie],
    ] as const) {
      all[name] = await open_(path, cookie);
      expect((await all[name]!.next())?.event, name).toBe("update");
      await sleep(1800); // past the 1 s idle timeout, with no tick or change in sight
      expect(await all[name]!.next(100), name).toBeNull(); // nothing new to say...
      expect(all[name]!.closed, `${name} stream was closed by the server`).toBe(false); // ...but still connected
    }

    w.services.drinks.add(alice.id, findPreset("b50")!.mg, "x", { at: w.clock.now - 10 * MINUTE_MS });
    for (const [name, s] of Object.entries(all)) {
      const update = await s.next(2000);
      expect(s.closed, `${name} stream was closed by the server`).toBe(false);
      expect(update?.event, name).toBe("update");
    }
    for (const s of Object.values(all)) await s.cancel();
  }, 15_000);
});
