/**
 * Tool-selection eval set for the copilot, over the deterministic demo ledger at a fixed date.
 *
 * Each case lists what a good tool plan looks like: the tools that must be called (`calls`), tools
 * that are acceptable extras (`optional`), and, where the question pins them down, constraints on
 * the arguments. A case may list several acceptable plans; it passes if any of them matches.
 * `calls: []` means the question needs no ledger data (greeting, out of scope).
 *
 * Constraints are checked on the arguments AFTER `validateArgs` (so "dining" and "Dining" are the
 * same), and `range` accepts either the named period or the equivalent explicit from/to dates.
 */
import type { HistoryMessage } from "../memory.ts";

export const EVAL_NOW = new Date("2026-11-04T15:00:00");
export type Period = "this_month" | "last_month" | "last_7_days" | "last_30_days" | "last_90_days";

export type ArgRule =
  | { equals: string | number }
  /** value must be one of these; `null` in the list means "may be left out" */
  | { oneOf: (string | number | null)[] }
  /** case-insensitive substring of a string argument */
  | { includes: string }
  | { absent: true };

export interface ExpectCall { tool: string; args?: Record<string, ArgRule>; range?: Period }
export interface Plan { calls: ExpectCall[]; optional?: string[] }
export interface EvalCase {
  id: string;
  question: string;
  history?: HistoryMessage[];
  /** one acceptable plan or several */
  expect: Plan | Plan[];
  tags: string[];
}

const SEARCH = "search_transactions";

export const CASES: EvalCase[] = [
  // ── overview ────────────────────────────────────────────────────────────────────────────────────
  { id: "net-worth", question: "What's my net worth right now?", tags: ["overview"], expect: { calls: [{ tool: "get_financial_overview" }] } },
  { id: "balances", question: "How much money do I have in checking and savings?", tags: ["overview"], expect: { calls: [{ tool: "get_financial_overview" }] } },
  { id: "earn-vs-spend", question: "Am I spending more than I earn lately?", tags: ["overview"], expect: [{ calls: [{ tool: "get_financial_overview" }], optional: ["get_spending_by_category"] }, { calls: [{ tool: "get_spending_by_category" }], optional: ["get_financial_overview"] }] },

  // ── spending by category ────────────────────────────────────────────────────────────────────────
  { id: "top-category-last-month", question: "Where did most of my money go last month?", tags: ["spending"], expect: { calls: [{ tool: "get_spending_by_category", range: "last_month" }] } },
  { id: "dining-this-month", question: "How much did I spend on dining this month?", tags: ["spending"], expect: [
    { calls: [{ tool: "get_spending_by_category", range: "this_month" }], optional: ["get_budget_pacing", SEARCH] },
    { calls: [{ tool: SEARCH, args: { category: { equals: "Dining" } }, range: "this_month" }], optional: ["get_spending_by_category", "get_budget_pacing"] },
    { calls: [{ tool: "get_budget_pacing", args: { category: { oneOf: ["Dining", null] } } }], optional: ["get_spending_by_category", SEARCH] },
  ] },
  { id: "compare-months", question: "Compare my spending this month with last month.", tags: ["spending", "multi-tool"], expect: { calls: [{ tool: "get_spending_by_category", range: "this_month" }, { tool: "get_spending_by_category", range: "last_month" }], optional: ["get_financial_overview"] } },

  // ── forecast ────────────────────────────────────────────────────────────────────────────────────
  { id: "run-out", question: "Will I run out of cash before my next paycheque?", tags: ["forecast"], expect: { calls: [{ tool: "get_cash_forecast" }], optional: ["get_recurring_streams"] } },
  { id: "upcoming-bills", question: "What bills are coming up in the next few weeks?", tags: ["forecast"], expect: [{ calls: [{ tool: "get_cash_forecast" }], optional: ["get_recurring_streams"] }, { calls: [{ tool: "get_recurring_streams", args: { direction: { oneOf: ["out", null] } } }], optional: ["get_cash_forecast"] }] },
  { id: "afford-1200", question: "Can I afford a $1,200 purchase next month given my forecast and budget pace?", tags: ["forecast", "budget", "multi-tool"], expect: { calls: [{ tool: "get_cash_forecast" }, { tool: "get_budget_pacing" }], optional: ["get_financial_overview", "get_recurring_streams"] } },
  { id: "afford-trip", question: "Can I afford a $1,200 trip this month?", tags: ["forecast"], expect: { calls: [{ tool: "get_cash_forecast" }], optional: ["get_budget_pacing", "get_financial_overview", "get_recurring_streams"] } },

  // ── budgets ─────────────────────────────────────────────────────────────────────────────────────
  { id: "over-budget", question: "Am I over budget anywhere?", tags: ["budget"], expect: { calls: [{ tool: "get_budget_pacing", args: { category: { absent: true } } }] } },
  { id: "groceries-budget", question: "How is my groceries budget doing?", tags: ["budget"], expect: { calls: [{ tool: "get_budget_pacing", args: { category: { oneOf: ["Groceries", null] } } }], optional: ["get_spending_by_category"] } },
  { id: "pace-and-top", question: "Am I on track with my budgets this month, and what's my biggest spending category?", tags: ["budget", "spending", "multi-tool"], expect: { calls: [{ tool: "get_budget_pacing" }, { tool: "get_spending_by_category", range: "this_month" }] } },

  // ── recurring ───────────────────────────────────────────────────────────────────────────────────
  { id: "subscriptions", question: "What subscriptions do I have?", tags: ["recurring"], expect: { calls: [{ tool: "get_recurring_streams", args: { direction: { oneOf: ["out", null] } } }] } },
  { id: "next-paycheque", question: "When is my next paycheque?", tags: ["recurring"], expect: { calls: [{ tool: "get_recurring_streams", args: { direction: { oneOf: ["in", null] } } }], optional: ["get_cash_forecast"] } },

  // ── anomalies ───────────────────────────────────────────────────────────────────────────────────
  { id: "price-hikes", question: "Did any of my subscriptions go up in price?", tags: ["anomalies"], expect: { calls: [{ tool: "get_anomalies", args: { kind: { oneOf: ["price_hike", null] } } }], optional: ["get_recurring_streams"] } },
  { id: "fees", question: "What bank fees did I pay recently?", tags: ["anomalies"], expect: [
    { calls: [{ tool: "get_anomalies", args: { kind: { oneOf: ["fee", null] } } }], optional: [SEARCH] },
    { calls: [{ tool: SEARCH, args: { category: { equals: "Fees" } } }], optional: ["get_anomalies"] },
  ] },
  { id: "duplicates", question: "Was I double charged for anything?", tags: ["anomalies"], expect: { calls: [{ tool: "get_anomalies", args: { kind: { oneOf: ["duplicate", null] } } }], optional: [SEARCH] } },

  // ── transaction search ──────────────────────────────────────────────────────────────────────────
  { id: "trader-joes-30d", question: "How much have I spent at Trader Joe's in the last 30 days?", tags: ["search"], expect: { calls: [{ tool: SEARCH, args: { merchant: { includes: "trader" } }, range: "last_30_days" }] } },
  { id: "uber-last-month", question: "Show my Uber rides last month.", tags: ["search"], expect: { calls: [{ tool: SEARCH, args: { merchant: { includes: "uber" } }, range: "last_month" }] } },
  { id: "netflix-dates", question: "How much did I pay Netflix between 2026-08-01 and 2026-10-31?", tags: ["search", "dates"], expect: { calls: [{ tool: SEARCH, args: { merchant: { includes: "netflix" }, from: { equals: "2026-08-01" }, to: { equals: "2026-10-31" } } }] } },
  { id: "biggest-purchases", question: "What were my biggest purchases last month?", tags: ["search"], expect: { calls: [{ tool: SEARCH, range: "last_month" }], optional: ["get_spending_by_category"] } },

  // ── follow-ups that need the conversation memory ────────────────────────────────────────────────
  {
    id: "followup-period", question: "And last month?", tags: ["memory"],
    history: [{ role: "user", content: "How much did I spend on dining this month?" }, { role: "assistant", content: "You spent USD 212.40 on Dining so far this month.\n(Figures above came from: get_spending_by_category.)" }],
    expect: [
      { calls: [{ tool: "get_spending_by_category", range: "last_month" }], optional: [SEARCH] },
      { calls: [{ tool: SEARCH, args: { category: { equals: "Dining" } }, range: "last_month" }], optional: ["get_spending_by_category"] },
    ],
  },
  {
    id: "followup-category", question: "What about dining?", tags: ["memory", "budget"],
    history: [{ role: "user", content: "How is my groceries budget doing?" }, { role: "assistant", content: "Groceries is on track: USD 96.10 of USD 600.00 spent.\n(Figures above came from: get_budget_pacing.)" }],
    expect: { calls: [{ tool: "get_budget_pacing", args: { category: { equals: "Dining" } } }] },
  },
  {
    id: "followup-merchant", question: "And at Whole Foods?", tags: ["memory", "search"],
    history: [{ role: "user", content: "How much have I spent at Trader Joe's in the last 30 days?" }, { role: "assistant", content: "USD 402.18 across 6 visits in the last 30 days.\n(Figures above came from: search_transactions.)" }],
    expect: { calls: [{ tool: SEARCH, args: { merchant: { includes: "whole" } } }] },
  },

  // ── no ledger data needed ───────────────────────────────────────────────────────────────────────
  { id: "greeting", question: "Hi! What can you help me with?", tags: ["no-tools"], expect: { calls: [] } },
  { id: "stock-tip", question: "Should I buy Tesla stock?", tags: ["no-tools"], expect: { calls: [], optional: ["get_financial_overview"] } },
];
