// The API calls a local account answers itself (see core.ts), in the shapes of #lib/api.ts. api.ts
// routes a call here while the person uses a local account; calls with no local meaning (groups,
// screen links, data import…) answer "local_only" there instead.

import type { LogDrinkRequest, Me, ServingDrink } from "../../../../shared/api.ts";
import * as core from "./core.ts";
import { clearLocal, loadLocal, mutate } from "./store.ts";

export function localApi(serving: (productId: string, key: string) => Promise<ServingDrink>) {
  const now = () => Date.now();
  const read = async () => {
    const d = await loadLocal();
    if (!d) throw new core.LocalError(401, "unauthorized");
    return d;
  };
  return {
    me: async () => core.me(await read()),
    patchMe: (changes: Partial<Pick<Me, "name" | "weight" | "height" | "gender">>) => mutate((d) => core.updateProfile(d, changes)),
    dashboard: async () => core.dashboard(await read(), now()),
    log: (r: LogDrinkRequest) => mutate(async (d) => core.toItem(await core.logDrink(d, r, now(), serving))),
    drinks: async (f: core.LogFilter) => core.logbook(await read(), f),
    sessionChart: async (from: number, to: number) => core.sessionChart(await read(), from, to, now()),
    lastDrink: async () => {
      const last = core.lastDrink(await read());
      return { drink: last ? core.toItem(last) : null };
    },
    undo: () => mutate((d) => core.toItem(core.undo(d))),
    remove: (id: number) => mutate((d) => (core.removeDrink(d, id), { ok: true as const })),
    favorites: async () => core.favorites(await read()),
    pinFavorite: (drinkId: number) => mutate((d) => core.pinFavorite(d, drinkId, now())),
    unpinFavorite: (id: number) => mutate((d) => core.unpinFavorite(d, id)),
    deleteAccount: async () => {
      await clearLocal();
      return { ok: true as const };
    },
    // Nothing to sign out of: the account is the device's.
    logout: async () => ({ ok: true as const }),
  };
}
