const fi = (digits: number) => new Intl.NumberFormat("fi-FI", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const f1 = fi(1);
const f2 = fi(2);

/** 0.4213 → "0,42" */
export const permille = (v: number) => f2.format(v);
/** 1.5 → "1,5" */
export const decimal1 = (v: number) => f1.format(v);

export const clock = (ms: number) => new Date(ms).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });

/** "tänään 21:30", "huomenna 02:10" or "ma 21:30". */
export function dayClock(ms: number, now: number): string {
  const a = new Date(ms);
  const b = new Date(now);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(a) - midnight(b)) / 86_400_000);
  const day =
    days === 0 ? "tänään" : days === 1 ? "huomenna" : days === -1 ? "eilen" : a.toLocaleDateString("fi-FI", { weekday: "short" });
  return `${day} ${clock(ms)}`;
}
