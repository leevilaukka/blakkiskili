import { afterEach, describe, expect, test } from "bun:test";
import { findPreset } from "../src/lib/catalog.ts";
import { ChangeBus } from "../src/services/changebus.ts";
import { createWebApp } from "../src/web/app.ts";
import { Hub } from "../src/web/sse.ts";
import { isEventStream } from "../src/web/server.ts";
import { setup, tg } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "https://kili.test";

describe("ChangeBus", () => {
  test("delivers to listeners, stops after unsubscribe, survives a throwing listener", () => {
    const bus = new ChangeBus();
    const seen: string[] = [];
    const off = bus.subscribe((c) => seen.push(`a:${c.accountId}`));
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((c) => seen.push(`c:${c.accountId}`));
    const log = console.error;
    console.error = () => {};
    bus.emit({ accountId: "x" });
    off();
    bus.emit({ accountId: "y" });
    console.error = log;
    expect(seen).toEqual(["a:x", "c:x", "c:y"]);
  });

  test("services announce every change to an account", () => {
    const { services } = setup();
    const a = services.accounts.register(tg(1), { name: "a", weight: 70, height: 170, gender: "mies" }).profile;
    const seen: (string | undefined)[] = [];
    services.bus.subscribe((c) => seen.push(c.accountId));
    const d = services.drinks.add(a.id, 10_000, "x");
    services.drinks.undoLast(a.id);
    services.drinks.add(a.id, 10_000, "y");
    services.drinks.delete(a.id, services.drinks.last(a.id)!.id);
    services.drinks.delete(a.id, 999_999); // nothing deleted, nothing announced
    services.accounts.updateWeight(a.id, 71);
    services.accounts.updateChartName(a.id, "username");
    services.groups.join(a.id, -100);
    services.groups.leave(a.id, -100);
    services.accounts.delete(a.id);
    expect(d.id).toBeGreaterThan(0);
    expect(seen).toHaveLength(9);
    expect(seen.every((id) => id === a.id)).toBe(true);
  });
});

describe("Hub", () => {
  function hub(over: Partial<ConstructorParameters<typeof Hub>[0]> = {}) {
    const bus = new ChangeBus();
    let version = 0;
    const h = new Hub({
      bus,
      tickMs: 1_000_000,
      minGapMs: 20,
      render: (channel) => (channel === "gone" ? null : { channel, version: ++version }),
      channelsFor: (c, watched) => (c.accountId ? watched.filter((w) => w === `u:${c.accountId}`) : []),
      ...over,
    });
    return { bus, h };
  }
  const parse = (text: string) => ({ event: /event: (\w+)/.exec(text)?.[1], data: JSON.parse(/data: (.*)/.exec(text)![1]!) });

  test("sends the current data first, then again when the channel changes", async () => {
    const { bus, h } = hub();
    const got: string[] = [];
    h.subscribe("u:1", "1", (t) => got.push(t));
    expect(parse(got[0]!)).toEqual({ event: "update", data: { channel: "u:1", version: 1 } });
    bus.emit({ accountId: "1" });
    await sleep(60);
    expect(got).toHaveLength(2);
    expect(parse(got[1]!).data.version).toBe(2);
    h.close();
  });

  test("changes elsewhere do not wake this channel", async () => {
    const { bus, h } = hub();
    const got: string[] = [];
    h.subscribe("u:1", "1", (t) => got.push(t));
    bus.emit({ accountId: "2" });
    await sleep(60);
    expect(got).toHaveLength(1);
    h.close();
  });

  test("a burst of changes becomes one push, rendered once for all viewers", async () => {
    let renders = 0;
    const { bus, h } = hub({ render: () => ({ n: ++renders }) });
    const a: string[] = [];
    const b: string[] = [];
    h.subscribe("u:1", "1", (t) => a.push(t));
    h.subscribe("u:1", "2", (t) => b.push(t)); // second viewer of the same channel
    expect(renders).toBe(2); // each newcomer gets the current data
    for (let i = 0; i < 20; i += 1) bus.emit({ accountId: "1" });
    await sleep(80);
    expect(renders).toBe(3); // 20 changes, one render
    expect(a.at(-1)).toBe(b.at(-1)); // the same text goes to everyone
    h.close();
  });

  test("ticks while somebody watches, and stops when nobody does", async () => {
    const { h } = hub({ tickMs: 30 });
    const got: string[] = [];
    const stop = h.subscribe("u:1", "1", (t) => got.push(t))!;
    await sleep(110);
    expect(got.length).toBeGreaterThanOrEqual(3);
    stop();
    const n = got.length;
    await sleep(100);
    expect(got).toHaveLength(n);
    expect(h.viewers).toBe(0);
    h.close();
  });

  test("sends a keepalive comment to every viewer while anyone watches, and stops after", async () => {
    const { h } = hub({ keepAliveMs: 25 });
    const a: string[] = [];
    const b: string[] = [];
    const stop = h.subscribe("u:1", "1", (t) => a.push(t))!;
    h.subscribe("u:2", "2", (t) => b.push(t));
    await sleep(90);
    for (const got of [a, b]) {
      const comments = got.filter((t) => t === ": keepalive\n\n");
      expect(comments.length).toBeGreaterThanOrEqual(2);
      expect(got.some((t) => t.startsWith("event: update"))).toBe(true); // the initial data is still there
    }
    stop();
    const n = a.length;
    await sleep(70);
    expect(a).toHaveLength(n); // gone viewers get nothing
    h.close();
  });

  test("limits per owner and in total, freed when a viewer leaves", () => {
    const { h } = hub({ maxPerOwner: 2, maxTotal: 3 });
    const stops = [h.subscribe("u:1", "a", () => {}), h.subscribe("u:1", "a", () => {})];
    expect(h.subscribe("u:1", "a", () => {})).toBeNull(); // owner a is full
    expect(h.subscribe("u:2", "b", () => {})).not.toBeNull();
    expect(h.subscribe("u:3", "c", () => {})).toBeNull(); // 3 in total
    stops[0]!();
    expect(h.subscribe("u:3", "c", () => {})).not.toBeNull();
    h.close();
  });

  test("a channel that no longer exists is announced as ended", () => {
    const { h } = hub();
    const got: string[] = [];
    h.subscribe("gone", "1", (t) => got.push(t));
    expect(got[0]).toContain("event: end");
    h.close();
  });

  test("a viewer whose connection died is dropped without hurting the others", async () => {
    const { bus, h } = hub();
    const ok: string[] = [];
    h.subscribe("u:1", "1", () => {});
    h.subscribe("u:1", "2", (t) => ok.push(t));
    expect(h.viewers).toBe(2);
    // second subscribe's first delivery succeeded; now make the first viewer throw on the next push
    const dead = hub();
    let calls = 0;
    dead.h.subscribe("u:1", "1", () => {
      if (++calls > 1) throw new Error("closed");
    });
    dead.h.subscribe("u:1", "2", (t) => ok.push(t));
    dead.bus.emit({ accountId: "1" });
    await sleep(60);
    expect(dead.h.viewers).toBe(1);
    expect(ok.length).toBeGreaterThanOrEqual(2);
    bus.emit({ accountId: "1" });
    h.close();
    dead.h.close();
  });
});

describe("which routes are long-lived streams", () => {
  const id = "a".repeat(32);
  test("exactly the event streams, which must be exempt from the server's idle timeout", () => {
    for (const path of ["/api/events", "/api/screen/events", `/api/groups/${id}/events`, `/api/groups/${"b".repeat(64)}/events`]) {
      expect(isEventStream(path), path).toBe(true);
    }
    for (const path of ["/api/events/", "/api/screen", "/api/groups", `/api/groups/${id}`, `/api/groups/${id}/events/x`, "/api/groups/zz/events", "/events", "/api/dashboard"]) {
      expect(isEventStream(path), path).toBe(false);
    }
  });
});

describe("GET /api/events", () => {
  const apps: ReturnType<typeof createWebApp>[] = [];
  afterEach(() => {
    for (const a of apps.splice(0)) a.close();
  });

  function world(live = { tickMs: 1_000_000, minGapMs: 10 }) {
    const w = setup();
    const alice = w.services.accounts.register(tg(1), { name: "alice", weight: 70, height: 170, gender: "nainen" }).profile;
    const app = createWebApp({ services: w.services, botToken: "1:x", botUsername: "b", origin: ORIGIN, live });
    apps.push(app);
    const cookie = `__Host-kili=${w.services.webSessions.createSession(alice.id, null).sessionToken}`;
    const open = (c = cookie) => app(new Request(`${ORIGIN}/api/events`, { headers: { cookie: c } }), "1.1.1.1");
    return { ...w, alice, app, cookie, open };
  }

  /** Reads server-sent events from a response body. */
  function reader(res: Response) {
    const r = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    return {
      async next(timeoutMs = 500): Promise<{ event: string; data: any } | null> {
        for (;;) {
          const end = buf.indexOf("\n\n");
          if (end >= 0) {
            const raw = buf.slice(0, end);
            buf = buf.slice(end + 2);
            return { event: /event: (\w+)/.exec(raw)![1]!, data: JSON.parse(/data: (.*)/.exec(raw)![1]!) };
          }
          const chunk = await Promise.race([r.read(), sleep(timeoutMs).then(() => null)]);
          if (chunk === null) return null;
          if (chunk.done) return null;
          buf += dec.decode(chunk.value);
        }
      },
      cancel: () => r.cancel(),
    };
  }

  test("needs a session", async () => {
    const { open } = world();
    expect((await open("__Host-kili=nope")).status).toBe(401);
  });

  test("streams the dashboard, then a new one whenever the account changes, from any source", async () => {
    const { open, services, alice, clock } = world();
    const res = await open();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const events = reader(res);

    const first = await events.next();
    expect(first?.event).toBe("update");
    expect(first!.data.me.name).toBe("alice");
    expect(first!.data.session.drinks).toHaveLength(0);

    // A drink logged through the services, as the bot does, reaches the open page.
    services.drinks.add(alice.id, findPreset("b33a")!.mg, "bot beer", { kcal: 100, at: clock.now - 10 * 60_000 });
    const second = await events.next();
    expect(second!.data.session.drinks.map((d: any) => d.description)).toEqual(["bot beer"]);
    expect(second!.data.permille).toBeGreaterThan(0);

    services.accounts.updateChartName(alice.id, "username");
    expect((await events.next())!.data.me.chartLabel).toBe("alice");
    await events.cancel();
  });

  test("nobody else's changes arrive", async () => {
    const { open, services } = world();
    const bob = services.accounts.register(tg(2), { name: "bob", weight: 90, height: 185, gender: "mies" }).profile;
    const events = reader(await open());
    await events.next();
    services.drinks.add(bob.id, 20_000, "bob's");
    expect(await events.next(150)).toBeNull();
    await events.cancel();
  });

  test("keeps updating with the clock when nothing is logged", async () => {
    const { open, services, alice, clock } = world({ tickMs: 30, minGapMs: 10 });
    services.drinks.add(alice.id, findPreset("b50")!.mg, "beer", { at: clock.now - 10 * 60_000 });
    const events = reader(await open());
    const first = (await events.next())!.data.permille;
    expect(first).toBeGreaterThan(0.2);
    clock.now += 3 * 60 * 60_000; // three hours pass with nothing logged
    const later = (await events.next())!.data.permille;
    expect(later).toBe(0);
    await events.cancel();
  });

  test("an account deleted while watching ends the stream", async () => {
    const { open, services, alice } = world();
    const events = reader(await open());
    await events.next();
    services.accounts.delete(alice.id);
    expect((await events.next())?.event).toBe("end");
    await events.cancel();
  });

  test("limits the streams per account and frees them when the page goes away", async () => {
    const { open, app } = world({ tickMs: 1_000_000, minGapMs: 10, maxPerOwner: 2 } as any);
    const a = reader(await open());
    const b = reader(await open());
    await a.next();
    expect(app.viewers()).toBe(2);
    expect((await open()).status).toBe(429);
    await a.cancel();
    await sleep(20);
    expect(app.viewers()).toBe(1);
    expect((await open()).status).toBe(200);
    await b.cancel();
  });
});
