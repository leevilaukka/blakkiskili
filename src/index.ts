import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { webhookCallback } from "grammy";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { createCrypto } from "./lib/ids.ts";
import { createServices } from "./services/index.ts";
import { ALLOWED_UPDATES, createBot, publishCommandMenus } from "./bot/index.ts";
import { runInactivityJob } from "./bot/inactivity.ts";
import { createAdminAlerts } from "./bot/admin.ts";
import { writeSnapshot } from "./ops/backup.ts";
import { startJobs, type Job } from "./ops/scheduler.ts";
import { Products } from "./services/products.ts";
import { Barcodes } from "./services/barcodes.ts";

// Everything this process creates (database, WAL, snapshots) is readable by its owner only.
process.umask(0o077);

const config = loadConfig();
if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
const db = openDatabase(config.dbPath);
const products = new Products({
  url: config.productsUrl,
  cachePath: config.dbPath === ":memory:" ? undefined : join(dirname(config.dbPath), "alkometriikka-cache.json"),
});
if (products.enabled && products.loadCache()) console.log(`Alko catalogue: ${products.count} products from cache`);
const barcodes = new Barcodes({
  url: config.barcodesUrl,
  apiKey: config.barcodesKey,
  cachePath: config.dbPath === ":memory:" ? undefined : join(dirname(config.dbPath), "barcodes-cache.json"),
});
if (barcodes.enabled && barcodes.loadCache()) console.log(`Barcodes: ${barcodes.count} links from cache`);
const services = createServices({ db, crypto: createCrypto(config.appSecret), now: () => Date.now() }, { products, barcodes });
const bot = createBot(config, services);

await bot.init();
await publishCommandMenus(bot).catch((e) => console.warn("Could not set command menus:", e));

const alert = createAdminAlerts(bot.api, config);
const jobs: Job[] = [];
if (config.backup.dir) {
  const dir = config.backup.dir;
  jobs.push({
    name: "backup snapshot",
    everyMs: config.backup.everyMinutes * 60_000,
    firstDelayMs: 10_000,
    run: () => writeSnapshot(db, dir),
  });
} else {
  console.warn("BACKUP_DIR is not set: database snapshots are disabled.");
}
if (products.enabled) {
  jobs.push({
    name: "Alkometriikka catalogue",
    everyMs: 6 * 3600_000,
    firstDelayMs: 5_000,
    run: async () => {
      const r = await products.refresh();
      if (r === "updated") console.log(`Alko catalogue updated: ${products.count} products`);
      // Alkometriikka syncs daily; data older than 3 days means its sync is broken.
      if (products.updatedAt !== null && Date.now() - products.updatedAt > 3 * 86_400_000) {
        await alert("Alkometriikka catalogue", `Product data is from ${new Date(products.updatedAt).toISOString()}, not updated in 3 days.`);
      }
    },
  });
} else {
  console.log("ALKOMETRIIKKA_URL is empty: product search is disabled.");
}
if (barcodes.enabled) {
  jobs.push({
    name: "barcode links",
    everyMs: 30 * 60_000,
    firstDelayMs: 8_000,
    run: async () => {
      const r = await barcodes.refresh();
      if (r === "updated") console.log(`Barcode links updated: ${barcodes.count}`);
    },
  });
}
if (config.inactivity.deleteAfterDays > 0) {
  jobs.push({
    name: "inactivity cleanup",
    everyMs: 6 * 3600_000,
    firstDelayMs: 60_000,
    run: async () => {
      const r = await runInactivityJob(bot.api, services, config);
      if (r.warned || r.undeliverable || r.failed || r.deleted) console.log("Inactivity job:", r);
      if (r.failed) await alert("inactivity warnings", `${r.failed} warning(s) could not be sent; retrying next run.`);
    },
  });
}
const stopJobs = startJobs(jobs, (job, err) => {
  void alert(job, err instanceof Error ? err.message : String(err));
});

const shutdown = async () => {
  stopJobs();
  await bot.stop().catch(() => {});
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (config.mode === "webhook") {
  const handle = webhookCallback(bot, "std/http", { secretToken: config.webhookSecret });
  const server = Bun.serve({
    port: config.port,
    routes: {
      "/healthz": new Response("ok"),
      "/telegram": { POST: (req) => handle(req) },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  await bot.api.setWebhook(config.webhookUrl!, {
    secret_token: config.webhookSecret,
    allowed_updates: [...ALLOWED_UPDATES],
  });
  console.log(`@${bot.botInfo.username} listening for webhooks on :${server.port}/telegram`);
} else {
  await bot.api.deleteWebhook();
  console.log(`@${bot.botInfo.username} started (long polling)`);
  await bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
}
