export const DAY = 86_400_000;
export const toKey = (d: Date) => d.toISOString().slice(0, 10);
export const parseKey = (k: string) => new Date(`${k}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((parseKey(b).getTime() - parseKey(a).getTime()) / DAY);
export const addDays = (k: string, n: number) => toKey(new Date(parseKey(k).getTime() + n * DAY));
export const todayKey = (now = new Date()) =>
  toKey(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
export const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Add whole months, clamping the day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(k: string, n: number, anchorDay?: number): string {
  const d = parseKey(k);
  const day = anchorDay ?? d.getUTCDate();
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toKey(new Date(Date.UTC(y, m, Math.min(day, dim))));
}

/** Step a recurring cadence: weekly-ish cadences by days, monthly+ by calendar months. */
export function stepCadence(k: string, cadenceDays: number, anchorDay?: number): string {
  if (cadenceDays === 30) return addMonths(k, 1, anchorDay);
  if (cadenceDays === 91) return addMonths(k, 3, anchorDay);
  if (cadenceDays === 365) return addMonths(k, 12, anchorDay);
  return addDays(k, cadenceDays);
}
