import { CATEGORIES, type Category } from "../types.ts";
import { generate } from "./ollama.ts";
import { TRANSFER_RE } from "../finance/transfers.ts";

export interface CategorizeInput { id: string; raw: string; amount: number; currency: string; merchantHint?: string | null }
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
Amounts: positive = money spent (dir "out"), negative = money received (dir "in"). Credit-card payments and transfers between own accounts are "Transfer".
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
  const prompt = JSON.stringify(items.map((i, n) => ({ id: String(n + 1), raw: i.raw, amount: i.amount, dir: i.amount > 0 ? "out" : "in", currency: i.currency, hint: i.merchantHint ?? undefined })));
  const text = await generate({ system: SYSTEM, prompt, format: SCHEMA, temperature: 0, timeoutMs, model });
  const parsed = JSON.parse(text) as { results?: Partial<CategorizeResult>[] };
  if (!Array.isArray(parsed.results)) throw new Error("model returned no results array");
  const byId = new Map(parsed.results.map((r) => [String(r.id), r]));
  return items.flatMap((i, n): CategorizeResult[] => {
    const r = byId.get(String(n + 1));
    // missing, or an impossible label (Income on money out): rules now, or omit so the caller retries
    if (!r || impossibleCategory(String(r.category), i.amount) || !plausibleMerchant(String(r.merchant ?? ""), i.raw, i.merchantHint)) return missing === "rules" ? [categorizeWithRules(i)] : [];
    const category = (CATEGORIES as readonly string[]).includes(r.category as string) ? (r.category as Category) : "Other";
    return [{
      id: i.id, category, source: "llm",
      merchant: (r.merchant || i.merchantHint || i.raw).slice(0, 80),
      subcategory: (r.subcategory || "").slice(0, 40),
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)),
      tags: (r.tags ?? []).filter((t) => typeof t === "string").slice(0, 3),
    }];
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
    id: i.id, merchant: merchant || i.raw, source: "rules",
    category: hit?.[1] ?? (i.amount < 0 ? "Income" : "Other"), subcategory: hit?.[2] ?? "",
    confidence: hit ? 0.6 : 0.2, tags: hit?.[3] ?? [],
  };
}
