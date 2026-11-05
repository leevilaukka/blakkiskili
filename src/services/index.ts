// Domain services. Nothing in here knows about Telegram: callers pass already-derived keys
// (HMACs) plus raw Telegram ids only where the legacy format requires them. This is the
// seam for other front ends (e.g. an HTTP API for Alkometriikka).

import type { Database } from "bun:sqlite";
import type { Crypto } from "../lib/ids.ts";
import { Accounts } from "./accounts.ts";
import { Drinks } from "./drinks.ts";
import { Groups } from "./groups.ts";
import { Stats } from "./stats.ts";
import { Importer } from "./importer.ts";
import { Pending } from "./pending.ts";
import { Inactivity } from "./inactivity.ts";
import { Announcements } from "./announcements.ts";
import { ANNOUNCEMENTS, type Announcement } from "../announcements.ts";
import { Products } from "./products.ts";

export interface Deps {
  db: Database;
  crypto: Crypto;
  now: () => number;
}

export interface ServiceOptions {
  announcements?: readonly Announcement[];
  /** Alko catalogue from Alkometriikka; an empty (disabled) catalogue by default. */
  products?: Products;
}

export function createServices(deps: Deps, opts: ServiceOptions = {}) {
  const accounts = new Accounts(deps);
  const drinks = new Drinks(deps, accounts);
  const groups = new Groups(deps);
  const stats = new Stats(deps);
  const importer = new Importer(deps, accounts);
  const pending = new Pending(deps);
  const inactivity = new Inactivity(deps, accounts);
  const announcements = new Announcements(deps, opts.announcements ?? ANNOUNCEMENTS);
  const products = opts.products ?? new Products();
  return { accounts, drinks, groups, stats, importer, pending, inactivity, announcements, products, deps };
}

export type Services = ReturnType<typeof createServices>;
