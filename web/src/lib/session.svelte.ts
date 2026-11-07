import type { Me } from "../../../shared/api.ts";

/** Who is signed in. `ready` turns true once the first /api/me answer is in. */
export const session = $state<{ me: Me | null; ready: boolean; offline: boolean }>({ me: null, ready: false, offline: false });
