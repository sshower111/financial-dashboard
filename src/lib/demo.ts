/** Deterministic synthetic ledger used when Supabase isn't configured. */
import type { Account, Budget, Holding, Institution, Transaction } from "./types.ts";
import type { FxRow } from "./finance/fx.ts";
import { addDays, todayKey } from "./finance/dates.ts";

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const demoInstitutions: Institution[] = [
  { id: "ins-chase", name: "Chase", country: "US" },
  { id: "ins-amex", name: "American Express", country: "US" },
  { id: "ins-fidelity", name: "Fidelity", country: "US" },
  { id: "ins-schwab", name: "Charles Schwab", country: "US" },
  { id: "ins-wise", name: "Wise", country: "US" },
];

export const demoAccounts: Account[] = [
  { id: "acc-chase-chk", institution_id: "ins-chase", name: "Chase Total Checking", type: "depository", subtype: "checking", currency: "USD", current_balance: 7842.17, available_balance: 7842.17, limit_amount: null, is_active: true, owner_label: "personal" },
  { id: "acc-chase-sav", institution_id: "ins-chase", name: "Chase Savings", type: "depository", subtype: "savings", currency: "USD", current_balance: 21250.0, available_balance: 21250.0, limit_amount: null, is_active: true, owner_label: "personal" },
  { id: "acc-wise-eur", institution_id: "ins-wise", name: "Wise EUR Balance", type: "depository", subtype: "checking", currency: "EUR", current_balance: 2380.55, available_balance: 2380.55, limit_amount: null, is_active: true, owner_label: "personal" },
  { id: "acc-amex", institution_id: "ins-amex", name: "Amex Gold Card", type: "credit", subtype: "credit card", currency: "USD", current_balance: 1873.42, available_balance: null, limit_amount: 10000, is_active: true, owner_label: "business" },
  { id: "acc-chase-cc", institution_id: "ins-chase", name: "Chase Sapphire Preferred", type: "credit", subtype: "credit card", currency: "USD", current_balance: 412.9, available_balance: 11587.1, limit_amount: 12000, is_active: true, owner_label: "personal" },
  { id: "acc-fid-roth", institution_id: "ins-fidelity", name: "Fidelity Roth IRA", type: "investment", subtype: "roth", currency: "USD", current_balance: 38210.33, available_balance: null, limit_amount: null, is_active: true, owner_label: "personal" },
  { id: "acc-schwab", institution_id: "ins-schwab", name: "Schwab Brokerage", type: "investment", subtype: "brokerage", currency: "USD", current_balance: 14987.6, available_balance: null, limit_amount: null, is_active: true, owner_label: "business" },
];

export const demoHoldings: Holding[] = [
  { id: "h1", account_id: "acc-fid-roth", security_id: "s-vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", quantity: 88.0, institution_price: 302.45, institution_value: 26615.6, currency: "USD" },
  { id: "h2", account_id: "acc-fid-roth", security_id: "s-vxus", ticker: "VXUS", name: "Vanguard Total International Stock ETF", quantity: 104.0, institution_price: 68.12, institution_value: 7084.48, currency: "USD" },
  { id: "h3", account_id: "acc-fid-roth", security_id: "s-bnd", ticker: "BND", name: "Vanguard Total Bond Market ETF", quantity: 61.0, institution_price: 73.96, institution_value: 4511.56, currency: "USD" },
  { id: "h4", account_id: "acc-schwab", security_id: "s-aapl", ticker: "AAPL", name: "Apple Inc.", quantity: 22.0, institution_price: 255.08, institution_value: 5611.76, currency: "USD" },
  { id: "h5", account_id: "acc-schwab", security_id: "s-msft", ticker: "MSFT", name: "Microsoft Corp.", quantity: 14.0, institution_price: 512.4, institution_value: 7173.6, currency: "USD" },
  { id: "h6", account_id: "acc-schwab", security_id: "s-cash", ticker: "CASH", name: "Cash", quantity: 2202.24, institution_price: 1, institution_value: 2202.24, currency: "USD" },
];

export const demoBudgets: Budget[] = [
  { id: "b1", category: "Groceries", monthly_limit: 600, currency: "USD" },
  { id: "b2", category: "Dining", monthly_limit: 400, currency: "USD" },
  { id: "b3", category: "Transport", monthly_limit: 180, currency: "USD" },
  { id: "b4", category: "Shopping", monthly_limit: 300, currency: "USD" },
  { id: "b5", category: "Subscriptions", monthly_limit: 75, currency: "USD" },
  { id: "b6", category: "Entertainment", monthly_limit: 120, currency: "USD" },
];

/** rate = units of `quote` per 1 `base` (same shape the worker stores from Frankfurter/ECB). */
export const demoFx: FxRow[] = [
  { base: "USD", quote: "EUR", rate: 0.8876 },
  { base: "USD", quote: "GBP", rate: 0.7408 },
  { base: "USD", quote: "CAD", rate: 1.3935 },
];

type Seed = { acct: string; raw: string; clean: string; cat: string; sub: string; ccy?: string; tags?: string[] };

const DISCRETIONARY: (Seed & { min: number; max: number; p: number })[] = [
  { acct: "acc-amex", raw: "TRADER JOE'S #552 BROOKLYN NY", clean: "Trader Joe's", cat: "Groceries", sub: "Supermarket", min: 32, max: 118, p: 0.22 },
  { acct: "acc-amex", raw: "WHOLEFDS BKN 10234", clean: "Whole Foods", cat: "Groceries", sub: "Supermarket", min: 18, max: 72, p: 0.12 },
  { acct: "acc-amex", raw: "SQ *BLUE BOTTLE COFFEE 4821", clean: "Blue Bottle Coffee", cat: "Dining", sub: "Coffee", min: 4.5, max: 9.8, p: 0.35 },
  { acct: "acc-amex", raw: "DOORDASH*SWEETGREEN SAN FRANCISCO", clean: "DoorDash", cat: "Dining", sub: "Delivery", min: 22, max: 54, p: 0.1 },
  { acct: "acc-amex", raw: "TST* LUCALI 00012 BROOKLYN", clean: "Lucali", cat: "Dining", sub: "Restaurant", min: 42, max: 96, p: 0.05 },
  { acct: "acc-chase-chk", raw: "MTA*METROCARD MACHINE 0412", clean: "MTA", cat: "Transport", sub: "Transit", min: 20, max: 40, p: 0.07 },
  { acct: "acc-amex", raw: "UBER *TRIP HELP.UBER.COM", clean: "Uber", cat: "Transport", sub: "Rideshare", min: 12, max: 34, p: 0.06 },
  { acct: "acc-amex", raw: "AMZN Mktp US*2K4L19 AMZN.COM/BILL", clean: "Amazon", cat: "Shopping", sub: "Online", min: 14, max: 120, p: 0.08 },
  { acct: "acc-wise-eur", raw: "CARD PAYMENT CAFE EINSTEIN BERLIN", clean: "Café Einstein", cat: "Dining", sub: "Coffee", min: 4, max: 14, p: 0.02, ccy: "EUR" },
  { acct: "acc-amex", raw: "AMC 34TH ST 14 #0612", clean: "AMC Theatres", cat: "Entertainment", sub: "Movies", min: 16, max: 38, p: 0.03 },
  { acct: "acc-amex", raw: "CVS/PHARMACY #08412", clean: "CVS Pharmacy", cat: "Health", sub: "Pharmacy", min: 9, max: 46, p: 0.05 },
];

export function demoTransactions(now = new Date(), days = 150): Transaction[] {
  let r = rng(424242);
  const today = todayKey(now);
  const out: Transaction[] = [];
  let n = 0;
  const add = (date: string, amount: number, s: Seed) => {
    out.push({
      id: `t-${++n}`, account_id: s.acct, amount: Math.round(amount * 100) / 100, iso_currency_code: s.ccy ?? "USD",
      date, raw_merchant_string: s.raw, cleaned_merchant_name: s.clean, category: s.cat, subcategory: s.sub,
      ai_confidence_score: 0.86 + r() * 0.13, ai_tags: s.tags ?? [], is_anomaly: false, is_pending: date === today,
      created_at: `${date}T12:00:00Z`,
    });
  };
  for (let i = days; i >= 0; i--) {
    const d = addDays(today, -i);
    r = rng([...d].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261)); // stable per calendar day
    const dom = new Date(`${d}T00:00:00Z`).getUTCDate();
    // fixed cycles
    if (i % 14 === 3) add(d, -3684.62, { acct: "acc-chase-chk", raw: "NORTHWIND LABS PAYROLL PPD ID: 9481", clean: "Northwind Labs", cat: "Income", sub: "Payroll", tags: ["salary"] });
    if (dom === 1) add(d, 2450, { acct: "acc-chase-chk", raw: "GREYSTAR RENT WEB PMTS PPD", clean: "Greystar", cat: "Housing", sub: "Rent", tags: ["fixed"] });
    if (dom === 6) add(d, 88 + r() * 22, { acct: "acc-chase-chk", raw: "CON ED OF NY INTELL CK PPD", clean: "Con Edison", cat: "Utilities", sub: "Electricity", tags: ["fixed"] });
    if (dom === 9) add(d, 65, { acct: "acc-chase-chk", raw: "VERIZON WIRELESS PAYMENTS", clean: "Verizon", cat: "Utilities", sub: "Mobile", tags: ["fixed"] });
    if (dom === 14) add(d, i < 25 ? 17.99 : 15.49, { acct: "acc-amex", raw: "NETFLIX.COM LOS GATOS CA", clean: "Netflix", cat: "Subscriptions", sub: "Streaming", tags: ["subscription"] });
    if (dom === 18) add(d, 11.99, { acct: "acc-amex", raw: "Spotify USA P2A41F8C1B", clean: "Spotify", cat: "Subscriptions", sub: "Music", tags: ["subscription"] });
    if (dom === 22) add(d, 2.99, { acct: "acc-chase-cc", raw: "APPLE.COM/BILL 866-712-7753 CA", clean: "iCloud+", cat: "Subscriptions", sub: "Cloud storage", tags: ["subscription"] });
    if (dom === 11) add(d, 34.99, { acct: "acc-chase-chk", raw: "EQUINOX FITNESS 0042", clean: "Equinox", cat: "Health", sub: "Gym", tags: ["subscription"] });
    if (dom === 27) add(d, -1350, { acct: "acc-wise-eur", raw: "RECEIVED FROM STUDIO NORD GMBH", clean: "Studio Nord GmbH", cat: "Income", sub: "Freelance", ccy: "EUR", tags: ["freelance"] });
    if (dom === 3) add(d, 1600, { acct: "acc-chase-chk", raw: "AMERICAN EXPRESS ACH PMT", clean: "Amex payment", cat: "Transfer", sub: "Credit card payment" });
    if (dom === 4) add(d, -1600, { acct: "acc-amex", raw: "PAYMENT RECEIVED - THANK YOU", clean: "Amex payment", cat: "Transfer", sub: "Credit card payment" });
    // discretionary
    for (const s of DISCRETIONARY) if (r() < s.p) add(d, s.min + r() * (s.max - s.min), s);
  }
  // seeded leakage for the anomaly scanner
  const dd = (s: Seed) => add(addDays(today, -4), 41.37, s);
  const doordash: Seed = { acct: "acc-amex", raw: "DOORDASH*SWEETGREEN SAN FRANCISCO", clean: "DoorDash", cat: "Dining", sub: "Delivery" };
  dd(doordash); dd(doordash);
  add(addDays(today, -9), 4.5, { acct: "acc-chase-cc", raw: "FOREIGN TRANSACTION FEE", clean: "Chase", cat: "Fees", sub: "FX fee" });
  add(addDays(today, -16), 12.0, { acct: "acc-chase-chk", raw: "MONTHLY SERVICE FEE", clean: "Chase", cat: "Fees", sub: "Account fee" });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Raw strings the live simulator streams in, uncategorized, to exercise the AI queue. */
export const LIVE_SAMPLES: { acct: string; raw: string; min: number; max: number; ccy?: string }[] = [
  { acct: "acc-amex", raw: "SQ *BLUE BOTTLE COFFEE 4821", min: 4.75, max: 8.5 },
  { acct: "acc-amex", raw: "TRADER JOE'S #552 BROOKLYN NY", min: 22, max: 96 },
  { acct: "acc-amex", raw: "UBER *TRIP HELP.UBER.COM", min: 11, max: 27 },
  { acct: "acc-amex", raw: "BARNES & NOBLE #2218 NEW YORK", min: 18, max: 54 },
  { acct: "acc-wise-eur", raw: "CARD PAYMENT CAFE EINSTEIN BERLIN", min: 4, max: 11, ccy: "EUR" },
  { acct: "acc-amex", raw: "TST* JOE'S PIZZA NEW YORK NY", min: 9, max: 28 },
  { acct: "acc-chase-chk", raw: "MTA*METROCARD MACHINE 0412", min: 20, max: 40 },
  { acct: "acc-amex", raw: "AMZN Mktp US*7Q1M02 AMZN.COM/BILL", min: 12, max: 89 },
];
