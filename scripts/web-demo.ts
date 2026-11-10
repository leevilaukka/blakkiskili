// Starts the website against a throwaway in-memory database with a demo user and some drinks,
// so the UI can be tried without Telegram or your real data:
//
//   bun run web:build && bun run web:demo
//
// It prints a sign-in link. Nothing here touches .env, the real database or the bot.

import { openDatabase } from "../src/db/index.ts";
import { createCrypto } from "../src/lib/ids.ts";
import { findPreset } from "../src/lib/catalog.ts";
import { alcoholMgFromClPercent, MINUTE_MS } from "../src/lib/units.ts";
import { createServices } from "../src/services/index.ts";
import { Products } from "../src/services/products.ts";
import { Barcodes } from "../src/services/barcodes.ts";
import { startWebServer } from "../src/web/server.ts";
import type { Config } from "../src/config.ts";

const port = Number(process.env.DEMO_PORT ?? 8082);
const origin = `http://localhost:${port}`;
const config = {
  botToken: "0:demo",
  adminIds: [1], // the demo user, so /admin can be tried
  web: { enabled: true, origin, port, distDir: process.env.WEB_DIST ?? "./web/build" },
} as Config;

const products = new Products({ url: process.env.ALKOMETRIIKKA_URL ?? "https://alkometriikka.fi/data.json" });
await products.refresh().then(() => console.log(`Catalogue: ${products.count} products`)).catch(() => console.log("Catalogue unavailable (offline?): search is empty"));

const services = createServices(
  { db: openDatabase(":memory:"), crypto: createCrypto("demo-secret-demo-secret-demo-secret-1"), now: () => Date.now() },
  // Barcodes beyond the catalogue's EAN column are asked from the API Worker only when it is set.
  { products, barcodes: new Barcodes({ url: process.env.ALKOMETRIIKKA_API_URL }) },
);
const demo = services.accounts.register({ platform: "telegram", platformUserId: 1 }, { name: "demo", fullName: "Demo Henkilö", weight: 75, height: 178, gender: "mies" }).profile;
const now = Date.now();
for (const [ago, preset] of [[200, "b33a"], [140, "b50"], [85, "s40"], [30, "b33b"]] as const) {
  const p = findPreset(preset)!;
  services.drinks.add(demo.id, p.mg, p.name, { at: now - ago * MINUTE_MS, kcal: p.kcal });
}
// Earlier evenings, for the logbook
for (const [days, presets] of [[2, ["b33a", "b33a", "w16"]], [6, ["b50", "b50", "s40", "b50"]], [13, ["w16", "w16"]], [40, ["b33b", "s40"]]] as const) {
  presets.forEach((id, i) => {
    const p = findPreset(id)!;
    services.drinks.add(demo.id, p.mg, p.name, { at: now - days * 24 * 60 * MINUTE_MS - (180 - i * 50) * MINUTE_MS, kcal: p.kcal });
  });
}
services.drinks.add(demo.id, alcoholMgFromClPercent(4, 40), "Oma juoma - 4cl 40%", { at: now - 6 * 24 * 60 * MINUTE_MS + 30 * MINUTE_MS });
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
// Products added by barcode, for the admin page
services.customProducts.save({ ean: "4006381333931", kind: "olut", name: "Kauppakalja", sizeL: 0.33, abv: 4.6, kcal100: 42 }, friend.id, false);
services.customProducts.save({ ean: "96385074", kind: "viini", name: "Kotiviini", sizeL: 0.75, abv: 12.5, kcal100: null }, extra[0]!.id, false);
services.customProducts.report("4006381333931", extra[1]!.id, "Prosentti on 5,2 eikä 4,6");

startWebServer({
  config,
  services,
  botUsername: "demo_bot",
  notifyAdmins: async (html) => console.log(`[to admins] ${html}`),
});
const { token } = services.webSessions.createLoginLink(demo.id, services.identities.key({ platform: "telegram", platformUserId: 1 }));
console.log(`\nSign in (valid for ${(10 * MINUTE_MS) / MINUTE_MS} minutes, once):\n  ${origin}/login#t=${token}\n`);
if (screen !== "limit") console.log(`Event screen of "Demoryhmä" (needs no sign-in):\n  ${origin}/screen#t=${screen.token}\n`);
console.log(`Invite to "Demoryhmä" (for a second account):\n  ${origin}/join#c=${join.code}\n`);
