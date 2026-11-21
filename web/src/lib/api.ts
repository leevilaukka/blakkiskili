// Typed client for the bot's JSON API (src/web/app.ts). Same origin, so the session cookie goes
// along by itself; state-changing calls also send the custom header the server requires (a
// cross-site form can't), and the browser adds the Origin header on its own.

import type {
  AdminView,
  BarcodeResult,
  ChartData,
  Config,
  CustomProductRequest,
  Dashboard,
  DrinkItem,
  DocBlock,
  DocPage,
  DrinkLog,
  Favorites,
  ImportOutcome,
  GroupSummary,
  GroupView,
  LogDrinkRequest,
  LoginPlatform,
  LoginsView,
  Me,
  ProductItem,
  ScreenLinkItem,
  ScreenView,
  SessionsInfo,
  SignupRequest,
} from "../../../shared/api.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * The error of a failed response. A 502–504 without our JSON body is Cloudflare's own page while
 * the bot is down or restarting, so it reads as a lost connection, not as a failed request.
 */
export async function responseError(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => null);
  if (typeof data?.error === "string") return new ApiError(res.status, data.error);
  return new ApiError(res.status, res.status >= 502 && res.status <= 504 ? "network" : "error");
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
  if (!res.ok) throw await responseError(res);
  return (await res.json().catch(() => ({}))) as T;
}

/** POST of a raw text body (an imported CSV file). */
async function postText<T>(path: string, text: string): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "text/csv", "x-kili": "1" }, body: text });
  if (!res.ok) throw await responseError(res);
  return (await res.json().catch(() => ({}))) as T;
}

export const api = {
  config: () => request<Config>("GET", "/api/config"),
  docs: (page: DocPage) => request<{ blocks: DocBlock[] }>("GET", `/api/docs/${page}`),
  favorites: () => request<Favorites>("GET", "/api/favorites"),
  pinFavorite: (drinkId: number) => request<Favorites>("POST", "/api/favorites", { drinkId }),
  unpinFavorite: (id: number) => request<Favorites>("DELETE", `/api/favorites/${id}`),
  importFile: (text: string) => postText<ImportOutcome>("/api/account/import", text),
  deleteAccount: () => request<{ ok: true }>("DELETE", "/api/account", { confirm: true }),
  me: () => request<Me>("GET", "/api/me"),
  patchMe: (changes: Partial<Pick<Me, "name" | "chartName" | "weight" | "height" | "gender">>) => request<Me>("PATCH", "/api/me", changes),
  dashboard: () => request<Dashboard>("GET", "/api/dashboard"),
  products: (q: string) => request<{ products: ProductItem[] }>("GET", `/api/products?q=${encodeURIComponent(q)}`),
  barcode: (ean: string) => request<BarcodeResult>("GET", `/api/barcodes/${encodeURIComponent(ean)}`),
  saveCustomProduct: (ean: string, product: CustomProductRequest) =>
    request<BarcodeResult>("PUT", `/api/barcodes/${encodeURIComponent(ean)}/product`, product),
  deleteCustomProduct: (ean: string) => request<{ ok: true }>("DELETE", `/api/barcodes/${encodeURIComponent(ean)}/product`),
  /** "Ilmoita virheestä" on a user-added product. */
  reportCustomProduct: (ean: string, message: string) =>
    request<{ ok: true }>("POST", `/api/barcodes/${encodeURIComponent(ean)}/report`, { message }),
  log: (drink: LogDrinkRequest) => request<DrinkItem>("POST", "/api/drinks", drink),
  /** The logbook; see DrinkLog for the parameters. */
  drinks: (filter: { from?: number; to?: number; q?: string; before?: string; limit?: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request<DrinkLog>("GET", `/api/drinks?${params}`);
  },
  /** The estimate over a past session, first to last drink (epoch ms). */
  sessionChart: (from: number, to: number) => request<ChartData>("GET", `/api/drinks/chart?from=${from}&to=${to}`),
  lastDrink: () => request<{ drink: DrinkItem | null }>("GET", "/api/drinks/last"),
  undo: () => request<DrinkItem>("POST", "/api/drinks/undo", {}),
  remove: (id: number) => request<{ ok: true }>("DELETE", `/api/drinks/${id}`),
  signInWithTelegram: (widgetData: unknown) => request<{ ok: true }>("POST", "/api/auth/telegram", widgetData),
  signInWithLink: (token: string) => request<{ ok: true }>("POST", "/api/auth/link", { token }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  logoutEverywhere: () => request<{ ok: true; sessions: number }>("POST", "/api/auth/logout-all", {}),
  sessions: () => request<SessionsInfo>("GET", "/api/auth/sessions"),

  // Sign-in methods besides Telegram (#lib/logins.ts drives them) and the account's logins.
  oauthStart: (platform: "google" | "microsoft", link: boolean) => request<{ url: string }>("POST", `/api/auth/${platform}/${link ? "link" : "start"}`, {}),
  signupInfo: () => request<{ method: LoginPlatform }>("GET", "/api/auth/signup"),
  signup: (req: SignupRequest) => request<{ ok: true }>("POST", "/api/auth/signup", req),
  logins: () => request<LoginsView>("GET", "/api/auth/logins"),
  removeLogin: (platform: LoginPlatform) => request<LoginsView>("DELETE", `/api/auth/logins/${platform}`),
  linkTelegram: (widgetData: unknown) => request<LoginsView>("POST", "/api/auth/telegram/link", widgetData),
  passkeyLoginOptions: () => request<Record<string, unknown>>("POST", "/api/auth/passkey/login/options", {}),
  passkeyLogin: (response: unknown) => request<{ ok: true }>("POST", "/api/auth/passkey/login", { response }),
  passkeySignupOptions: (name: string) => request<Record<string, unknown>>("POST", "/api/auth/passkey/signup/options", { name }),
  passkeyAddOptions: () => request<Record<string, unknown>>("POST", "/api/auth/passkey/add/options", {}),
  passkeyAdd: (response: unknown) => request<{ ok: true }>("POST", "/api/auth/passkey/add", { response }),
  removePasskey: (id: string) => request<{ ok: true }>("DELETE", `/api/auth/passkeys/${encodeURIComponent(id)}`),

  admin: () => request<AdminView>("GET", "/api/admin"),
  adminDeleteProduct: (ean: string) => request<{ ok: true }>("DELETE", `/api/admin/products/${ean}`),
  adminClearReports: (ean: string) => request<{ ok: true }>("DELETE", `/api/admin/products/${ean}/reports`),
  adminTrustAdder: (ref: string, trusted: boolean) => request<{ ok: true; notified: boolean }>("PUT", `/api/admin/adders/${ref}`, { trusted }),

  groups: () => request<{ groups: GroupSummary[] }>("GET", "/api/groups"),
  createGroup: (name: string) => request<GroupSummary>("POST", "/api/groups", { name }),
  joinGroup: (code: string) => request<{ id: string }>("POST", "/api/groups/join", { code }),
  group: (id: string) => request<GroupView>("GET", `/api/groups/${id}`),
  renameGroup: (id: string, name: string) => request<GroupView>("PATCH", `/api/groups/${id}`, { name }),
  hideOnScreens: (id: string, hideOnScreen: boolean) => request<GroupView>("PATCH", `/api/groups/${id}/me`, { hideOnScreen }),
  leaveGroup: (id: string) => request<{ ok: true }>("POST", `/api/groups/${id}/leave`, {}),
  deleteGroup: (id: string) => request<{ ok: true }>("DELETE", `/api/groups/${id}`),
  removeMember: (id: string, ref: string) => request<{ ok: true }>("DELETE", `/api/groups/${id}/members/${ref}`),
  createInvite: (id: string) => request<{ code: string; expiresAt: number }>("POST", `/api/groups/${id}/invite`, {}),
  revokeInvite: (id: string) => request<{ ok: true }>("DELETE", `/api/groups/${id}/invite`),
  createGroupScreen: (id: string, hours: number) => request<{ token: string; expiresAt: number }>("POST", `/api/groups/${id}/screens`, { hours }),
  revokeGroupScreen: (id: string, ref: string) => request<{ ok: true }>("DELETE", `/api/groups/${id}/screens/${ref}`),

  myScreens: () => request<{ screens: ScreenLinkItem[] }>("GET", "/api/screens"),
  createMyScreen: (hours: number) => request<{ token: string; expiresAt: number }>("POST", "/api/screens", { hours }),
  revokeMyScreen: (ref: string) => request<{ ok: true }>("DELETE", `/api/screens/${ref}`),

  openScreen: (token: string) => request<{ ok: true }>("POST", "/api/screen/open", { token }),
  screen: () => request<ScreenView>("GET", "/api/screen"),
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
    invalid_name: "Nimi ei kelpaa (1–40 merkkiä).",
    too_many_groups: "Sinulla on jo liian monta ryhmää.",
    too_many_screens: "Tällä on jo liian monta näyttölinkkiä. Peru joku niistä ensin.",
    too_many_streams: "Liian monta avointa välilehteä.",
    invalid_invite: "Kutsu on vanhentunut tai väärä. Pyydä uusi kutsulinkki.",
    already_member: "Olet jo tässä ryhmässä.",
    group_full: "Ryhmä on täynnä.",
    not_owner: "Vain ryhmän perustaja voi tehdä tämän.",
    telegram_group: "Telegram-ryhmää hallitaan Telegramissa.",
    use_leave: "Poistu ryhmästä omalla painikkeella.",
    invalid_screen: "Näyttölinkki on vanhentunut tai peruttu.",
    not_found: "Ei löytynyt.",
    invalid_barcode: "Viivakoodi ei kelpaa. Tarkista numerot.",
    barcode_rate_limited: "Viivakoodeja on haettu juuri paljon. Kokeile hetken päästä uudelleen.",
    barcode_unavailable: "Viivakoodin haku ei onnistunut juuri nyt. Kokeile myöhemmin uudelleen.",
    barcodes_off: "Viivakoodit eivät ole käytössä.",
    invalid_kind: "Valitse, mikä juoma on kyseessä.",
    invalid_product_name: "Nimen pitää olla 1–60 merkkiä.",
    invalid_size: "Koon pitää olla 1 cl – 5 l.",
    invalid_abv: "Alkoholiprosentin pitää olla 1–99 %.",
    invalid_kcal: "Energian pitää olla 0–999 kcal / 100 ml, tai jätä kenttä tyhjäksi.",
    no_serving: "Tästä ei saa järkevän kokoista annosta. Tarkista koko ja prosentti.",
    in_catalogue: "Viivakoodi löytyy Alkon valikoimasta, joten sille ei voi lisätä omaa tuotetta.",
    not_allowed: "Vain tuotteen lisääjä tai ylläpitäjä voi muuttaa sitä.",
    too_many_products: "Olet lisännyt jo niin monta tuotetta, ettei enempää voi lisätä. Ylläpitäjät voivat vahvistaa tunnuksesi, jolloin rajaa ei ole.",
    products_full: "Tuotteita on lisätty jo niin paljon, ettei uusia voi lisätä juuri nyt. Kerro ylläpitäjille.",
    invalid_report: "Kirjoita viesti, enintään 300 merkkiä.",
    too_many_reports: "Sinulla on jo monta käsittelemätöntä ilmoitusta. Kokeile uudelleen, kun ylläpitäjät ovat käsitelleet niitä.",
    invalid_time: "Ajan pitää olla enintään viikon takaa, eikä tulevaisuudessa.",
    no_telegram: "Tälle tunnukselle ei löydy Telegram-kirjautumista, jota tietojen lataus ja tuonti tarvitsevat.",
    // Sign-in, sign-up and logins
    cancelled: "Kirjautuminen keskeytettiin.",
    invalid_state: "Kirjautuminen vanheni tai aloitettiin toisessa selaimessa. Yritä uudelleen.",
    provider_failed: "Kirjautumista ei voitu vahvistaa. Yritä uudelleen.",
    no_signup: "Tunnuksen luominen vanheni. Kirjaudu uudelleen.",
    terms_not_accepted: "Hyväksy käyttöehdot luodaksesi tunnuksen.",
    invalid_user_name: "Nimimerkin pitää olla 2–32 merkkiä, eikä se voi alkaa @-merkillä.",
    invalid_gender: "Valitse sukupuoli.",
    telegram_name: "Nimesi tulee Telegramista, ja botti pitää sen ajan tasalla.",
    current_login: "Tällä selaimella on kirjauduttu tällä tavalla. Kirjaudu ensin toisella tavalla, jos haluat poistaa sen.",
    last_login: "Tunnukseen pitää jäädä ainakin yksi toimiva kirjautumistapa.",
    already_linked: "Tämä kirjautumistapa on jo tunnuksessasi.",
    has_account: "Tällä kirjautumisella on jo oma tunnus. Tunnuksia ei voi yhdistää.",
    platform_taken: "Tunnukseen on jo lisätty toinen samanlainen kirjautuminen. Poista se ensin.",
    passkey_expired: "Pääsyavaimen pyyntö vanheni. Yritä uudelleen.",
    passkey_failed: "Pääsyavainta ei voitu vahvistaa.",
    passkey_exists: "Tämä pääsyavain on jo käytössä.",
    unknown_passkey: "Tuntematon pääsyavain. Se on ehkä poistettu tunnuksesta.",
    too_many_passkeys: "Tunnuksella on jo enimmäismäärä pääsyavaimia.",
    passkey_unsupported: "Tämä selain ei tue pääsyavaimia.",
    too_big: "Tiedosto on liian suuri.",
    network: "Yhteys palvelimeen ei toimi.",
  };
  return texts[code] ?? "Jokin meni pieleen. Yritä uudelleen.";
}
