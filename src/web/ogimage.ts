// Link preview images (Open Graph, 1200 × 630): the site's card, and a pikakutsu's card with the
// group's name. Drawn as SVG and turned into PNG by resvg (src/lib/render.ts), like /kuvaaja.
//
// A pikakutsu card shows only what its /liity page shows anyone with the link: who invites (not
// named if they appear anonymously on screens), the group, how many members, until when.

import { escapeHtml, TIME_ZONE } from "../lib/format.ts";
import { svgToPng } from "../lib/render.ts";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const RED = "#52000a"; // --color-brand-4
const RED_LIGHT = "#960f0f"; // --color-brand-3
const INK_SOFT = "#f3d9db";
const FONT = "DejaVu Sans, sans-serif";

const xml = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

/** Words into at most `lines` lines of about `width` characters; the last one ends in "…" if cut. */
export function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if ([...next].length <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = word;
  }
  if (line) out.push(line);
  const kept = out.slice(0, lines).map((l) => ([...l].length > width ? [...l].slice(0, width - 1).join("") + "…" : l));
  if (out.length > lines) kept[lines - 1] = [...kept[lines - 1]!].slice(0, width - 1).join("").trimEnd() + "…";
  return kept;
}

/** What every card has: the logo, the background and the site's host name at the bottom. */
export interface CardFrame {
  logo: Uint8Array | null;
  host: string;
}

function frame(body: string, { logo, host }: CardFrame): string {
  const image = logo
    ? `<clipPath id="r"><rect x="80" y="80" width="200" height="200" rx="28"/></clipPath>
       <image href="data:image/jpeg;base64,${Buffer.from(logo).toString("base64")}" x="80" y="80" width="200" height="200" clip-path="url(#r)" preserveAspectRatio="xMidYMid slice"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${RED_LIGHT}"/><stop offset="1" stop-color="${RED}"/></linearGradient></defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#g)"/>
  ${image}
  ${body}
  <text x="80" y="570" font-family="${FONT}" font-size="30" fill="${INK_SOFT}">${xml(host)}</text>
</svg>`;
}

/** The site's own card (every link without a card of its own). */
export function siteCardSvg(f: CardFrame): string {
  return frame(
    `<text x="320" y="200" font-family="${FONT}" font-size="96" font-weight="bold" fill="#fff">Bläkkiskili</text>
  <text font-family="${FONT}" font-size="40" fill="${INK_SOFT}">
    <tspan x="80" y="390">Promillearvio, juomapäiväkirja ja ryhmät.</tspan>
    <tspan x="80" y="450">Telegram-botti ja nettisivu.</tspan>
  </text>`,
    f,
  );
}

export interface InviteCard {
  groupName: string;
  inviter: string;
  memberCount: number;
  expiresAt: number;
}

const until = new Intl.DateTimeFormat("fi-FI", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });

export function inviteCardSvg(c: InviteCard, f: CardFrame): string {
  const long = [...c.groupName].length > 18;
  const size = long ? 64 : 88;
  const name = wrap(c.groupName, long ? 26 : 18, 2);
  const nameY = 400 - (name.length - 1) * size * 0.55;
  const inviter = wrap(`${c.inviter} kutsuu sinut ryhmään`, 40, 1)[0]!;
  return frame(
    `<text x="320" y="150" font-family="${FONT}" font-size="34" font-weight="bold" fill="${INK_SOFT}" letter-spacing="3">PIKAKUTSU</text>
  <text x="320" y="220" font-family="${FONT}" font-size="40" fill="#fff">${xml(inviter)}</text>
  <text font-family="${FONT}" font-size="${size}" font-weight="bold" fill="#fff">
    ${name.map((l, i) => `<tspan x="80" y="${Math.round(nameY + i * size * 1.1)}">${xml(l)}</tspan>`).join("")}
  </text>
  <text x="80" y="${Math.round(nameY + (name.length - 1) * size * 1.1 + 70)}" font-family="${FONT}" font-size="36" fill="${INK_SOFT}">${xml(
    `${c.memberCount} ${c.memberCount === 1 ? "jäsen" : "jäsentä"} · voimassa ${until.format(c.expiresAt)} asti`,
  )}</text>`,
    f,
  );
}

/** PNG at the card's own size. */
export const ogPng = (svg: string) => svgToPng(svg, 1);
