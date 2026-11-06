/**
 * Cache key for a raw bank string: the same merchant should map to the same key no matter which
 * store number, order hash, date or reference code the bank appended.
 *
 *   "SQ *BLUE BOTTLE COFFEE 4821"          → "BLUE BOTTLE COFFEE"
 *   "AMZN Mktp US*7Q1M02 AMZN.COM/BILL"    → "AMZN MKTP US AMZN COM BILL"
 *   "TRADER JOE'S #552 BROOKLYN NY"        → "TRADER JOES BROOKLYN NY"
 *   "NORTHWIND LABS PAYROLL PPD ID: 9481"  → "NORTHWIND LABS PAYROLL PPD ID"
 *
 * Rule of thumb: drop processor prefixes, then drop every token that contains a digit (store
 * numbers, hashes, dates, phone numbers, IDs). Returns "" when nothing stable is left, which
 * callers treat as "don't cache".
 */
const PREFIX = /^\s*(sq|tst|sp|pp|paypal|dd|ddbr|pos|purchase|debit card purchase|card payment|checkcard|visa)\s*[*#:-]?\s*/i;

export function merchantKey(raw: string): string {
  let s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // strip up to two stacked prefixes ("POS PURCHASE SQ *...")
  for (let i = 0; i < 2; i++) s = s.replace(PREFIX, "");
  const tokens = s.toUpperCase().replace(/['’]/g, "").split(/[^A-Z0-9]+/).filter((t) => t && !/\d/.test(t));
  const key = tokens.join(" ");
  return key.length >= 3 ? key : "";
}

/** Money in vs out matters: an Amazon refund and an Amazon purchase are categorized differently. */
export const cacheKey = (userId: string, raw: string, amount: number) => {
  const m = merchantKey(raw);
  return m ? `${userId}|${amount < 0 ? "in" : "out"}|${m}` : "";
};
