const cache = new Map<string, Intl.NumberFormat>();
const nf = (min: number, max: number, compact = false) => {
  const k = `${min}-${max}-${compact}`;
  let f = cache.get(k);
  if (!f) cache.set(k, (f = new Intl.NumberFormat("en-CA", { minimumFractionDigits: min, maximumFractionDigits: max, notation: compact ? "compact" : "standard" })));
  return f;
};

/** 1,234.56 — currency code is rendered separately so columns align. */
export function money(n: number, opts: { sign?: boolean; dp?: number; compact?: boolean } = {}) {
  const dp = opts.dp ?? 2;
  const s = nf(opts.compact ? 0 : dp, opts.compact ? 1 : dp, opts.compact).format(Math.abs(n));
  const sign = n < 0 ? "−" : opts.sign && n > 0 ? "+" : "";
  return `${sign}${s}`;
}
export const pct = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;
export const shortDate = (k: string) => new Date(`${k}T00:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
