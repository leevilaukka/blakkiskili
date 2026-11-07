// Starts the website's HTTP server: /api/* → the JSON API, everything else → the built app.
//
// The port is not published by docker-compose; only the Cloudflare Tunnel container reaches it
// over the internal network. That is why CF-Connecting-IP is trusted for rate limiting: nothing
// else can talk to this port. Never publish it.

import type { Config } from "../config.ts";
import type { Services } from "../services/index.ts";
import { createWebApp } from "./app.ts";
import { StaticSite, withSecurityHeaders } from "./static.ts";

export interface WebServerOptions {
  config: Config;
  services: Services;
  botUsername: string;
}

export function startWebServer({ config, services, botUsername }: WebServerOptions) {
  const app = createWebApp({
    services,
    botToken: config.botToken,
    botUsername,
    origin: config.web.origin,
  });
  const site = new StaticSite(config.web.distDir);
  if (!site.available) console.warn(`Web: no build in ${config.web.distDir}; only the API works (bun run web:build).`);

  const server = Bun.serve({
    port: config.web.port,
    // Bodies are tiny JSON; the API rejects anything larger anyway.
    maxRequestBodySize: 16 * 1024,
    async fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === "/healthz") return new Response("ok");
      const ip = req.headers.get("cf-connecting-ip") ?? srv.requestIP(req)?.address ?? "unknown";
      // Live streams stay open for hours; Bun would close them after its idle timeout.
      if (pathname === "/api/events") srv.timeout(req, 0);
      try {
        if (pathname.startsWith("/api/")) return withSecurityHeaders(await app(req, ip));
        if (req.method !== "GET" && req.method !== "HEAD") return withSecurityHeaders(new Response("Method not allowed", { status: 405 }));
        return await site.serve(pathname);
      } catch (e) {
        console.error("Web request failed:", e);
        return withSecurityHeaders(new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "content-type": "application/json" } }));
      }
    },
  });
  console.log(`Web: listening on :${server.port} (${config.web.origin})`);
  return Object.assign(server, {
    async shutdown() {
      app.close();
      await server.stop(true); // true: also closes the open event streams
    },
  });
}
