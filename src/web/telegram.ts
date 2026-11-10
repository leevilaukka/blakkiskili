// Verifies the data the Telegram Login Widget hands to the page.
// https://core.telegram.org/widgets/login#checking-authorization
//
// The widget signs the user's fields with HMAC-SHA256 under SHA256(bot token). We recompute the
// signature, compare in constant time, and reject old logins so a captured payload can't be
// replayed later.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LOGIN_MAX_AGE_S = 5 * 60;
const FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date"] as const;

export type LoginCheck = { ok: true; telegramId: number } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyTelegramLogin(data: unknown, botToken: string, nowMs: number): LoginCheck {
  if (typeof data !== "object" || data === null) return { ok: false, reason: "malformed" };
  const d = data as Record<string, unknown>;
  const hash = d.hash;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed" };

  // Only the fields the widget documents take part; anything else the client adds is ignored.
  const pairs: string[] = [];
  for (const key of [...FIELDS].sort()) {
    const v = d[key];
    if (v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number") return { ok: false, reason: "malformed" };
    pairs.push(`${key}=${v}`);
  }
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(pairs.join("\n")).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  const id = Number(d.id);
  const authDate = Number(d.auth_date);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(authDate)) return { ok: false, reason: "malformed" };
  const age = nowMs / 1000 - authDate;
  if (age > LOGIN_MAX_AGE_S || age < -60) return { ok: false, reason: "expired" };
  return { ok: true, telegramId: id };
}
