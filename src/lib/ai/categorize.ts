import { CATEGORIES, type Category } from "../types.ts";
import { generate } from "./ollama.ts";
import { P2P_RE, TRANSFER_RE } from "../finance/transfers.ts";

export interface CategorizeInput {
  id: string; raw: string; amount: number; currency: string; merchantHint?: string | null;
  /** Plaid's personal_finance_category.detailed (e.g. FOOD_AND_DRINK_FAST_FOOD) and its confidence */
  plaid?: string | null; plaidConfidence?: string | null;
}
export interface CategorizeResult { id: string; merchant: string; category: Category; subcategory: string; confidence: number; tags: string[]; source: "llm" | "rules" }

// Small models drift to the first enum value; with "Income" first, a 1.5B model labelled Costco,
// Lyft etc. as Income. Spending categories go first, Income / Transfer last.
const MODEL_CATEGORIES = [...CATEGORIES.filter((c) => c !== "Income" && c !== "Transfer"), "Transfer", "Income"];

const toks = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);
/**
 * Does the model's merchant name plausibly belong to this bank text? Small models in big batches
 * sometimes copy another item's answer ("LYFT *CANC FEE" → "Anthropic"). Passes when any word of the
 * name is contained in the raw text / Plaid hint, or shares its first 3 letters with one of its words.
 */
export function plausibleMerchant(merchant: string, raw: string, hint?: string | null) {
  const m = toks(merchant);
  if (!m.length) return true;
  // common bank abbreviations of brand names
  const expanded = `${raw} ${hint ?? ""}`.replace(/\bamzn\b/gi, "amazon").replace(/\b(wm|wal-mart)\b/gi, "walmart").replace(/\bsq\b/gi, "");
  const src = toks(expanded), joined = src.join("");
  return m.some((w) => joined.includes(w) || src.some((s) => s.slice(0, 3) === w.slice(0, 3)));
}

const P2P_NAME = [/^(.+?)\s*-\s*interac e-?transfer/i, /^interac e-?transfer\s*(?:to|from)?\s*[:-]?\s*(.+)$/i, /zelle (?:payment )?(?:to|from)\s+(.+?)(?:\s+\S*\d\S*)?$/i, /venmo\s*(?:\*|payment)?\s*(?:to|from)?\s*(.+)$/i];
const DIRECT_DEPOSIT = /direct dep|payroll|\bsalary\b/i;
const ACRONYMS = new Set(["ACH", "ATM", "IRS", "SBA", "LLC", "USA", "UI", "NV", "LV", "BBQ", "HOA", "CPD", "S8"]);
const titleCase = (s: string) => /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[\w']+/g, (w) => ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));

/** Mortgage servicers / wording: a mortgage payment is housing spending, not a transfer (no mortgage account is linked). */
export const MORTGAGE_RE = /mortgage|mtg paymt|\bvalon\b|mr\.? cooper|loancare|\bphh\b/i;

/**
 * A readable name from raw bank text, for when the model only echoed it back: the company out of an
 * ACH record ("ORIG CO NAME:Square Inc ORIG ID:…" → "Square Inc"), without ID codes, ATM dates and
 * addresses or reference numbers, and in normal case ("RESTAURANT DEPOT" → "Restaurant Depot").
 */
export function tidyName(raw: string): string {
  const ach = raw.match(/ORIG CO NAME:\s*(.+?)\s+(?:ORIG ID|DESC DATE|CO ENTRY)/i)?.[1];
  const wire = raw.match(/\bFROM:\s*(?:BNF-)?(.+?)\s+REF:/i)?.[1];
  const s = (ach ?? wire ?? raw)
    .replace(/\b(?:PPD|WEB|CCD)?\s*ID:\s*\S+/gi, "")      // "PPD ID: 4760039224"
    .replace(/\s+\d{1,2}\/\d{1,2}\b.*$/, "")             // "ATM CASH DEPOSIT 05/07 2520 S DECATUR…"
    .replace(/\btransaction#:?\s*\d+|#\s*\d+/gi, "")
    .replace(/\s+/g, " ").trim();
  return titleCase(s || raw).slice(0, 80);
}

/** The model's merchant, unless it just echoed the bank text (or kept the ACH wrapper): then tidyName. */
export const finalName = (merchant: string, raw: string) =>
  !merchant.trim() || merchant.trim().toLowerCase() === raw.trim().toLowerCase() || /ORIG CO NAME:/i.test(merchant) ? tidyName(raw) : merchant;

/**
 * Labels decided by bank wording alone, before any model or cache:
 *  - person-to-person payments (Interac e-Transfer, Zelle, Venmo): a payment to someone, or money
 *    received from someone. Never "Transfer" here: rent paid by e-Transfer is real spending. If both
 *    legs are the user's own accounts, markTransfers still pairs them as a transfer.
 *  - money IN described as a direct deposit / payroll: Income (a Costco paycheque is not Groceries).
 */
export function forcedLabel(i: CategorizeInput): CategorizeResult | null {
  const out = i.amount > 0;
  if (P2P_RE.test(i.raw) && !TRANSFER_RE.test(i.raw)) {
    const who = P2P_NAME.map((re) => i.raw.match(re)?.[1]?.trim()).find((s) => s && s.length >= 2);
    return { id: i.id, merchant: titleCase(who ?? i.raw).replace(/[®™]/g, "").slice(0, 80), source: "rules", confidence: 0.9, tags: [],
      category: out ? "Other" : "Income", subcategory: out ? "Payment to person" : "Payment received" };
  }
  if (!out && DIRECT_DEPOSIT.test(i.raw) && !TRANSFER_RE.test(i.raw)) {
    const who = i.raw.replace(/\s*-?\s*(direct dep\w*|payroll|salary).*$/i, "").trim() || i.raw;
    return { id: i.id, merchant: i.merchantHint || titleCase(who).slice(0, 80), source: "rules", confidence: 0.9, tags: [], category: "Income", subcategory: "Direct deposit" };
  }
  if (out && (MORTGAGE_RE.test(i.raw) || /MORTGAGE/i.test(i.plaid ?? "")))
    return { id: i.id, merchant: i.merchantHint || tidyName(i.raw), source: "rules", confidence: 0.9, tags: ["fixed"], category: "Housing", subcategory: "Mortgage" };
  return null;
}

// Plaid category (detailed code, matched by prefix, most specific first) → ours. GENERAL_SERVICES and
// GOVERNMENT_AND_NON_PROFIT are too broad to map: the model decides those.
const PLAID_MAP: [string, Category][] = [
  ["INCOME", "Income"], ["TRANSFER_IN", "Transfer"], ["TRANSFER_OUT", "Transfer"], ["LOAN_PAYMENTS_MORTGAGE_PAYMENT", "Housing"], ["LOAN_PAYMENTS", "Transfer"],
  ["BANK_FEES", "Fees"], ["ENTERTAINMENT", "Entertainment"], ["FOOD_AND_DRINK_GROCERIES", "Groceries"], ["FOOD_AND_DRINK", "Dining"],
  ["GENERAL_MERCHANDISE", "Shopping"], ["HOME_IMPROVEMENT", "Shopping"], ["MEDICAL", "Health"], ["PERSONAL_CARE", "Health"],
  ["TRANSPORTATION", "Transport"], ["TRAVEL", "Travel"], ["RENT_AND_UTILITIES_RENT", "Housing"], ["RENT_AND_UTILITIES", "Utilities"],
];
const PRIMARIES = ["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "BANK_FEES", "ENTERTAINMENT", "FOOD_AND_DRINK", "GENERAL_MERCHANDISE", "HOME_IMPROVEMENT", "MEDICAL", "PERSONAL_CARE", "GENERAL_SERVICES", "GOVERNMENT_AND_NON_PROFIT", "TRANSPORTATION", "TRAVEL", "RENT_AND_UTILITIES"];
const SUBSCRIPTION = /netflix|spotify|apple\.com\/bill|disney|hulu|max\.com|youtube|crave|prime video|patreon|openai|chatgpt|anthropic|claude\.ai|icloud|google \*?(one|storage)|adobe/i;
const HIGH = new Set(["VERY_HIGH", "HIGH"]);

/** Our category for Plaid's code, or null when Plaid has none / it's too broad / it contradicts the direction. */
export function plaidCategory(i: Pick<CategorizeInput, "plaid" | "raw" | "amount">): { category: Category; subcategory: string } | null {
  const code = i.plaid?.toUpperCase();
  if (!code) return null;
  const hit = PLAID_MAP.find(([p]) => code.startsWith(p));
  if (!hit) return null;
  const category: Category = SUBSCRIPTION.test(i.raw) && i.amount > 0 ? "Subscriptions" : hit[1];
  if (impossibleCategory(category, i.amount)) return null;
  const primary = PRIMARIES.find((p) => code.startsWith(p + "_")) ?? "";
  const rest = code.slice(primary ? primary.length + 1 : 0).replace(/_/g, " ").toLowerCase();
  return { category, subcategory: (rest.charAt(0).toUpperCase() + rest.slice(1)).slice(0, 40) };
}

/**
 * Label straight from Plaid, no model: Plaid is confident about the category and already supplied a
 * clean merchant name. Most card purchases qualify, which keeps the local model for the leftovers.
 */
export function plaidLabel(i: CategorizeInput): CategorizeResult | null {
  if (!i.merchantHint || !HIGH.has(String(i.plaidConfidence).toUpperCase())) return null;
  const p = plaidCategory(i);
  return p && { id: i.id, merchant: i.merchantHint.slice(0, 80), ...p, source: "rules", tags: ["plaid-pfc"], confidence: String(i.plaidConfidence).toUpperCase() === "VERY_HIGH" ? 0.95 : 0.85 };
}

/** Plaid overrides the model where the model is known to drift: Plaid confident, or the model said "Transfer" for a purchase Plaid files elsewhere. */
export function reconcile(r: CategorizeResult, i: CategorizeInput): CategorizeResult {
  const p = plaidCategory(i);
  if (!p) return r;
  const plaidSure = HIGH.has(String(i.plaidConfidence).toUpperCase());
  if ((plaidSure && p.category !== r.category) || (r.category === "Transfer" && p.category !== "Transfer"))
    return { ...r, category: p.category, subcategory: p.subcategory };
  return r;
}

/** Money going out can't be income (refunds coming IN can be anything). */
export const impossibleCategory = (category: string, amount: number) => category === "Income" && amount > 0;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          merchant: { type: "string" },
          category: { type: "string", enum: MODEL_CATEGORIES },
          subcategory: { type: "string" },
          confidence: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id", "merchant", "category", "subcategory", "confidence", "tags"],
      },
    },
  },
  required: ["results"],
};

const SYSTEM = `You categorize bank transactions for a personal ledger (primarily US banks and cards).
For each item:
- merchant: the clean, human brand name ("SQ *PILOT COFFEE ROAST 4821" → "Pilot Coffee"). Strip processor prefixes (SQ *, TST*, PAYPAL *), store numbers, cities, phone numbers and reference codes.
- category: exactly one of ${MODEL_CATEGORIES.join(", ")}. "Income" ONLY for money received (dir "in"): payroll, deposits, payouts. A purchase (dir "out") is never Income.
- subcategory: 1–3 words (e.g. "Coffee", "Supermarket", "Rideshare", "Payroll").
- confidence: 0..1, how sure you are of the category.
- tags: 0–3 lowercase tags from: subscription, fixed, travel, work, gift, cash, refund, salary, freelance, foreign.
Amounts: positive = money spent (dir "out"), negative = money received (dir "in"). Credit-card payments and transfers between own accounts are "Transfer"; a purchase at a shop or restaurant never is.
"plaid", when present, is the bank aggregator's category code for the item: a strong hint.
Return JSON only.`;

export interface LLMOptions {
  timeoutMs?: number;
  model?: string;
  /** what to do with items the model left out of its answer: rules fallback (default) or omit (caller retries) */
  missing?: "rules" | "omit";
}

/**
 * Categorize a batch with the local model in one structured-JSON call. Items get short ids ("1", "2", …)
 * in the prompt: far fewer tokens than UUIDs and easier for small models to copy back.
 * Throws on network / timeout / unparsable output (caller decides whether to retry or split).
 */
export async function categorizeWithLLM(items: CategorizeInput[], opts: LLMOptions | number = {}): Promise<CategorizeResult[]> {
  const { timeoutMs = 300_000, model, missing = "rules" } = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const forced = items.flatMap((i) => forcedLabel(i) ?? []);
  if (forced.length) {
    const done = new Set(forced.map((f) => f.id));
    const rest = items.filter((i) => !done.has(i.id));
    return [...forced, ...(rest.length ? await categorizeWithLLM(rest, { timeoutMs, model, missing }) : [])];
  }
  const prompt = JSON.stringify(items.map((i, n) => ({ id: String(n + 1), raw: i.raw, amount: i.amount, dir: i.amount > 0 ? "out" : "in", currency: i.currency, hint: i.merchantHint ?? undefined, plaid: i.plaid ?? undefined })));
  const text = await generate({ system: SYSTEM, prompt, format: SCHEMA, temperature: 0, timeoutMs, model });
  const parsed = JSON.parse(text) as { results?: Partial<CategorizeResult>[] };
  if (!Array.isArray(parsed.results)) throw new Error("model returned no results array");
  const byId = new Map(parsed.results.map((r) => [String(r.id), r]));
  return items.flatMap((i, n): CategorizeResult[] => {
    const r = byId.get(String(n + 1));
    // missing, or an impossible label (Income on money out): rules now, or omit so the caller retries
    if (!r || impossibleCategory(String(r.category), i.amount) || !plausibleMerchant(String(r.merchant ?? ""), i.raw, i.merchantHint)) return missing === "rules" ? [categorizeWithRules(i)] : [];
    const category = (CATEGORIES as readonly string[]).includes(r.category as string) ? (r.category as Category) : "Other";
    return [reconcile({
      id: i.id, category, source: "llm",
      merchant: finalName(r.merchant || i.merchantHint || "", i.raw).slice(0, 80),
      subcategory: (r.subcategory || "").slice(0, 40),
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)),
      tags: (r.tags ?? []).filter((t) => typeof t === "string").slice(0, 3),
    }, i)];
  });
}

const RULES: [RegExp, Category, string, string[]?][] = [
  [/payroll|direct dep|salary/i, "Income", "Payroll", ["salary"]],
  [/stripe transfer/i, "Income", "Deposit"],
  // before the generic income rule: a card's "PAYMENT - THANK YOU" credit is not income
  [TRANSFER_RE, "Transfer", "Transfer"],
  [/received from|zelle from|deposit/i, "Income", "Deposit"],
  [/rent|greystar|prop mgmt|mortgage/i, "Housing", "Rent", ["fixed"]],
  [/con ed|pg&e|duke energy|comcast|xfinity|verizon|t-mobile|at&t/i, "Utilities", "Utilities", ["fixed"]],
  [/trader joe|wholefds|whole foods|costco|safeway|kroger|publix|wegmans|aldi|h-e-b/i, "Groceries", "Supermarket"],
  [/coffee|starbucks|dunkin|cafe/i, "Dining", "Coffee"],
  [/uber\s*\*?\s*eats|doordash|grubhub/i, "Dining", "Delivery"],
  [/restaurant|pizza|thai|sushi|grill|bar /i, "Dining", "Restaurant"],
  [/wine|liquor|total wine/i, "Dining", "Alcohol"],
  [/mta|metrocard|omny|bart|uber|lyft|shell|chevron|exxon/i, "Transport", "Transit"],
  [/netflix|spotify|apple\.com\/bill|disney|hulu|max\.com|youtube/i, "Subscriptions", "Streaming", ["subscription"]],
  [/amzn|amazon|barnes|best buy|walmart|target/i, "Shopping", "Retail"],
  [/pharma|cvs|walgreens|fitness|equinox|gym|dental/i, "Health", "Health"],
  [/amc |regal|ticketmaster|steam/i, "Entertainment", "Entertainment"],
  [/fee|nsf|overdraft|interest charge/i, "Fees", "Bank fee"],
  [/delta air|united air|american air|jetblue|southwest|hotel|airbnb|expedia/i, "Travel", "Travel", ["travel"]],
];

const BRANDS: [RegExp, string][] = [
  [/amzn|amazon/i, "Amazon"], [/trader joe/i, "Trader Joe's"], [/wholefds|whole foods/i, "Whole Foods"], [/mta|metrocard/i, "MTA"],
  [/blue bottle/i, "Blue Bottle Coffee"], [/barnes/i, "Barnes & Noble"], [/joe's pizza/i, "Joe's Pizza"], [/cafe einstein/i, "Café Einstein"],
  [/uber\s*\*?\s*eats/i, "Uber Eats"], [/doordash/i, "DoorDash"], [/uber/i, "Uber"], [/netflix/i, "Netflix"], [/spotify/i, "Spotify"],
  [/apple\.com\/bill/i, "Apple"], [/cvs/i, "CVS Pharmacy"],
];

/** Deterministic fallback used by the demo when no local model is running. */
export function categorizeWithRules(i: CategorizeInput): CategorizeResult {
  const hit = RULES.find(([re]) => re.test(i.raw));
  const merchant = i.merchantHint || BRANDS.find(([re]) => re.test(i.raw))?.[1] || i.raw
    .replace(/^(sq|tst|pp|paypal|amzn mktp \w+)\s*\*\s*/i, "")
    .replace(/[#*]?\s*\d{3,}.*$/, "")
    .replace(/\b(www\.|\.com|\.ca)\b/gi, "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id: i.id, merchant: finalName(merchant || "", i.raw), source: "rules",
    category: hit?.[1] ?? (i.amount < 0 ? "Income" : "Other"), subcategory: hit?.[2] ?? "",
    confidence: hit ? 0.6 : 0.2, tags: hit?.[3] ?? [],
  };
}
