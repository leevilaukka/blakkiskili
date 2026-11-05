// Text formatting helpers. All bot messages use Telegram HTML parse mode.

import { roundTo } from "./units.ts";

export const TIME_ZONE = process.env.TZ || "Europe/Helsinki";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Fills {placeholders}. Values are HTML-escaped unless wrapped with raw(), so user
 * supplied text (names, drink descriptions) can never inject markup.
 */
export function fmt(template: string, values: Record<string, string | number | Raw>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = values[key];
    if (v === undefined) return match;
    if (v instanceof Raw) return v.html;
    return escapeHtml(String(v));
  });
}

export class Raw {
  constructor(readonly html: string) {}
}
export const raw = (html: string) => new Raw(html);

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(ms: number) {
  const out: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(new Date(ms))) out[part.type] = part.value;
  // Finnish style: 6.11. rather than 06.11.
  out.day = String(Number(out.day));
  out.month = String(Number(out.month));
  return out;
}

/** "21:05" */
export function hhmm(ms: number): string {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

/** "5.11." */
export function shortDate(ms: number): string {
  const p = parts(ms);
  return `${p.day}.${p.month}.`;
}

/** "5.11.2026" */
export function longDate(ms: number): string {
  const p = parts(ms);
  return `${p.day}.${p.month}.${p.year}`;
}

/** "5.11.2026 21:05" */
export function dateTime(ms: number): string {
  const p = parts(ms);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

/** Two decimals the way the original printed permilles: 0.5, 1.23, 0 */
export function num(n: number, decimals = 2): string {
  return String(roundTo(n, decimals));
}

/** Splits fractional hours into "Xh YYmin" parts like the original. */
export function hoursMinutes(hoursFloat: number): { hours: number; minutes: string } {
  const hours = Math.floor(hoursFloat);
  const minutes = ("0" + Math.ceil((hoursFloat - hours) * 60)).slice(-2);
  return { hours, minutes };
}

export interface ListedDrink {
  description: string;
  createdAt: number;
}

/** "21:05 🍺 33cl 4.7%" lines, optionally with day headers. Returns escaped HTML. */
export function drinkList(drinks: readonly ListedDrink[], withDays = false): string {
  const lines: string[] = [];
  let day: string | null = null;
  for (const d of drinks) {
    if (withDays) {
      const date = shortDate(d.createdAt);
      if (date !== day) {
        day = date;
        lines.push(`<b>${date}</b>`);
      }
    }
    lines.push(`${hhmm(d.createdAt)} ${escapeHtml(d.description)}`);
  }
  return lines.join("\n");
}
