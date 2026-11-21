// Jams: a web group's join link of the evening, shareable by any member, with a preview. Joining
// always needs an account.

import { afterEach, describe, expect, test } from "bun:test";
import { DAY_MS, HOUR_MS } from "../src/lib/units.ts";
import { JAM_MAX_MS, MAX_WEB_GROUP_MEMBERS } from "../src/services/groups.ts";
import type { GroupView, JamPreview } from "../shared/api.ts";
import { serveTestApp, setup, tg } from "./helpers.ts";

const ORIGIN = "https://kili.test";
const apps: ReturnType<typeof serveTestApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
});

function world() {
  const w = setup();
  const user = (id: number, name: string) => w.services.accounts.register(tg(id), { name, weight: 75, height: 178, gender: "mies" }).profile;
  const alice = user(1, "alice");
  const bob = user(2, "bob");
  const carol = user(3, "carol");
  const app = serveTestApp({ services: w.services, botToken: "1:x", botUsername: "b", origin: ORIGIN, live: { tickMs: 1_000_000, minGapMs: 10 } });
  apps.push(app);
  const group = w.services.groups.createWeb(alice.id, "Saunailta");
  if (group === "limit") throw new Error("limit");
  w.services.groups.redeemInvite(w.services.groups.createInvite(group.id, alice.id).code, bob.id);
  const cookieOf = (p: { id: string }) => `__Host-kili=${w.services.webSessions.createSession(p.id, null).sessionToken}`;
  const call = async (method: string, path: string, opts: { cookie?: string; body?: unknown; ip?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (method !== "GET") Object.assign(headers, { origin: ORIGIN, "x-kili": "1" });
    return app(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), opts.ip);
  };
  const start = async (p: { id: string }, hours = 8) => (await (await call("POST", `/api/groups/${group.id}/jam`, { cookie: cookieOf(p), body: { hours } })).json()) as GroupView;
  return { ...w, alice, bob, carol, group, call, cookieOf, start };
}

describe("jams", () => {
  test("any member starts one; every member sees the same link; starting again keeps it", async () => {
    const w = world();
    const byBob = await w.start(w.bob);
    expect(byBob.jam).toMatchObject({ startedBy: "bob", canEnd: true, expiresAt: w.clock.now + 8 * HOUR_MS });
    const forAlice = (await (await w.call("GET", `/api/groups/${w.group.id}`, { cookie: w.cookieOf(w.alice) })).json()) as GroupView;
    expect(forAlice.jam?.code).toBe(byBob.jam!.code);
    expect(forAlice.jam?.canEnd).toBe(true); // the owner
    const again = await w.start(w.alice, 2);
    expect(again.jam?.code).toBe(byBob.jam!.code);
    // Outsiders can't start or see it.
    expect((await w.call("POST", `/api/groups/${w.group.id}/jam`, { cookie: w.cookieOf(w.carol), body: { hours: 1 } })).status).toBe(404);
    // The code is stored hashed and encrypted, not as is.
    const row = w.db.query("SELECT * FROM group_jams").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(byBob.jam!.code);
  });

  test("duration is held to half an hour … a week", async () => {
    const w = world();
    expect((await w.start(w.alice, 1000)).jam?.expiresAt).toBe(w.clock.now + JAM_MAX_MS);
    expect((await w.call("POST", `/api/groups/${w.group.id}/jam`, { cookie: w.cookieOf(w.alice), body: { hours: -1 } })).status).toBe(400);
  });

  test("preview, then a signed-in person joins", async () => {
    const w = world();
    const code = (await w.start(w.bob)).jam!.code;
    const preview = (await (await w.call("POST", "/api/jam/preview", { body: { code } })).json()) as JamPreview;
    expect(preview).toEqual({ groupName: "Saunailta", startedBy: "bob", memberCount: 2, expiresAt: w.clock.now + 8 * HOUR_MS, member: false, groupId: null });
    expect(((await (await w.call("POST", "/api/jam/preview", { body: { code }, cookie: w.cookieOf(w.bob) })).json()) as JamPreview).member).toBe(true);
    expect((await w.call("POST", "/api/jam/preview", { body: { code: "x".repeat(22) } })).status).toBe(404);

    // Bob appears anonymously on screens: outsiders aren't told his name.
    w.services.groups.setHidden(w.bob.id, w.group.id, true);
    expect(((await (await w.call("POST", "/api/jam/preview", { body: { code } })).json()) as JamPreview).startedBy).toBe("Ryhmän jäsen");

    expect((await w.call("POST", "/api/jam/join", { body: { code } })).status).toBe(401);
    const res = await w.call("POST", "/api/jam/join", { body: { code }, cookie: w.cookieOf(w.carol) });
    expect(await res.json()).toEqual({ id: w.group.id });
    expect(w.services.groups.isMemberOf(w.carol.id, w.group.id)).toBe(true);
    expect((await w.call("POST", "/api/jam/join", { body: { code }, cookie: w.cookieOf(w.carol) })).status).toBe(409);
  });

  test("ended, expired or full: no joining; members who joined stay; no guest joining at all", async () => {
    const w = world();
    const code = (await w.start(w.bob)).jam!.code;
    await w.call("POST", "/api/jam/join", { body: { code }, cookie: w.cookieOf(w.carol) });
    // Only the starter or the owner ends it.
    expect((await w.call("DELETE", `/api/groups/${w.group.id}/jam`, { cookie: w.cookieOf(w.carol) })).status).toBe(403);
    expect((await w.call("DELETE", `/api/groups/${w.group.id}/jam`, { cookie: w.cookieOf(w.alice) })).status).toBe(200);
    expect(w.services.groups.isMemberOf(w.carol.id, w.group.id)).toBe(true);
    const dave = w.services.accounts.register(tg(4), { name: "dave", weight: 80, height: 180, gender: "mies" }).profile;
    expect((await w.call("POST", "/api/jam/join", { body: { code }, cookie: w.cookieOf(dave) })).status).toBe(404);

    const code2 = (await w.start(w.alice, 1)).jam!.code;
    w.clock.now += 2 * HOUR_MS;
    expect((await w.call("POST", "/api/jam/preview", { body: { code: code2 } })).status).toBe(404);
    expect((await w.call("POST", "/api/jam/join", { body: { code: code2 }, cookie: w.cookieOf(dave) })).status).toBe(404);

    const code3 = (await w.start(w.alice, 1)).jam!.code;
    for (let i = (w.db.query("SELECT count(*) AS n FROM group_members WHERE group_id = ?").get(w.group.id) as { n: number }).n; i < MAX_WEB_GROUP_MEMBERS; i++) {
      w.services.groups.joinJam(code3, w.services.accounts.register(tg(100 + i), { name: `m${i}`, weight: 70, height: 170, gender: "mies" }).profile.id);
    }
    expect((await w.call("POST", "/api/jam/join", { body: { code: code3 }, cookie: w.cookieOf(dave) })).status).toBe(409);

    // Joining without an account doesn't exist: groups always need one.
    expect((await w.call("POST", "/api/jam/guest", { body: { code: code3, name: "x", weight: 70, height: 170, gender: "mies", acceptTerms: true } })).status).toBe(404);
  });

  test("the starter leaving ends their jam; prune clears expired ones", async () => {
    const w = world();
    await w.start(w.bob);
    w.services.groups.leaveGroup(w.bob.id, w.group.id);
    expect(w.services.groups.jam(w.group.id)).toBeNull();
    await w.start(w.alice, 1);
    w.clock.now += DAY_MS;
    w.services.groups.prune();
    expect((w.db.query("SELECT count(*) AS n FROM group_jams").get() as { n: number }).n).toBe(0);
  });

});
