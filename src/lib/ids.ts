// Identity hashing and field encryption.
//
// Platform user ids (Telegram, later e.g. Discord) and chat ids are never stored raw. They are stored as HMAC-SHA256 under a key
// derived from APP_SECRET, so a leaked database file alone can't be mapped back to Telegram
// accounts by hashing candidate IDs (which is possible with the original bot's plain sha256).
// Display names are encrypted with AES-256-GCM under a second derived key.
//
// Losing or changing APP_SECRET makes every stored account unreachable. Back it up.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/** Chat platforms a kili account can be used from. */
export const PLATFORMS = ["telegram", "discord"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (s: string): s is Platform => (PLATFORMS as readonly string[]).includes(s);

export interface Crypto {
  /** Key of one platform login (an identity). Discord ids exceed 2^53, so pass them as strings. */
  identityKey(platform: Platform, platformUserId: string | number): string;
  groupKey(telegramChatId: number): string;
  /** Lookup key for a one-time account-linking code. */
  linkCodeKey(code: string): string;
  /** Lookup key for a website token (session, login link, screen link). Only the hash is stored. */
  webTokenKey(token: string): string;
  encrypt(plain: string): string;
  decrypt(token: string): string;
}

export function createCrypto(appSecret: string): Crypto {
  if (appSecret.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
  // The salt and info labels are part of key derivation: changing them after deployment
  // makes all stored data unreachable, just like changing APP_SECRET.
  const derive = (info: string) =>
    Buffer.from(hkdfSync("sha256", appSecret, "blakkiskili", info, 32));
  const idKey = derive("id-hmac");
  const dataKey = derive("data-aes-gcm");

  const hmac = (kind: string, id: string | number) =>
    createHmac("sha256", idKey).update(`${kind}:${id}`).digest("hex");

  return {
    // Telegram keeps the label it had before other platforms existed, so stored keys stay valid.
    identityKey: (platform, id) => hmac(platform === "telegram" ? "user" : `${platform}-user`, id),
    groupKey: (id) => hmac("group", id),
    linkCodeKey: (code) => hmac("link-code", code),
    webTokenKey: (token) => hmac("web-token", token),
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
    },
    decrypt(token) {
      const [iv, tag, body] = token.split(".").map((part) => Buffer.from(part, "base64url"));
      if (!iv || !tag || !body) throw new Error("Malformed encrypted value");
      const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    },
  };
}

/**
 * The original bot's identifier: unsalted sha256 of the decimal Telegram ID.
 * Only used to verify that an imported /data export belongs to the sender, and to
 * recognise the sender's old groups. Never stored for users.
 */
export function legacyHash(telegramId: number): string {
  return createHash("sha256").update(String(telegramId)).digest("hex");
}
