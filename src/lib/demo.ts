/** Deterministic synthetic ledger used when Supabase isn't configured. */
import type { Account, Budget, Holding, Institution, Transaction } from "./types.ts";
import type { FxRow } from "./finance/fx.ts";
import { addDays, todayKey } from "./finance/dates.ts";

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const demoInstitutions: Institution[] = [
  { id: "ins-td", name: "TD Canada Trust", country: "CA" },
  { id: "ins-amex", name: "American Express CA", country: "CA" },
  { id: "ins-ws", name: "Wealthsimple", country: "CA" },
  { id: "ins-chase", name: "Chase", country: "US" },
];

export const demoAccounts: Account[] = [
  { id: "acc-td-chq", institution_id: "ins-td", name: "TD All-Inclusive Chequing", type: "depository", subtype: "checking", currency: "CAD", current_balance: 6842.17, available_balance: 6842.17, limit_amount: null, is_active: true },
  { id: "acc-td-sav", institution_id: "ins-td", name: "TD ePremium Savings", type: "depository", subtype: "savings", currency: "CAD", current_balance: 18250.0, available_balance: 18250.0, limit_amount: null, is_active: true },
  { id: "acc-chase-chk", institution_id: "ins-chase", name: "Chase Total Checking", type: "depository", subtype: "checking", currency: "USD", current_balance: 3410.55, available_balance: 3410.55, limit_amount: null, is_active: true },
  { id: "acc-amex", institution_id: "ins-amex", name: "Amex Cobalt", type: "credit", subtype: "credit card", currency: "CAD", current_balance: 1873.42, available_balance: 8126.58, limit_amount: 10000, is_active: true },
  { id: "acc-chase-cc", institution_id: "ins-chase", name: "Chase Sapphire Preferred", type: "credit", subtype: "credit card", currency: "USD", current_balance: 412.9, available_balance: 11587.1, limit_amount: 12000, is_active: true },
  { id: "acc-ws-tfsa", institution_id: "ins-ws", name: "Wealthsimple TFSA", type: "investment", subtype: "tfsa", currency: "CAD", current_balance: 48210.33, available_balance: null, limit_amount: null, is_active: true },
  { id: "acc-ws-usd", institution_id: "ins-ws", name: "Wealthsimple USD Margin", type: "investment", subtype: "brokerage", currency: "USD", current_balance: 14987.6, available_balance: null, limit_amount: null, is_active: true },
];

export const demoHoldings: Holding[] = [
  { id: "h1", account_id: "acc-ws-tfsa", security_id: "s-xeqt", ticker: "XEQT", name: "iShares Core Equity ETF Portfolio", quantity: 1104.0, institution_price: 33.21, institution_value: 36663.84, currency: "CAD" },
  { id: "h2", account_id: "acc-ws-tfsa", security_id: "s-zag", ticker: "ZAG", name: "BMO Aggregate Bond Index ETF", quantity: 812.0, institution_price: 13.94, institution_value: 11319.28, currency: "CAD" },
  { id: "h3", account_id: "acc-ws-tfsa", security_id: "s-cash", ticker: "CASH", name: "Cash", quantity: 227.21, institution_price: 1, institution_value: 227.21, currency: "CAD" },
  { id: "h4", account_id: "acc-ws-usd", security_id: "s-vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", quantity: 31.0, institution_price: 302.45, institution_value: 9375.95, currency: "USD" },
  { id: "h5", account_id: "acc-ws-usd", security_id: "s-aapl", ticker: "AAPL", name: "Apple Inc.", quantity: 22.0, institution_price: 255.08, institution_value: 5611.76, currency: "USD" },
];

export const demoBudgets: Budget[] = [
  { id: "b1", category: "Groceries", monthly_limit: 650, currency: "CAD" },
  { id: "b2", category: "Dining", monthly_limit: 350, currency: "CAD" },
  { id: "b3", category: "Transport", monthly_limit: 180, currency: "CAD" },
  { id: "b4", category: "Shopping", monthly_limit: 300, currency: "CAD" },
  { id: "b5", category: "Subscriptions", monthly_limit: 75, currency: "CAD" },
  { id: "b6", category: "Entertainment", monthly_limit: 120, currency: "CAD" },
];

export const demoFx: FxRow[] = [
  { base: "USD", quote: "CAD", rate: 1.3712 },
  { base: "EUR", quote: "CAD", rate: 1.4895 },
  { base: "GBP", quote: "CAD", rate: 1.7421 },
];

type Seed = { acct: string; raw: string; clean: string; cat: string; sub: string; ccy?: string; tags?: string[] };

const DISCRETIONARY: (Seed & { min: number; max: number; p: number })[] = [
  { acct: "acc-amex", raw: "LOBLAWS #1042 TORONTO ON", clean: "Loblaws", cat: "Groceries", sub: "Supermarket", min: 38, max: 142, p: 0.22 },
  { acct: "acc-amex", raw: "FARM BOY 0231 TORONTO", clean: "Farm Boy", cat: "Groceries", sub: "Supermarket", min: 18, max: 64, p: 0.12 },
  { acct: "acc-amex", raw: "SQ *PILOT COFFEE ROAST 4821", clean: "Pilot Coffee", cat: "Dining", sub: "Coffee", min: 4.5, max: 9.8, p: 0.35 },
  { acct: "acc-amex", raw: "UBER* EATS PENDING TORONTO", clean: "Uber Eats", cat: "Dining", sub: "Delivery", min: 24, max: 58, p: 0.1 },
  { acct: "acc-amex", raw: "PAI NORTHERN THAI 00012", clean: "Pai Northern Thai", cat: "Dining", sub: "Restaurant", min: 42, max: 96, p: 0.05 },
  { acct: "acc-td-chq", raw: "PRESTO AUTOLOAD 8812", clean: "PRESTO", cat: "Transport", sub: "Transit", min: 20, max: 40, p: 0.07 },
  { acct: "acc-amex", raw: "UBER *TRIP HELP.UBER.COM", clean: "Uber", cat: "Transport", sub: "Rideshare", min: 12, max: 34, p: 0.06 },
  { acct: "acc-amex", raw: "AMZN Mktp CA*2K4L19 WWW.AMAZON.CA", clean: "Amazon", cat: "Shopping", sub: "Online", min: 14, max: 120, p: 0.08 },
  { acct: "acc-chase-cc", raw: "TST* JOE'S PIZZA NEW YORK NY", clean: "Joe's Pizza", cat: "Dining", sub: "Restaurant", min: 9, max: 28, p: 0.03, ccy: "USD" },
  { acct: "acc-amex", raw: "CINEPLEX #7712 TORONTO", clean: "Cineplex", cat: "Entertainment", sub: "Movies", min: 16, max: 38, p: 0.03 },
  { acct: "acc-amex", raw: "SHOPPERS DRUG MART #0841", clean: "Shoppers Drug Mart", cat: "Health", sub: "Pharmacy", min: 9, max: 46, p: 0.05 },
];

export function demoTransactions(now = new Date(), days = 150): Transaction[] {
  let r = rng(424242);
  const today = todayKey(now);
  const out: Transaction[] = [];
  let n = 0;
  const add = (date: string, amount: number, s: Seed) => {
    out.push({
      id: `t-${++n}`, account_id: s.acct, amount: Math.round(amount * 100) / 100, iso_currency_code: s.ccy ?? "CAD",
      date, raw_merchant_string: s.raw, cleaned_merchant_name: s.clean, category: s.cat, subcategory: s.sub,
      ai_confidence_score: 0.86 + r() * 0.13, ai_tags: s.tags ?? [], is_anomaly: false, is_pending: date === today,
      created_at: `${date}T12:00:00Z`,
    });
  };
  for (let i = days; i >= 0; i--) {
    const d = addDays(today, -i);
    r = rng([...d].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261)); // stable per calendar day
    const dt = new Date(`${d}T00:00:00Z`);
    const dom = dt.getUTCDate();
    // fixed cycles
    if (i % 14 === 3) add(d, -3284.62, { acct: "acc-td-chq", raw: "PAYROLL DEP NORTHWIND LABS INC", clean: "Northwind Labs", cat: "Income", sub: "Payroll", tags: ["salary"] });
    if (dom === 1) add(d, 2150, { acct: "acc-td-chq", raw: "E-TFR RENT 1A2B3C KINGSTON PROP MGMT", clean: "Kingston Property Mgmt", cat: "Housing", sub: "Rent", tags: ["fixed"] });
    if (dom === 6) add(d, 88 + r() * 22, { acct: "acc-td-chq", raw: "TORONTO HYDRO-ELECTRIC PAP", clean: "Toronto Hydro", cat: "Utilities", sub: "Electricity", tags: ["fixed"] });
    if (dom === 9) add(d, 65, { acct: "acc-td-chq", raw: "ROGERS ******4471 PAP", clean: "Rogers", cat: "Utilities", sub: "Mobile", tags: ["fixed"] });
    if (dom === 14) add(d, i < 25 ? 20.99 : 16.49, { acct: "acc-amex", raw: "NETFLIX.COM 866-579-7172 ON", clean: "Netflix", cat: "Subscriptions", sub: "Streaming", tags: ["subscription"] });
    if (dom === 18) add(d, 11.99, { acct: "acc-amex", raw: "Spotify P2A41F8C1B", clean: "Spotify", cat: "Subscriptions", sub: "Music", tags: ["subscription"] });
    if (dom === 22) add(d, 2.99, { acct: "acc-chase-cc", raw: "APPLE.COM/BILL 866-712-7753 CA", clean: "iCloud+", cat: "Subscriptions", sub: "Cloud storage", ccy: "USD", tags: ["subscription"] });
    if (dom === 11) add(d, 29.99, { acct: "acc-td-chq", raw: "GOODLIFE FITNESS CLUBS 0042", clean: "GoodLife Fitness", cat: "Health", sub: "Gym", tags: ["subscription"] });
    if (dom === 27) add(d, -1450, { acct: "acc-chase-chk", raw: "STRIPE TRANSFER ST-J8K2 ACME DESIGN CO", clean: "Acme Design Co", cat: "Income", sub: "Freelance", ccy: "USD", tags: ["freelance"] });
    if (dom === 3) add(d, 1600, { acct: "acc-td-chq", raw: "TFR-TO 6223411 AMEX BILL PYMT", clean: "Amex payment", cat: "Transfer", sub: "Credit card payment" });
    // discretionary
    for (const s of DISCRETIONARY) if (r() < s.p) add(d, s.min + r() * (s.max - s.min), s);
  }
  // seeded leakage for the anomaly scanner
  add(addDays(today, -4), 41.37, { acct: "acc-amex", raw: "UBER* EATS PENDING TORONTO", clean: "Uber Eats", cat: "Dining", sub: "Delivery" });
  add(addDays(today, -4), 41.37, { acct: "acc-amex", raw: "UBER* EATS PENDING TORONTO", clean: "Uber Eats", cat: "Dining", sub: "Delivery" });
  add(addDays(today, -9), 4.5, { acct: "acc-chase-cc", raw: "FOREIGN TRANSACTION FEE", clean: "Chase", cat: "Fees", sub: "FX fee", ccy: "USD" });
  add(addDays(today, -16), 16.95, { acct: "acc-td-chq", raw: "MONTHLY PLAN FEE", clean: "TD Canada Trust", cat: "Fees", sub: "Account fee" });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Raw strings the live simulator streams in, uncategorized, to exercise the AI queue. */
export const LIVE_SAMPLES: { acct: string; raw: string; min: number; max: number; ccy?: string }[] = [
  { acct: "acc-amex", raw: "SQ *PILOT COFFEE ROAST 4821", min: 4.75, max: 8.5 },
  { acct: "acc-amex", raw: "LOBLAWS #1042 TORONTO ON", min: 22, max: 96 },
  { acct: "acc-amex", raw: "UBER *TRIP HELP.UBER.COM", min: 11, max: 27 },
  { acct: "acc-amex", raw: "INDIGO BOOKS #0218 TORONTO", min: 18, max: 54 },
  { acct: "acc-chase-cc", raw: "BLUE BOTTLE COFFEE SF CA", min: 5, max: 11, ccy: "USD" },
  { acct: "acc-amex", raw: "LCBO/RAO #0217 TORONTO", min: 19, max: 64 },
  { acct: "acc-td-chq", raw: "PRESTO AUTOLOAD 8812", min: 20, max: 40 },
  { acct: "acc-amex", raw: "AMZN Mktp CA*7Q1M02 WWW.AMAZON.CA", min: 12, max: 89 },
];
