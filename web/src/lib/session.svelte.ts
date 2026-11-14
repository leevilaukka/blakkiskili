import type { Me } from "../../../shared/api.ts";

/** Who is signed in. `ready` turns true once the first /api/me answer is in. */
export const session = $state<{ me: Me | null; ready: boolean; offline: boolean }>({ me: null, ready: false, offline: false });

// A page opened while signed out (a group link the bot's /web gave in a group chat) is kept for
// the sign-in page to return to. sessionStorage, so it survives Telegram's sign-in redirect.
const RETURN_KEY = "kili-return";

export function rememberReturn(path: string) {
  try {
    if (path !== "/") sessionStorage.setItem(RETURN_KEY, path);
  } catch {}
}

/** The kept page, once; only a path on this site. */
export function takeReturn(): string | null {
  try {
    const path = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return path && /^\/(?![/\\])/.test(path) ? path : null;
  } catch {
    return null;
  }
}
