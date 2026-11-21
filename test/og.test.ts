// Link previews: each page's Open Graph tags written into index.html, and the cards drawn on the
// fly. Only pikakutsu links and the public texts get their own; private pages keep the site's.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { HOUR_MS } from "../src/lib/units.ts";
import { createWebApp } from "../src/web/app.ts";
import { wrap } from "../src/web/ogimage.ts";
import { serveWebApp } from "../src/web/server.ts";
import { contentSecurityPolicy, inlineScriptHashes, StaticSite, withMeta } from "../src/web/static.ts";
import { setup, tg } from "./helpers.ts";

const ORIGIN = "https://kili.test";
const SHELL = `<!doctype html><html><head>
    <meta property="og:title" content="Bläkkiskili" />
    <meta property="og:description" content="x" />
    <meta property="og:url" content="https://blakkiskili.party/" />
    <meta property="og:image" content="https://blakkiskili.party/api/og/site" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="description" content="x" />
  </head><body><script>window.x=1</script></body></html>`;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function world() {
  const w = setup();
  const user = (id: number, name: string) => w.services.accounts.register(tg(id), { name, weight: 75, height: 178, gender: "mies" }).profile;
  const alice = user(1, "alice");
  const bob = user(2, "bob");
  const group = w.services.groups.createWeb(alice.id, 'Sauna "ilta" <3');
  if (group === "limit") throw new Error("limit");
  w.services.groups.redeemInvite(w.services.groups.createInvite(group.id, alice.id).code, bob.id);
  const jam = w.services.groups.startJam(group.id, bob.id, 8 * HOUR_MS);

  const dir = mkdtempSync(join(tmpdir(), "kili-og-"));
  writeFileSync(join(dir, "index.html"), SHELL);
  const app = createWebApp({ services: w.services, botToken: "1:x", botUsername: "b", origin: ORIGIN });
  const server = serveWebApp(app, { port: 0, site: new StaticSite(dir, app.meta) });
  cleanup.push(() => {
    app.close();
    void server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  const get = (path: string, ip = "1.2.3.4") => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { "cf-connecting-ip": ip } });
  const tags = async (path: string) => {
    const html = await (await get(path)).text();
    return Object.fromEntries([...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  };
  return { ...w, alice, bob, group, jam, get, tags };
}

const isPng = (b: ArrayBuffer) => Buffer.from(b).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

describe("link previews", () => {
  test("a pikakutsu link previews the group, escaped", async () => {
    const w = world();
    const t = await w.tags(`/liity/${w.jam.code}`);
    expect(t["og:title"]).toBe("bob kutsuu sinut ryhmään Sauna &quot;ilta&quot; &lt;3");
    expect(t["og:description"]).toContain("2 jäsentä");
    expect(t["og:image"]).toBe(`${ORIGIN}/api/og/liity/${w.jam.code}`);
    expect(t["og:url"]).toBe(`${ORIGIN}/liity/${w.jam.code}`);
    expect(t["twitter:card"]).toBe("summary_large_image");
    // The build's generic tags are gone, not doubled.
    const html = await (await w.get(`/liity/${w.jam.code}`)).text();
    expect(html.match(/og:title/g)).toHaveLength(1);
    expect(html).not.toContain("blakkiskili.party/");

    const png = await w.get(`/api/og/liity/${w.jam.code}`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(isPng(await png.arrayBuffer())).toBe(true);
  });

  test("the script hash in the CSP still matches: meta tags don't touch scripts", async () => {
    const w = world();
    const res = await w.get(`/liity/${w.jam.code}`);
    expect(res.headers.get("content-security-policy")).toBe(contentSecurityPolicy(inlineScriptHashes(SHELL)));
  });

  test("a starter who is anonymous on screens isn't named; an ended or unknown pikakutsu shows nothing of the group", async () => {
    const w = world();
    w.services.groups.setHidden(w.bob.id, w.group.id, true);
    expect((await w.tags(`/liity/${w.jam.code}`))["og:title"]).toStartWith("Ryhmän jäsen kutsuu");
    w.services.groups.endJam(w.group.id);
    const t = await w.tags(`/liity/${w.jam.code}`);
    expect(t["og:title"]).toBe("Pikakutsu · Bläkkiskili");
    expect(JSON.stringify(t)).not.toContain("Sauna");
    expect(t["og:image"]).toBe(`${ORIGIN}/api/og/site`);
    expect(isPng(await (await w.get(`/api/og/liity/${w.jam.code}`)).arrayBuffer())).toBe(true); // the site's card
    expect((await w.get("/api/og/liity/x")).status).toBe(404);
  });

  test("public texts get their titles; private pages the site's card", async () => {
    const w = world();
    expect((await w.tags("/terms"))["og:title"]).toBe("Käyttöehdot · Bläkkiskili");
    expect((await w.tags("/privacy"))["og:title"]).toBe("Tietosuoja · Bläkkiskili");
    for (const path of [`/groups/${w.group.id}`, "/screen", "/", "/logbook"]) {
      const t = await w.tags(path);
      expect({ path, title: t["og:title"], image: t["og:image"] }).toEqual({ path, title: "Bläkkiskili", image: `${ORIGIN}/api/og/site` });
    }
    expect(isPng(await (await w.get("/api/og/site")).arrayBuffer())).toBe(true);
  });

  test("cards are rate limited per address", async () => {
    const w = world();
    let last = 0;
    for (let i = 0; i < 601; i++) last = (await w.get("/api/og/site", "7.7.7.7")).status;
    expect(last).toBe(429);
  });
});

describe("helpers", () => {
  test("wrap", () => {
    expect(wrap("Teekkarien vappupiknik ja saunailta", 18, 2)).toEqual(["Teekkarien", "vappupiknik ja…"]);
    expect(wrap("Lyhyt", 18, 2)).toEqual(["Lyhyt"]);
    expect(wrap("Ylipitkäsanaeitaivuriville", 10, 1)).toEqual(["Ylipitkäs…"]);
  });

  test("withMeta replaces the tags and escapes", () => {
    const html = withMeta(SHELL, { title: 'a"<b>', description: "d", url: "u", image: "i", imageWidth: 1, imageHeight: 2, imageAlt: "x" });
    expect(html).toContain('<meta property="og:title" content="a&quot;&lt;b&gt;" />');
    expect(html).toContain("<title>a&quot;&lt;b&gt;</title>");
    expect(html.match(/og:image"/g)).toHaveLength(1);
  });
});
