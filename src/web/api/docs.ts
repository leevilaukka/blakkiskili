// The help, terms and privacy texts for the public pages. The texts are the bot's (Telegram
// HTML), so the two can't drift apart; they are turned into plain blocks here and the pages
// draw them themselves, so no HTML ever reaches the browser.

import type { DocBlock, DocPage, Inline } from "../../../shared/api.ts";
import { fail, json } from "../http.ts";
import type { Api, Routes } from "./context.ts";

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;

/** Plain text with bare URLs turned into links. */
function linkify(text: string, base: Omit<Inline, "text">): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > at) out.push({ ...base, text: text.slice(at, m.index) });
    out.push({ ...base, text: m[0], href: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ ...base, text: text.slice(at) });
  return out;
}

/** <b>, <code> and <a href> (http(s) only) to inline pieces; other tags are dropped. */
export function inlines(html: string): Inline[] {
  const out: Inline[] = [];
  let bold = false;
  let code = false;
  let href: string | undefined;
  let at = 0;
  const push = (raw: string) => {
    const text = unescape(raw);
    if (!text) return;
    if (href) out.push({ text, ...(bold ? { bold } : {}), ...(code ? { code } : {}), href });
    else out.push(...linkify(text, { ...(bold ? { bold } : {}), ...(code ? { code } : {}) }));
  };
  for (const m of html.matchAll(/<(\/?)(b|code|a)(?:\s+href="([^"]*)")?\s*>/g)) {
    push(html.slice(at, m.index));
    at = m.index + m[0].length;
    const closing = m[1] === "/";
    if (m[2] === "b") bold = !closing;
    else if (m[2] === "code") code = !closing;
    else href = closing ? undefined : /^https?:\/\//.test(unescape(m[3] ?? "")) ? unescape(m[3]!) : undefined;
  }
  push(html.slice(at));
  return out;
}

/** Telegram HTML (<b>, <h2> section lines, "- " list lines, blank lines between paragraphs) → blocks. */
export function docBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const line of html.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const section = /^<h2>([^<]*)<\/h2>$/.exec(text);
    const heading = /^<b>([^<]*)<\/b>$/.exec(text);
    if (section) blocks.push({ type: "section", inline: [{ text: unescape(section[1]!) }] });
    else if (heading) blocks.push({ type: "heading", inline: [{ text: unescape(heading[1]!) }] });
    else if (text.startsWith("- ")) blocks.push({ type: "item", inline: inlines(text.slice(2)) });
    else blocks.push({ type: "paragraph", inline: inlines(text) });
  }
  return blocks;
}

export function docsRoutes({ opts }: Api): Routes {
  const pages = Object.fromEntries(Object.entries(opts.docs ?? {}).map(([name, html]) => [name, docBlocks(html)]));
  return {
    // Public: people should be able to read these before they sign in.
    "/api/docs/:page": {
      GET: (c) => {
        const page = c.param("page", /^[a-z]{1,16}$/) as DocPage | null;
        const blocks = page && Object.hasOwn(pages, page) ? pages[page] : undefined;
        return blocks ? json({ blocks }) : fail(404, "not_found");
      },
    },
  };
}
