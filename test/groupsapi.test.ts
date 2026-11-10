import { afterEach, describe, expect, test } from "bun:test";
import { findPreset } from "../src/lib/catalog.ts";
import { HOUR_MS, MINUTE_MS } from "../src/lib/units.ts";
import { GroupPhotos } from "../src/web/photos.ts";
import { serveTestApp, setup, tg } from "./helpers.ts";

const ORIGIN = "https://kili.test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const apps: ReturnType<typeof serveTestApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

function world(extra: { groupPhotos?: GroupPhotos } = {}) {
  const w = setup();
  const user = (id: number, name: string, full?: string) =>
    w.services.accounts.register(tg(id), { name, fullName: full, weight: 75, height: 178, gender: "mies" }).profile;
  const alice = user(1, "alice", "Alice Aalto");
  const bob = user(2, "bob", "Bob Berg");
  const carol = user(3, "carol", "Carol Cederberg");
  const app = serveTestApp({ services: w.services, botToken: "1:x", botUsername: "b", origin: ORIGIN, live: { tickMs: 1_000_000, minGapMs: 10 }, groupPhotos: extra.groupPhotos });
  apps.push(app);
  const cookies = new Map<string, string>();
  const as = (p: { id: string }) => {
    if (!cookies.has(p.id)) cookies.set(p.id, `__Host-kili=${w.services.webSessions.createSession(p.id, null).sessionToken}`);
    return cookies.get(p.id)!;
  };
  const call = (method: string, path: string, opts: { as?: { id: string }; cookie?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    const cookie = opts.cookie ?? (opts.as ? as(opts.as) : undefined);
    if (cookie) headers.cookie = cookie;
    if (method !== "GET") Object.assign(headers, { origin: ORIGIN, "x-kili": "1" });
    return app(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), "1.1.1.1");
  };
  const json = async (res: Response) => (await res.json()) as any;
  // alice owns a web group that bob has joined through an invite
  async function party() {
    const g = await json(await call("POST", "/api/groups", { as: alice, body: { name: "Bileet" } }));
    const invite = await json(await call("POST", `/api/groups/${g.id}/invite`, { as: alice }));
    await call("POST", "/api/groups/join", { as: bob, body: { code: invite.code } });
    return { id: g.id as string, code: invite.code as string };
  }
  return { ...w, alice, bob, carol, app, call, json, party, as };
}

describe("groups API", () => {
  test("create, invite, join, list", async () => {
    const { call, json, alice, bob, carol } = world();
    const created = await call("POST", "/api/groups", { as: alice, body: { name: "  Mökki  2026 " } });
    expect(created.status).toBe(201);
    const g = await json(created);
    expect(g).toMatchObject({ name: "Mökki 2026", kind: "web", memberCount: 1, isOwner: true, hideOnScreen: false });

    const invite = await json(await call("POST", `/api/groups/${g.id}/invite`, { as: alice }));
    expect(invite.code.length).toBeGreaterThan(16);

    expect(await json(await call("POST", "/api/groups/join", { as: bob, body: { code: invite.code } }))).toEqual({ id: g.id });
    expect((await call("POST", "/api/groups/join", { as: bob, body: { code: invite.code } })).status).toBe(409);
    expect((await call("POST", "/api/groups/join", { as: carol, body: { code: "nope" } })).status).toBe(404);

    const list = await json(await call("GET", "/api/groups", { as: bob }));
    expect(list.groups).toEqual([{ id: g.id, name: "Mökki 2026", kind: "web", memberCount: 2, isOwner: false, hideOnScreen: false }]);
    expect((await json(await call("GET", "/api/groups", { as: carol }))).groups).toEqual([]);
  });

  test("bad names and the group limit", async () => {
    const { call, alice } = world();
    for (const name of ["", "   ", "x".repeat(41), 5, null]) expect((await call("POST", "/api/groups", { as: alice, body: { name } })).status).toBe(422);
    for (let i = 0; i < 10; i += 1) await call("POST", "/api/groups", { as: alice, body: { name: `g${i}` } });
    expect((await call("POST", "/api/groups", { as: alice, body: { name: "eleventh" } })).status).toBe(409);
  });

  test("strangers can't tell a group exists", async () => {
    const { call, party, carol } = world();
    const { id } = await party();
    const probes: [string, string][] = [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/leave"], ["POST", "/invite"], ["POST", "/screens"], ["GET", "/events"], ["PATCH", "/me"]];
    for (const [method, sub] of probes) {
      const res = await call(method, `/api/groups/${id}${sub}`, { as: carol, body: { name: "x", hideOnScreen: true } });
      expect(res.status).toBe(404);
    }
    expect((await call("GET", `/api/groups/${"0".repeat(32)}`, { as: carol })).status).toBe(404);
  });

  test("only the owner manages the group", async () => {
    const { call, json, party, bob, alice } = world();
    const { id } = await party();
    expect((await call("PATCH", `/api/groups/${id}`, { as: bob, body: { name: "Mine" } })).status).toBe(403);
    expect((await call("DELETE", `/api/groups/${id}`, { as: bob })).status).toBe(403);
    expect((await call("POST", `/api/groups/${id}/invite`, { as: bob })).status).toBe(403);

    const view = await json(await call("GET", `/api/groups/${id}`, { as: bob }));
    expect(view.inviteExpiresAt).toBeNull(); // members don't see invite details
    const aliceRef = view.members.find((m: any) => m.name === "Alice Aalto").ref;
    expect((await call("DELETE", `/api/groups/${id}/members/${aliceRef}`, { as: bob })).status).toBe(403);

    expect((await call("PATCH", `/api/groups/${id}`, { as: alice, body: { name: "Uusi nimi" } })).status).toBe(200);
    const ownerView = await json(await call("GET", `/api/groups/${id}`, { as: alice }));
    expect(ownerView.group.name).toBe("Uusi nimi");
    expect(ownerView.inviteExpiresAt).toBeGreaterThan(0);
  });

  test("the owner can remove others, not themself; anyone can leave; the last one out deletes", async () => {
    const { call, json, party, alice, bob } = world();
    const { id } = await party();
    const view = await json(await call("GET", `/api/groups/${id}`, { as: alice }));
    const me = view.members.find((m: any) => m.isMe).ref;
    const other = view.members.find((m: any) => !m.isMe).ref;
    expect((await call("DELETE", `/api/groups/${id}/members/${me}`, { as: alice })).status).toBe(400);
    expect((await call("DELETE", `/api/groups/${id}/members/${"f".repeat(16)}`, { as: alice })).status).toBe(404);
    expect((await call("DELETE", `/api/groups/${id}/members/${other}`, { as: alice })).status).toBe(200);
    expect((await call("GET", `/api/groups/${id}`, { as: bob })).status).toBe(404); // bob is out
    expect((await call("POST", `/api/groups/${id}/leave`, { as: alice })).status).toBe(200);
    expect((await call("GET", `/api/groups/${id}`, { as: alice })).status).toBe(404);
  });

  test("the group view lists everyone with their estimate, and names only what the account page shows", async () => {
    const { call, json, services, clock, party, alice, bob } = world();
    const { id } = await party();
    services.drinks.add(alice.id, findPreset("b50")!.mg, "x", { at: clock.now - 20 * MINUTE_MS });
    const v = await json(await call("GET", `/api/groups/${id}`, { as: bob }));
    expect(v.members.map((m: any) => m.name)).toEqual(["Alice Aalto", "Bob Berg"]); // highest first, sober Bob last
    expect(v.members[0].permille).toBeGreaterThan(0);
    expect(v.members[0].standardDrinks12h).toBeCloseTo(1.5, 0);
    expect(v.members[1]).toMatchObject({ permille: 0, isMe: true });
    expect(v.chart.lines.map((l: any) => l.name)).toEqual(["Alice Aalto"]);
    // no raw account ids anywhere
    for (const p of [alice, bob]) expect(JSON.stringify(v)).not.toContain(p.id);
  });

  test("a Telegram group can be viewed and left but not administered", async () => {
    const { call, json, services, alice, bob } = world();
    services.groups.join(alice.id, -100, "Perjantai");
    services.groups.join(bob.id, -100);
    const id = services.groups.listFor(alice.id)[0]!.id;
    expect(id).toHaveLength(64);
    const v = await json(await call("GET", `/api/groups/${id}`, { as: alice }));
    expect(v.group).toMatchObject({ name: "Perjantai", kind: "telegram", isOwner: false });
    expect((await call("PATCH", `/api/groups/${id}`, { as: alice, body: { name: "x" } })).status).toBe(403);
    expect((await call("POST", `/api/groups/${id}/invite`, { as: alice })).status).toBe(409);
    expect((await call("DELETE", `/api/groups/${id}`, { as: alice })).status).toBe(403);
    expect((await call("POST", `/api/groups/${id}/leave`, { as: alice })).status).toBe(200);
    expect(services.groups.isMember(alice.id, -100)).toBe(false);
  });

  test("hiding on screens", async () => {
    const { call, json, party, alice } = world();
    const { id } = await party();
    const v = await json(await call("PATCH", `/api/groups/${id}/me`, { as: alice, body: { hideOnScreen: true } }));
    expect(v.group.hideOnScreen).toBe(true);
    expect(v.members.find((m: any) => m.isMe)).toMatchObject({ name: "Alice Aalto", hidden: true }); // members still see each other
    expect((await call("PATCH", `/api/groups/${id}/me`, { as: alice, body: { hideOnScreen: "yes" } })).status).toBe(400);
  });
});

describe("event screens", () => {
  /** Creates a screen link for the party group and opens it as an anonymous viewer. */
  async function screen(w: ReturnType<typeof world>, hours?: number) {
    const { id } = await w.party();
    const link = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: { hours } }));
    const open = await w.call("POST", "/api/screen/open", { body: { token: link.token } });
    const cookie = open.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { id, link, open, cookie };
  }

  test("a link opens a screen without signing in", async () => {
    const w = world();
    const { link, open, cookie } = await screen(w);
    expect(open.status).toBe(200);
    const flags = open.headers.get("set-cookie")!;
    for (const f of ["HttpOnly", "Secure", "SameSite=Lax"]) expect(flags).toContain(f);
    expect(flags).toMatch(/^__Host-kili-screen=/);

    const view = await w.json(await w.call("GET", "/api/screen", { cookie }));
    expect(view).toMatchObject({ title: "Bileet", kind: "group" });
    expect(view.expiresAt).toBe(link.expiresAt);
    expect(Object.keys(view).sort()).toEqual(["chart", "expiresAt", "groupId", "kind", "members", "now", "photo", "title"]);
    expect(view.photo).toBe(false); // a web group has no Telegram photo
    expect(view.groupId).toBe(w.services.groups.listFor(w.alice.id)[0]!.id); // for the QR code to the group page
    expect((await w.call("GET", "/api/screen/photo", { cookie })).status).toBe(404);
  });

  test("a Telegram group's photo comes from the Bot API through the server, cached", async () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    const requests: { url: string; init?: RequestInit }[] = [];
    let hasPhoto = true;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/getChat?")) return Response.json({ ok: true, result: hasPhoto ? { photo: { small_file_id: "SMALL" } } : {} });
      if (url.includes("/getFile?")) return Response.json({ ok: true, result: { file_path: "photos/file_1.jpg" } });
      return new Response(JPEG); // Telegram doesn't say the type: it is read from the bytes
    }) as typeof fetch;
    const w = world({ groupPhotos: new GroupPhotos({ botToken: "1:x", fetch: fakeFetch }) });
    w.services.groups.join(w.alice.id, -1001234567890, "Kerava");
    w.services.groups.rememberChat(-1001234567890); // the bot does this after a group command
    const id = w.services.groups.listFor(w.alice.id)[0]!.id;
    const link = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: {} }));
    const cookie = (await w.call("POST", "/api/screen/open", { body: { token: link.token } })).headers.get("set-cookie")!.split(";")[0]!;

    expect(await w.json(await w.call("GET", "/api/screen", { cookie }))).toMatchObject({ photo: true });
    const res = await w.call("GET", "/api/screen/photo", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(requests.map((r) => r.url)).toEqual([
      "https://api.telegram.org/bot1:x/getChat?chat_id=-1001234567890",
      "https://api.telegram.org/bot1:x/getFile?file_id=SMALL",
      "https://api.telegram.org/file/bot1:x/photos/file_1.jpg",
    ]);
    for (const r of requests) {
      const sent = JSON.stringify(r.init);
      for (const leak of [cookie.split("=")[1]!, "1.1.1.1", ORIGIN]) expect(sent).not.toContain(leak);
    }
    expect((await w.call("GET", "/api/screen/photo", { cookie })).status).toBe(200);
    expect(requests).toHaveLength(3); // from memory
    expect((await w.call("GET", "/api/screen/photo")).status).toBe(401);

    // A group without a photo: 404, and the screen falls back to the bot's picture
    hasPhoto = false;
    w.services.groups.join(w.bob.id, -42, "Ei kuvaa");
    w.services.groups.rememberChat(-42);
    const other = w.services.groups.listFor(w.bob.id)[0]!.id;
    const link2 = await w.json(await w.call("POST", `/api/groups/${other}/screens`, { as: w.bob, body: {} }));
    const cookie2 = (await w.call("POST", "/api/screen/open", { body: { token: link2.token } })).headers.get("set-cookie")!.split(";")[0]!;
    expect((await w.call("GET", "/api/screen/photo", { cookie: cookie2 })).status).toBe(404);
  });

  test("the screen shows nothing without the link, with a wrong one, or after it expires or is revoked", async () => {
    const w = world();
    const { id, link, cookie } = await screen(w);
    expect((await w.call("GET", "/api/screen")).status).toBe(401);
    expect((await w.call("GET", "/api/screen", { cookie: "__Host-kili-screen=wrong" })).status).toBe(401);
    expect((await w.call("POST", "/api/screen/open", { body: { token: "wrong" } })).status).toBe(404);
    expect((await w.call("POST", "/api/screen/open", { body: {} })).status).toBe(400);

    const shown = (await w.call("GET", "/api/groups", { cookie })).status; // a screen cookie is not a session
    expect(shown).toBe(401);
    expect((await w.call("GET", "/api/screen", { as: w.alice })).status).toBe(401); // and a session is not a screen

    const refs = (await w.json(await w.call("GET", `/api/groups/${id}`, { as: w.alice }))).screens;
    expect(refs).toHaveLength(1);
    expect((await w.call("DELETE", `/api/groups/${id}/screens/${refs[0].ref}`, { as: w.alice })).status).toBe(200);
    expect((await w.call("GET", "/api/screen", { cookie })).status).toBe(401);
    expect((await w.call("POST", "/api/screen/open", { body: { token: link.token } })).status).toBe(404);

    const second = await screen(w);
    w.clock.now += 25 * HOUR_MS;
    expect((await w.call("GET", "/api/screen", { cookie: second.cookie })).status).toBe(401);
  });

  test("opening a screen is a same-origin POST like every other write", async () => {
    const w = world();
    const { link } = await screen(w);
    const bad = await w.app(new Request(`${ORIGIN}/api/screen/open`, { method: "POST", headers: { origin: "https://evil.test", "x-kili": "1" }, body: JSON.stringify({ token: link.token }) }), "1.1.1.1");
    expect(bad.status).toBe(403);
  });

  test("members who hide appear as Nimetön, with nothing that identifies them", async () => {
    const w = world();
    const { id, cookie } = await screen(w);
    w.services.drinks.add(w.alice.id, findPreset("b50")!.mg, "x", { at: w.clock.now - 20 * MINUTE_MS });
    w.services.drinks.add(w.bob.id, findPreset("b33a")!.mg, "y", { at: w.clock.now - 20 * MINUTE_MS });
    await w.call("PATCH", `/api/groups/${id}/me`, { as: w.alice, body: { hideOnScreen: true } });

    const view = await w.json(await w.call("GET", "/api/screen", { cookie }));
    const text = JSON.stringify(view);
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("alice");
    expect(text).toContain("Nimetön 1");
    expect(text).toContain("Bob Berg"); // not hidden
    expect(view.members.map((m: any) => m.name).sort()).toEqual(["Bob Berg", "Nimetön 1"]);
    expect(view.chart.lines.map((l: any) => l.name).sort()).toEqual(["Bob Berg", "Nimetön 1"]);
    for (const p of [w.alice, w.bob]) expect(text).not.toContain(p.id);
    // the leaderboard has no member handles that could be used to manage anyone
    expect(view.members[0]).not.toHaveProperty("ref");
  });

  test("lifetime and number of links are limited; any member can make one, only the creator or owner revokes", async () => {
    const w = world();
    const { id } = await w.party();
    const long = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.bob, body: { hours: 100000 } }));
    expect(long.expiresAt - w.clock.now).toBe(7 * 24 * HOUR_MS);
    const short = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.bob, body: { hours: 0 } }));
    expect(short.expiresAt - w.clock.now).toBe(HOUR_MS);
    await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: {} });
    for (let i = 0; i < 2; i += 1) await w.call("POST", `/api/groups/${id}/screens`, { as: w.bob, body: {} });
    expect((await w.call("POST", `/api/groups/${id}/screens`, { as: w.bob, body: {} })).status).toBe(409);

    const view = await w.json(await w.call("GET", `/api/groups/${id}`, { as: w.bob }));
    const aliceLink = view.screens.find((s: any) => !s.mine);
    expect((await w.call("DELETE", `/api/groups/${id}/screens/${aliceLink.ref}`, { as: w.bob })).status).toBe(403);
    expect((await w.call("DELETE", `/api/groups/${id}/screens/${view.screens.find((s: any) => s.mine).ref}`, { as: w.bob })).status).toBe(200);
    expect((await w.call("DELETE", `/api/groups/${id}/screens/${aliceLink.ref}`, { as: w.alice })).status).toBe(200); // the owner can
  });

  test("a personal screen shows one person", async () => {
    const w = world();
    w.services.drinks.add(w.alice.id, findPreset("b50")!.mg, "x", { at: w.clock.now - 20 * MINUTE_MS });
    const link = await w.json(await w.call("POST", "/api/screens", { as: w.alice, body: {} }));
    const open = await w.call("POST", "/api/screen/open", { body: { token: link.token } });
    const view = await w.json(await w.call("GET", "/api/screen", { cookie: open.headers.get("set-cookie")!.split(";")[0] }));
    expect(view).toMatchObject({ kind: "person", title: "Alice Aalto", members: [] });
    expect(view.chart.lines).toHaveLength(1);

    const mine = await w.json(await w.call("GET", "/api/screens", { as: w.alice }));
    expect(mine.screens).toHaveLength(1);
    expect((await w.call("DELETE", `/api/screens/${mine.screens[0].ref}`, { as: w.bob })).status).toBe(404); // not bob's
    expect((await w.call("DELETE", `/api/screens/${mine.screens[0].ref}`, { as: w.alice })).status).toBe(200);
    expect((await w.call("GET", "/api/screen", { cookie: open.headers.get("set-cookie")!.split(";")[0] })).status).toBe(401);
  });
});

describe("group and screen live updates", () => {
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
          if (!chunk || chunk.done) return null;
          buf += dec.decode(chunk.value);
        }
      },
      cancel: () => r.cancel(),
    };
  }

  test("a drink by any member reaches the group page and the screen", async () => {
    const w = world();
    const { id } = await w.party();
    const link = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: {} }));
    const cookie = (await w.call("POST", "/api/screen/open", { body: { token: link.token } })).headers.get("set-cookie")!.split(";")[0]!;

    const page = reader(await w.call("GET", `/api/groups/${id}/events`, { as: w.bob }));
    const tv = reader(await w.call("GET", "/api/screen/events", { cookie }));
    expect((await page.next())!.data.group.name).toBe("Bileet");
    expect((await tv.next())!.data.title).toBe("Bileet");

    w.services.drinks.add(w.alice.id, findPreset("b50")!.mg, "x", { at: w.clock.now - 20 * MINUTE_MS });
    expect((await page.next())!.data.members[0].name).toBe("Alice Aalto");
    expect((await tv.next())!.data.members[0].name).toBe("Alice Aalto");

    // someone who isn't in the group changes nothing for it
    w.services.drinks.add(w.carol.id, 20_000, "z", { at: w.clock.now - 20 * MINUTE_MS });
    expect(await tv.next(150)).toBeNull();
    await page.cancel();
    await tv.cancel();
  });

  test("hiding on screens changes the screen right away; revoking ends it", async () => {
    const w = world();
    const { id } = await w.party();
    w.services.drinks.add(w.alice.id, findPreset("b50")!.mg, "x", { at: w.clock.now - 20 * MINUTE_MS });
    const link = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: {} }));
    const cookie = (await w.call("POST", "/api/screen/open", { body: { token: link.token } })).headers.get("set-cookie")!.split(";")[0]!;
    const tv = reader(await w.call("GET", "/api/screen/events", { cookie }));
    expect((await tv.next())!.data.members[0].name).toBe("Alice Aalto");

    await w.call("PATCH", `/api/groups/${id}/me`, { as: w.alice, body: { hideOnScreen: true } });
    expect((await tv.next())!.data.members[0].name).toBe("Nimetön 1");

    const ref = (await w.json(await w.call("GET", `/api/groups/${id}`, { as: w.alice }))).screens[0].ref;
    await w.call("DELETE", `/api/groups/${id}/screens/${ref}`, { as: w.alice });
    expect((await tv.next())?.event).toBe("end");
    await tv.cancel();
  });

  test("deleting the group ends the pages watching it; the screen ends too", async () => {
    const w = world();
    const { id } = await w.party();
    const link = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: {} }));
    const cookie = (await w.call("POST", "/api/screen/open", { body: { token: link.token } })).headers.get("set-cookie")!.split(";")[0]!;
    const page = reader(await w.call("GET", `/api/groups/${id}/events`, { as: w.bob }));
    await page.next();
    await w.call("DELETE", `/api/groups/${id}`, { as: w.alice });
    expect((await page.next())?.event).toBe("end");
    expect((await w.call("GET", "/api/screen", { cookie })).status).toBe(401);
    await page.cancel();
  });

  test("screen streams are limited per link", async () => {
    const w = world();
    const { id } = await w.party();
    const link = await w.json(await w.call("POST", `/api/groups/${id}/screens`, { as: w.alice, body: {} }));
    const cookie = (await w.call("POST", "/api/screen/open", { body: { token: link.token } })).headers.get("set-cookie")!.split(";")[0]!;
    const open = [] as ReturnType<typeof reader>[];
    for (let i = 0; i < 5; i += 1) open.push(reader(await w.call("GET", "/api/screen/events", { cookie })));
    expect((await w.call("GET", "/api/screen/events", { cookie })).status).toBe(429);
    for (const o of open) await o.cancel();
  });
});
