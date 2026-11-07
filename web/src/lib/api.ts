// Typed client for the bot's JSON API (src/web/app.ts). Same origin, so the session cookie goes
// along by itself; state-changing calls also send the custom header the server requires (a
// cross-site form can't), and the browser adds the Origin header on its own.

import type { Config, Dashboard, DrinkItem, LogDrinkRequest, Me, ProductItem } from "../../../shared/api.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "x-kili": "1" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, typeof data?.error === "string" ? data.error : "error");
  return data as T;
}

export const api = {
  config: () => request<Config>("GET", "/api/config"),
  me: () => request<Me>("GET", "/api/me"),
  patchMe: (changes: Partial<Pick<Me, "chartName" | "weight" | "height" | "gender">>) => request<Me>("PATCH", "/api/me", changes),
  dashboard: () => request<Dashboard>("GET", "/api/dashboard"),
  products: (q: string) => request<{ products: ProductItem[] }>("GET", `/api/products?q=${encodeURIComponent(q)}`),
  log: (drink: LogDrinkRequest) => request<DrinkItem>("POST", "/api/drinks", drink),
  undo: () => request<DrinkItem>("POST", "/api/drinks/undo", {}),
  remove: (id: number) => request<{ ok: true }>("DELETE", `/api/drinks/${id}`),
  signInWithTelegram: (widgetData: unknown) => request<{ ok: true }>("POST", "/api/auth/telegram", widgetData),
  signInWithLink: (token: string) => request<{ ok: true }>("POST", "/api/auth/link", { token }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
};

/** Finnish texts for the error codes the API returns. */
export function errorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "network";
  const texts: Record<string, string> = {
    unauthorized: "Istunto on päättynyt. Kirjaudu uudelleen.",
    rate_limited: "Liian monta pyyntöä, yritä hetken päästä uudelleen.",
    invalid_amount: "Tarkista määrä ja prosentti.",
    too_much: "Alkoholin määrä on liian suuri. Tarkista numerot.",
    unknown_preset: "Tuntematon juoma.",
    unknown_product: "Tuotetta ei löytynyt.",
    nothing_to_undo: "Ei peruttavaa juomaa.",
    nothing_to_repeat: "Ei aiempaa juomaa toistettavaksi.",
    invalid_weight: "Paino ei kelpaa.",
    invalid_height: "Pituus ei kelpaa.",
    not_registered: "Tällä Telegram-tilillä ei ole tunnusta. Luo tunnus ensin botissa (/start).",
    invalid_link: "Linkki on vanhentunut tai jo käytetty. Lähetä botille /web saadaksesi uuden.",
    bad_signature: "Telegram-kirjautumista ei voitu vahvistaa.",
    expired: "Kirjautuminen vanheni. Yritä uudelleen.",
    network: "Yhteys palvelimeen ei toimi.",
  };
  return texts[code] ?? "Jokin meni pieleen. Yritä uudelleen.";
}
