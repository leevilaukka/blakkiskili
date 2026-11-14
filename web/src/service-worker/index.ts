// The service worker that makes the site installable as an app and lets it open without a
// connection (it then shows the layout's "offline" notice). It caches only the app itself: the
// built files, `static/` and the index.html shell. Nothing under /api is ever cached, so no
// drinks, groups or session data are stored on the device by it.
//
// Pages are network first (a deploy is seen at once); the shell from the cache is the fallback
// when the network fails or answers 5xx (the bot restarting, Cloudflare's 502). Built files have
// hashed names, so they are served from the cache.

import { self } from "$app/service-worker";
import { immutable, assets } from "$app/manifest";
import { version } from "$app/env";

const CACHE = `kili-${version}`;
const SHELL = "/";
// The barcode decoder (~1 MB) is cached when first used, not on install.
// The manifest's paths are relative to the base path, which is the site root here.
const IMMUTABLE = new Set(immutable.map((f) => `/${f.path}`));
const ASSETS = new Set(assets.map((f) => `/${f.path}`));
const PRECACHE = [...[...IMMUTABLE].filter((p) => !p.endsWith(".wasm")), ...ASSETS, SHELL];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function page(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.status < 500) {
      // Every route answers with the same index.html: keep the newest as the shell.
      // (A redirected response can't answer a later navigation.)
      if (res.ok && !res.redirected && res.headers.get("content-type")?.startsWith("text/html")) await cache.put(SHELL, res.clone());
      return res;
    }
    return (await cache.match(SHELL)) ?? res;
  } catch (e) {
    const shell = await cache.match(SHELL);
    if (shell) return shell;
    throw e;
  }
}

async function cacheFirst(request: Request, path: string): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(path);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && IMMUTABLE.has(path)) await cache.put(path, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(page(request));
  } else if (IMMUTABLE.has(url.pathname) || ASSETS.has(url.pathname)) {
    event.respondWith(cacheFirst(request, url.pathname));
  }
});
