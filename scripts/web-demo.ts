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

// Two more people and a web group of everyone, with a screen link and a spare invite
const extra = ["Aino Virtanen", "Eero Korhonen", "Sanna Mäkelä"].map((fullName, i) =>
  services.accounts.register({ platform: "telegram", platformUserId: 10 + i }, { name: fullName.split(" ")[0]!.toLowerCase(), fullName, weight: 60 + i * 10, height: 165 + i * 6, gender: i === 1 ? "mies" : "nainen" }).profile,
);
const group = services.groups.createWeb(demo.id, "Demoryhmä");
if (group === "limit") throw new Error("unexpected");
const join = services.groups.createInvite(group.id, demo.id);
for (const p of [friend, ...extra]) services.groups.redeemInvite(join.code, p.id);
extra.forEach((p, i) => {
  for (const ago of [170 - i * 20, 110 - i * 15, 50 - i * 5]) services.drinks.add(p.id, findPreset(i % 2 ? "b50" : "w16")!.mg, "x", { at: now - ago * MINUTE_MS, kcal: 100 });
});
services.groups.setHidden(extra[2]!.id, group.id, true); // shows as "Nimetön 1" on screens
const screen = services.screens.create({ groupId: group.id }, demo.id);

startWebServer({ config, services, botUsername: "demo_bot" });
const { token } = services.webSessions.createLoginLink(demo.id, null);
console.log(`\nSign in (valid for ${(10 * MINUTE_MS) / MINUTE_MS} minutes, once):\n  ${origin}/login#t=${token}\n`);
if (screen !== "limit") console.log(`Event screen of "Demoryhmä" (needs no sign-in):\n  ${origin}/screen#t=${screen.token}\n`);
console.log(`Invite to "Demoryhmä" (for a second account):\n  ${origin}/join#c=${join.code}\n`);
