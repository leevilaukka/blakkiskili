// Starts the website against a throwaway in-memory database with a demo user and some drinks,
// so the UI can be tried without Telegram or your real data:
//
//   bun run web:build && bun run web:demo
//
// It prints a sign-in link. Nothing here touches .env, the real database or the bot.

import { openDatabase } from "../src/db/index.ts";
import { createCrypto } from "../src/lib/ids.ts";
import { findPreset } from "../src/lib/catalog.ts";
import { MINUTE_MS } from "../src/lib/units.ts";
import { createServices } from "../src/services/index.ts";
import { Products } from "../src/services/products.ts";
import { startWebServer } from "../src/web/server.ts";
import type { Config } from "../src/config.ts";

const port = Number(process.env.DEMO_PORT ?? 8082);
const origin = `http://localhost:${port}`;
const config = {
  botToken: "0:demo",
  web: { enabled: true, origin, port, distDir: process.env.WEB_DIST ?? "./web/build" },
} as Config;

const products = new Products({ url: process.env.ALKOMETRIIKKA_URL ?? "https://alkometriikka.fi/data.json" });
await products.refresh().then(() => console.log(`Catalogue: ${products.count} products`)).catch(() => console.log("Catalogue unavailable (offline?): search is empty"));

const services = createServices(
  { db: openDatabase(":memory:"), crypto: createCrypto("demo-secret-demo-secret-demo-secret-1"), now: () => Date.now() },
  { products },
);
const demo = services.accounts.register({ platform: "telegram", platformUserId: 1 }, { name: "demo", fullName: "Demo Henkilö", weight: 75, height: 178, gender: "mies" }).profile;
const now = Date.now();
for (const [ago, preset] of [[200, "b33a"], [140, "b50"], [85, "s40"], [30, "b33b"]] as const) {
  const p = findPreset(preset)!;
  services.drinks.add(demo.id, p.mg, p.name, { at: now - ago * MINUTE_MS, kcal: p.kcal });
}
// A friend, so group-style charts have two lines to show later
const friend = services.accounts.register({ platform: "telegram", platformUserId: 2 }, { name: "kaveri", fullName: "Kaveri K", weight: 62, height: 168, gender: "nainen" }).profile;
for (const ago of [150, 90, 40]) services.drinks.add(friend.id, findPreset("w16")!.mg, findPreset("w16")!.name, { at: now - ago * MINUTE_MS, kcal: 90 });

startWebServer({ config, services, botUsername: "demo_bot" });
const { token } = services.webSessions.createLoginLink(demo.id, null);
console.log(`\nSign in (valid for ${(10 * MINUTE_MS) / MINUTE_MS} minutes, once):\n  ${origin}/login#t=${token}\n`);
