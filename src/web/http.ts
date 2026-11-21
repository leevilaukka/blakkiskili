// Small HTTP helpers for the JSON API: responses, cookies and request bodies.

import type { PhotoResult } from "./photos.ts";

const MAX_BODY = 4 * 1024;

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const fail = (status: number, error: string) => json({ error }, status);

export function photoResponse(photo: PhotoResult, maxAgeS: number): Response {
  if (photo === "missing") return fail(404, "no_photo");
  if (photo === "unavailable") return fail(502, "photo_unavailable");
  return new Response(photo.bytes, {
    headers: { "content-type": photo.type, "cache-control": `private, max-age=${maxAgeS}` },
  });
}

/** A JSON object body of at most 4 KiB (or `max` bytes); null for anything else. */
export async function readJsonBody(req: Request, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > max) return null;
  try {
    const text = await req.text();
    if (text.length > max) return null;
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The session and event-screen cookies. __Host- needs Secure, so not on http://localhost. */
export function cookieJar(secure: boolean, now: () => number) {
  const attributes = (maxAgeS: number) => `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  return {
    session: secure ? "__Host-kili" : "kili",
    screen: secure ? "__Host-kili-screen" : "kili-screen",
    /** Sign-in in progress (api/logins.ts, api/passkeys.ts): keys of authflows.ts entries. */
    oauth: secure ? "__Host-kili-oauth" : "kili-oauth",
    passkey: secure ? "__Host-kili-passkey" : "kili-passkey",
    signup: secure ? "__Host-kili-signup" : "kili-signup",
    /** A Set-Cookie value that lasts until `expiresAt`. */
    set: (name: string, value: string, expiresAt: number) => `${name}=${value}${attributes(Math.max(0, Math.floor((expiresAt - now()) / 1000)))}`,
    clear: (name: string) => `${name}=${attributes(0)}`,
  };
}

export type Cookies = ReturnType<typeof cookieJar>;
