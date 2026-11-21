// Link previews (Open Graph). Crawlers (WhatsApp, Telegram, Discord…) don't run the app, so the
// server writes each page's preview tags into index.html (static.ts withMeta) and draws the images:
//
//   GET /api/og/site           the site's card, for every page without one of its own
//   GET /api/og/liity/:code    a pikakutsu's card: group, who invites, members, until when
//
// Only pikakutsu links (/liity/<code>) and the public texts (/help, /terms, /privacy) get their
// own previews. Group pages, screen links and personal pages keep the site's card on purpose:
// they are private, and a preview would show their contents to whoever the link reaches.

import { TIME_ZONE } from "../../lib/format.ts";
import { HOUR_MS, MINUTE_MS } from "../../lib/units.ts";
import { fail } from "../http.ts";
import { inviteCardSvg, OG_HEIGHT, OG_WIDTH, ogPng, siteCardSvg, type CardFrame } from "../ogimage.ts";
import type { PageMeta } from "../static.ts";
import type { Api, Routes } from "./context.ts";
import { limitByIp } from "./guards.ts";
import { isJamCode, pikakutsu } from "./groups.ts";

const SITE_TITLE = "Bläkkiskili";
const SITE_DESCRIPTION = "Promillearvio, juomapäiväkirja ja ryhmät. Telegram-botti ja nettisivu.";
const PAGE_TITLES: Record<string, string> = { "/help": "Ohje", "/terms": "Käyttöehdot", "/privacy": "Tietosuoja" };
/** A card is drawn once and reused this long (crawlers ask again when the link is shared again). */
const CARD_TTL_MS = 5 * MINUTE_MS;
const CARDS_KEPT = 200;

const until = new Intl.DateTimeFormat("fi-FI", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });

export function createOg({ services, opts, now }: Api) {
  const frame: CardFrame = { logo: opts.ogLogo ?? null, host: new URL(opts.origin).host };
  let siteCard: Uint8Array | null = null;
  const site = () => (siteCard ??= ogPng(siteCardSvg(frame)));
  const cards = new Map<string, { png: Uint8Array; at: number; key: string }>();

  /** The pikakutsu's card; a changed name, member count or expiry draws it again. */
  function inviteCard(code: string): Uint8Array | null {
    const p = pikakutsu(services, code);
    if (!p) return null;
    const key = JSON.stringify(p.public);
    const hit = cards.get(code);
    if (hit && hit.key === key && now() - hit.at < CARD_TTL_MS) return hit.png;
    const png = ogPng(inviteCardSvg({ ...p.public, inviter: p.public.startedBy }, frame));
    cards.delete(code);
    cards.set(code, { png, at: now(), key });
    while (cards.size > CARDS_KEPT) cards.delete(cards.keys().next().value!);
    return png;
  }

  const image = (png: Uint8Array, maxAgeS: number) =>
    new Response(png, { headers: { "content-type": "image/png", "cache-control": `public, max-age=${maxAgeS}` } });

  const siteMeta = (url: string, title = SITE_TITLE): PageMeta => ({
    title,
    description: SITE_DESCRIPTION,
    url,
    image: `${opts.origin}/api/og/site`,
    imageWidth: OG_WIDTH,
    imageHeight: OG_HEIGHT,
    imageAlt: "Bläkkiskili",
  });

  /** A page's preview tags, by its path. */
  function meta(pathname: string): PageMeta {
    const url = `${opts.origin}${pathname}`;
    const page = PAGE_TITLES[pathname];
    if (page) return siteMeta(url, `${page} · ${SITE_TITLE}`);
    const m = /^\/liity\/([^/]+)$/.exec(pathname);
    const code = m?.[1];
    if (code && isJamCode(code)) {
      const p = pikakutsu(services, code);
      if (!p) return siteMeta(url, `Pikakutsu · ${SITE_TITLE}`);
      const { groupName, startedBy, memberCount, expiresAt } = p.public;
      return {
        title: `${startedBy} kutsuu sinut ryhmään ${groupName}`,
        description: `Pikakutsu Bläkkiskiliin: ${memberCount} ${memberCount === 1 ? "jäsen" : "jäsentä"}, voimassa ${until.format(expiresAt)} asti. Liity linkistä.`,
        url,
        image: `${opts.origin}/api/og/liity/${code}`,
        imageWidth: OG_WIDTH,
        imageHeight: OG_HEIGHT,
        imageAlt: `Pikakutsu ryhmään ${groupName}`,
      };
    }
    return siteMeta(url);
  }

  const routes: Routes = {
    "/api/og/site": { GET: limitByIp("photo", "og:")(() => image(site(), 24 * 3600)) },
    // An ended or unknown pikakutsu gets the site's card, not an error: the link was shared already.
    "/api/og/liity/:code": {
      GET: limitByIp(
        "photo",
        "og:",
      )((c) => {
        const code = c.param("code", /^[A-Za-z0-9_-]{16,64}$/);
        if (!code) return fail(404, "not_found");
        const card = inviteCard(code);
        return card ? image(card, CARD_TTL_MS / 1000) : image(site(), HOUR_MS / 1000);
      }),
    },
  };

  return { routes, meta };
}
