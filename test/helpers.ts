import { openDatabase } from "../src/db/index.ts";
import { createCrypto } from "../src/lib/ids.ts";
import { createServices } from "../src/services/index.ts";
import type { Announcement } from "../src/announcements.ts";
import type { Products } from "../src/services/products.ts";

export const TEST_SECRET = "test-secret-test-secret-test-secret-123";

/** Services on a fresh in-memory database with a controllable clock. */
export function setup(start = Date.parse("2026-11-06T20:00:00Z"), announcements: Announcement[] = [], products?: Products) {
  const clock = { now: start };
  const db = openDatabase(":memory:");
  const crypto = createCrypto(TEST_SECRET);
  const services = createServices({ db, crypto, now: () => clock.now }, { announcements, products });
  return { db, crypto, services, clock };
}

/** A Telegram login, as passed to accounts.register and identities. */
export const tg = (id: number) => ({ platform: "telegram", platformUserId: id }) as const;
