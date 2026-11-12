// Finnish date and time text (24.12.2026, 18.30) for the date fields; the native pickers follow the
// browser's language, not the page's. Dates are passed around as ISO days ("2026-12-24").

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-12-24" → "24.12.2026" ("" stays ""). */
export function showDate(iso: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso);
  return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : "";
}

/** "24.12.2026", "24.12.26", "24.12." (this year) or "24122026" → "2026-12-24"; null if it is no real day. */
export function readDate(text: string, now = new Date()): string | null {
  const t = text.trim();
  const m = /^(\d{1,2})[.\-/ ](\d{1,2})(?:[.\-/ ](\d{2}|\d{4}))?\.?$/.exec(t) ?? /^(\d\d)(\d\d)(\d{4})$/.exec(t);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] === undefined ? now.getFullYear() : Number(m[3]);
  if (m[3]?.length === 2) year += 2000;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "18.30", "18:30", "1830" or "18" → "18:30"; null if it is no time. */
export function readTime(text: string): string | null {
  const m = /^(\d{1,2})(?:[.:]?(\d\d))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

/** "18:30" → "18.30". */
export const showTime = (hhmm: string) => hhmm.replace(":", ".");

/** The local day and time of `ms`, as ISO day and "HH:MM". */
export function dayAndTime(ms: number): { day: string; time: string } {
  const d = new Date(ms);
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
