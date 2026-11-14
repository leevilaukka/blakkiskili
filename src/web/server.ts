// Starts the website's HTTP server: the API's routes (app.ts), and the built app for the rest.
//
// The port is not published by docker-compose; only the Cloudflare Tunnel container reaches it
// over the internal network. That is why CF-Connecting-IP is trusted for rate limiting: nothing
// else can talk to this port. Never publish it.

import { docsHtml } from "../bot/context.ts";
import type { Config } from "../config.ts";
import type { Services } from "../services/index.ts";
import { createWebApp, type WebApp, type WebAppOptions } from "./app.ts";
import { StaticSite, withSecurityHeaders } from "./static.ts";

export interface WebServerOptions {
  config: Config;
  services: Services;
  botUsername: WebAppOptions["botUsername"];
  /** Telegram messages to the admins (see WebAppOptions.notifyAdmins). */
  notifyAdmins?: (html: string) => Promise<void>;
  /** Tests shorten these; production uses the defaults. */
  idleTimeout?: number;
  live?: WebAppOptions["live"];
}

/** Serves `app`, and `site` for everything outside /api. Tests use it directly with port 0. */
export function serveWebApp(app: WebApp, { port, idleTimeout, site }: { port: number; idleTimeout?: number; site?: StaticSite }) {
  return Bun.serve({
    port,
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    // Bodies are tiny JSON, which readJsonBody holds to 4 KiB; only a data import (the old bot's
    // CSV files, as large as Telegram's import limit) is bigger, and it checks its own size.
    maxRequestBodySize: 10 * 1024 * 1024,
    routes: {
      "/healthz": new Response("ok"),
      ...app.routes,
    },
    fetch(req) {
      if (req.method !== "GET" && req.method !== "HEAD") return withSecurityHeaders(new Response("Method not allowed", { status: 405 }));
      if (!site) return withSecurityHeaders(new Response("Not found", { status: 404 }));
      return site.serve(new URL(req.url).pathname);
    },
    error(e) {
      console.error("Web request failed:", e);
      return withSecurityHeaders(new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "content-type": "application/json" } }));
    },
  });
}

export function startWebServer({ config, services, botUsername, notifyAdmins, idleTimeout, live }: WebServerOptions) {
  const app = createWebApp({
    services,
    botToken: config.botToken,
    botUsername,
    origin: config.web.origin,
    adminIds: config.adminIds,
    notifyAdmins,
    docs: docsHtml(config),
    live,
  });
  const site = new StaticSite(config.web.distDir);
  if (!site.available) console.warn(`Web: no build in ${config.web.distDir}; only the API works (bun run web:build).`);
  const server = serveWebApp(app, { port: config.web.port, idleTimeout, site });
  console.log(`Web: listening on :${server.port} (${config.web.origin})`);
  return Object.assign(server, {
    async shutdown() {
      app.close();
      await server.stop(true); // true: also closes the open event streams
    },
  });
}
