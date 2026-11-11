// Serves the built SvelteKit app (web/build) with an SPA fallback, and the response headers every
// page and API answer carries.
//
// Content-Security-Policy: SvelteKit's static output has one small inline bootstrap script per
// page. Instead of allowing 'unsafe-inline' scripts, the policy lists the sha256 of exactly the
// inline scripts in the HTML being served, so injected markup can't run.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    if (m[1]) hashes.push(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  }
  return hashes;
}

// Telegram sign-in is a redirect to oauth.telegram.org and back (see web/src/routes/login), so no
// page loads Telegram's widget script: it builds its callback with eval(), which this policy forbids.
export function contentSecurityPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the barcode scanner compile its WebAssembly decoder (served from
    // here); it does not allow eval() or any other JavaScript from strings.
    `script-src 'self' ${scriptHashes.join(" ")} 'wasm-unsafe-eval'`.replace(/ +/g, " "),
    "style-src 'self'",
    "img-src 'self' data:", // Alko's photos come through our own /api (see photos.ts)
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  // Screen links carry a secret in the URL: never send it on as a referrer.
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  // The camera is for the barcode scanner on our own pages only.
  "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=()",
};

export function withSecurityHeaders(res: Response, csp?: string): Response {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.headers.set(k, v);
  if (csp) res.headers.set("content-security-policy", csp);
  return res;
}

export class StaticSite {
  private readonly root: string;
  private readonly htmlCache = new Map<string, { modified: number; html: string; csp: string }>();

  constructor(distDir: string) {
    this.root = resolve(distDir);
  }

  get available(): boolean {
    return existsSync(join(this.root, "index.html"));
  }

  async serve(pathname: string): Promise<Response> {
    if (!this.available) return withSecurityHeaders(new Response("The website has not been built (bun run web:build).", { status: 503 }));
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname));
    } catch {
      return withSecurityHeaders(new Response("Bad request", { status: 400 }));
    }
    const file = resolve(join(this.root, rel));
    // A path that escapes the build directory (../, encoded, absolute) is never served.
    if (file !== this.root && !file.startsWith(this.root + sep)) return withSecurityHeaders(new Response("Not found", { status: 404 }));

    if (rel !== sep && rel !== "." && /\.[a-z0-9]+$/i.test(rel)) {
      if (!existsSync(file) || !statSync(file).isFile()) return withSecurityHeaders(new Response("Not found", { status: 404 }));
      if (file.endsWith(".html")) return this.page(file, pathname);
      const immutable = rel.includes(`${sep}_app${sep}immutable${sep}`) || rel.includes(`_app${sep}immutable`);
      return withSecurityHeaders(
        new Response(Bun.file(file), {
          headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300" },
        }),
      );
    }
    // Routes of the single-page app all get index.html.
    return this.page(join(this.root, "index.html"), pathname);
  }

  private async page(file: string, pathname: string): Promise<Response> {
    let cached = this.htmlCache.get(file);
    const modified = Bun.file(file).lastModified; // a rebuild during development is picked up
    if (!cached || cached.modified !== modified) {
      const html = await Bun.file(file).text();
      const hashes = inlineScriptHashes(html);
      cached = { modified, html, csp: contentSecurityPolicy(hashes) };
      this.htmlCache.set(file, cached);
    }
    return withSecurityHeaders(
      new Response(cached.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } }),
      cached.csp,
    );
  }
}
