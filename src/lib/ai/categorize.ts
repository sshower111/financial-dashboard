import { CATEGORIES, type Category } from "../types.ts";
import { generate } from "./ollama.ts";
import { TRANSFER_RE } from "../finance/transfers.ts";

export interface CategorizeInput { id: string; raw: string; amount: number; currency: string; merchantHint?: string | null }
export interface CategorizeResult { id: string; merchant: string; category: Category; subcategory: string; confidence: number; tags: string[]; source: "llm" | "rules" }

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
          category: { type: "string", enum: [...CATEGORIES] },
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
- category: exactly one of ${CATEGORIES.join(", ")}.
- subcategory: 1–3 words (e.g. "Coffee", "Supermarket", "Rideshare", "Payroll").
- confidence: 0..1, how sure you are of the category.
- tags: 0–3 lowercase tags from: subscription, fixed, travel, work, gift, cash, refund, salary, freelance, foreign.
Amounts: positive = money spent, negative = money received. Credit-card payments and transfers between own accounts are "Transfer".
Return JSON only.`;

/** Categorize a batch with the local model. Throws if Ollama is unreachable (caller decides whether to retry). */
export async function categorizeWithLLM(items: CategorizeInput[], timeoutMs = 300_000): Promise<CategorizeResult[]> {
  const prompt = JSON.stringify(items.map((i) => ({ id: i.id, raw: i.raw, amount: i.amount, currency: i.currency, hint: i.merchantHint ?? undefined })));
  const text = await generate({ system: SYSTEM, prompt, format: SCHEMA, temperature: 0, timeoutMs });
  const parsed = JSON.parse(text) as { results: Partial<CategorizeResult>[] };
  const byId = new Map(parsed.results.map((r) => [r.id, r]));
  return items.map((i) => {
    const r = byId.get(i.id);
    if (!r) return categorizeWithRules(i);
    const category = (CATEGORIES as readonly string[]).includes(r.category as string) ? (r.category as Category) : "Other";
    return {
      id: i.id, category, source: "llm",
      merchant: (r.merchant || i.merchantHint || i.raw).slice(0, 80),
      subcategory: (r.subcategory || "").slice(0, 40),
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)),
      tags: (r.tags ?? []).filter((t) => typeof t === "string").slice(0, 3),
    };
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
