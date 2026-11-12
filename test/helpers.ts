import { loadConfig, type Config } from "../src/config.ts";
import { openDatabase } from "../src/db/index.ts";
import { createCrypto } from "../src/lib/ids.ts";
import { createServices } from "../src/services/index.ts";
import type { Announcement } from "../src/announcements.ts";
import type { Products } from "../src/services/products.ts";
import type { Barcodes } from "../src/services/barcodes.ts";
import { createWebApp, type WebAppOptions } from "../src/web/app.ts";
import { serveWebApp } from "../src/web/server.ts";

export const TEST_SECRET = "test-secret-test-secret-test-secret-123";

/** Services on a fresh in-memory database with a controllable clock. */
export function setup(start = Date.parse("2026-11-06T20:00:00Z"), announcements: Announcement[] = [], products?: Products, barcodes?: Barcodes) {
  const clock = { now: start };
  const db = openDatabase(":memory:");
  const crypto = createCrypto(TEST_SECRET);
  const services = createServices({ db, crypto, now: () => clock.now }, { announcements, products, barcodes });
  return { db, crypto, services, clock };
}

/** A Telegram login, as passed to accounts.register and identities. */
export const tg = (id: number) => ({ platform: "telegram", platformUserId: id }) as const;

/**
 * The web API on a real server (Bun.serve's router needs one), called like a function:
 * `app(new Request("https://kili.test/api/me"), ip)`. Only the path is used from the URL; `ip`
 * arrives as CF-Connecting-IP, as from the Cloudflare Tunnel. close() stops the server.
 */
export function serveTestApp(opts: WebAppOptions) {
  const app = createWebApp(opts);
  const server = serveWebApp(app, { port: 0 });
  const call = async (req: Request, ip = "1.2.3.4") => {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("cf-connecting-ip", ip);
    const body = req.body && req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined;
    return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
  };
  return Object.assign(call, {
    viewers: app.viewers,
    close() {
      app.close();
      void server.stop(true);
    },
  });
}

/** A full Config without needing a .env (CI has none): the required variables are set only while it loads. */
export function testConfig(): Config {
  const saved = { ...process.env };
  process.env.BOT_TOKEN ??= "1:x";
  process.env.APP_SECRET ??= "x".repeat(32);
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
}
