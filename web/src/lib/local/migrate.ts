// Moving a local account online: after signing in (or signing up) on the server, the device's
// drinks and favourites are sent to that account in batches, and the local copy is deleted only
// once every batch has gone through. The server skips drinks it already has, so a move cut short
// (a lost connection) is simply done again.
//
// "Siirrä verkkoon" in Settings sets a flag and goes to the sign-in page; whichever way the person
// signs in, the page that ends the sign-in calls finishMove(). The flag is in sessionStorage so it
// survives the redirect to Google, Microsoft or Telegram and back, but not a closed tab.

import type { LocalImportResult } from "../../../../shared/api.ts";
import { api } from "../api.ts";
import { me as localMe, type LocalData } from "./core.ts";
import { clearLocal, loadLocal } from "./store.ts";
import { session } from "../session.svelte.ts";

const FLAG = "kili-move-local";
/** The server's batch limit (LOCAL_IMPORT_BATCH in src/web/api/account.ts). */
const BATCH = 500;

export function setMoving(on: boolean) {
  try {
    if (on) sessionStorage.setItem(FLAG, "1");
    else sessionStorage.removeItem(FLAG);
  } catch {}
}

export function isMoving(): boolean {
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

/** Sends the local account's data to the signed-in account, then deletes it from the device. */
export async function moveToAccount(data?: LocalData | null): Promise<LocalImportResult | null> {
  data ??= await loadLocal();
  if (!data) return null;
  session.local = false; // from here on api calls go to the server account
  const total: LocalImportResult = { inserted: 0, duplicates: 0, invalid: 0, favorites: 0 };
  const drinks = data.drinks.map(({ id: _id, ...d }) => d);
  const favorites = data.favorites.map(({ id: _id, createdAt: _c, ...f }) => f);
  for (let i = 0; i === 0 || i < drinks.length; i += BATCH) {
    const r = await api.localImport({ drinks: drinks.slice(i, i + BATCH), ...(i === 0 ? { favorites } : {}) });
    total.inserted += r.inserted;
    total.duplicates += r.duplicates;
    total.invalid += r.invalid;
    total.favorites += r.favorites;
  }
  await clearLocal();
  setMoving(false);
  return total;
}

/** Called where a sign-in or sign-up ends: finishes a move the person asked for. A sentence for the page, or null. */
export async function finishMove(): Promise<string | null> {
  if (!isMoving()) return null;
  const r = await moveToAccount();
  if (!r) {
    setMoving(false);
    return null;
  }
  return `Tämän laitteen tiedot siirrettiin tunnukseen: ${r.inserted} juomaa${r.favorites ? ` ja ${r.favorites} suosikkia` : ""}.`;
}

/** The profile of the device's local account, to fill in the sign-up form when moving. */
export async function localProfile() {
  const d = await loadLocal();
  return d ? localMe(d) : null;
}
