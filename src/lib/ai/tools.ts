/**
 * Read-only tools the copilot model can call (Ollama `/api/chat` `tools`, OpenAI-style function schemas).
 *
 * Every tool is a thin wrapper over the tested finance engine in `src/lib/finance/*`: the model picks
 * a tool and arguments, the server computes, the model explains. There is no finance math here beyond
 * rounding and summing already-converted amounts.
 *
 * Tools receive one thing: the in-memory `Ledger` the route already loaded for the signed-in user
 * (RLS-scoped, narrowed to the open dashboard). They have no database client, no network and no
 * write path, so a tool call cannot reach anything the user could not already see.
 */
import { CATEGORIES, type Transaction } from "../types.ts";
import type { Ledger } from "./context.ts";
import { computeNetWorth } from "../finance/networth.ts";
import { cashFlow, cashFlowDelta, spendByCategory } from "../finance/cashflow.ts";
import { forecastCash } from "../finance/forecast.ts";
import { detectRecurring } from "../finance/recurring.ts";
import { detectAnomalies, type AnomalyKind } from "../finance/anomaly.ts";
import { budgetPacing } from "../finance/pacing.ts";
import { convert } from "../finance/fx.ts";
import { isTransfer } from "../finance/transfers.ts";
import { addDays, addMonths, todayKey } from "../finance/dates.ts";
import { accountLabel } from "../format.ts";

export interface ToolContext { ledger: Ledger; now: Date }

// ── argument schemas ─────────────────────────────────────────────────────────────────────────────

type Prop =
  | { type: "string"; description: string; enum?: readonly string[]; format?: "date"; maxLength?: number }
  | { type: "integer" | "number"; description: string; minimum?: number; maximum?: number };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Prop>;
  required?: string[];
  /** cross-field checks after per-field validation; returns an error message or null */
  check?: (a: Args) => string | null;
  run: (a: Args, ctx: ToolContext) => unknown;
}
type Args = Record<string, string | number | undefined>;

export type ToolErrorCode = "unknown_tool" | "invalid_arguments" | "tool_failed" | "too_many_calls";
export type ToolResult =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: { code: ToolErrorCode; message: string; validTools?: string[] } };

const PERIODS = ["this_month", "last_month", "last_7_days", "last_30_days", "last_90_days"] as const;
const ANOMALY_KINDS = ["duplicate", "price_hike", "fee", "unusual_amount"] as const satisfies readonly AnomalyKind[];
const MAX_ROWS = 50;

const r2 = (n: number) => Math.round(n * 100) / 100;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Server-side date ranges, so the model never does calendar arithmetic. */
export function resolvePeriod(period: string, now: Date): { from: string; to: string } {
  const today = todayKey(now), first = `${today.slice(0, 7)}-01`;
  switch (period) {
    case "this_month": return { from: first, to: today };
    case "last_month": return { from: addMonths(first, -1), to: addDays(first, -1) };
    case "last_7_days": return { from: addDays(today, -6), to: today };
    case "last_90_days": return { from: addDays(today, -89), to: today };
    default: return { from: addDays(today, -29), to: today };
  }
}

const DATE_RANGE: Record<string, Prop> = {
  period: { type: "string", enum: PERIODS, description: "Named date range, resolved on the server. Use this unless the user gave exact dates." },
  from: { type: "string", format: "date", description: "Start date YYYY-MM-DD (inclusive). Use together with `to` instead of `period`." },
  to: { type: "string", format: "date", description: "End date YYYY-MM-DD (inclusive)." },
};
const rangeCheck = (a: Args) => {
  if ((a.from === undefined) !== (a.to === undefined)) return "`from` and `to` must be given together (or use `period`).";
  if (a.from !== undefined && a.period !== undefined) return "Give either `period` or `from`+`to`, not both.";
  if (a.from !== undefined && a.to !== undefined && a.from > a.to) return "`from` must not be after `to`.";
  return null;
};
const range = (a: Args, now: Date, fallback: string | null) =>
  a.from !== undefined ? { from: String(a.from), to: String(a.to) } : a.period !== undefined || fallback ? resolvePeriod(String(a.period ?? fallback), now) : null;

// ── the tools ────────────────────────────────────────────────────────────────────────────────────

const DEFS: ToolDef[] = [
  {
    name: "get_financial_overview",
    description: "Net worth (assets, liabilities, by account type), every account with its balance, investment holdings, and cash flow for the trailing 30 days versus the 30 days before. Use for net worth, balances, 'how am I doing', income vs spending.",
    properties: {},
    run: (_a, { ledger: l, now }) => {
      const nw = computeNetWorth(l.accounts, l.fx);
      const cf = cashFlowDelta(l.transactions, l.fx, now);
      const flow = (c: { inflow: number; outflow: number; net: number }) => ({ income: r2(c.inflow), spending: r2(c.outflow), net: r2(c.net) });
      return {
        baseCurrency: l.base,
        netWorth: { total: r2(nw.total), assets: r2(nw.assets), liabilities: r2(nw.liabilities), byType: Object.fromEntries(Object.entries(nw.byType).map(([k, v]) => [k, r2(v)])), currenciesWithoutFxRate: nw.missingFx },
        accounts: l.accounts.map((a) => ({ name: accountLabel(a), type: a.type, currency: a.currency, balance: a.current_balance })),
        holdings: l.holdings.slice(0, 40).map((h) => ({ ticker: h.ticker, quantity: h.quantity, value: h.institution_value, currency: h.currency })),
        cashFlow: { last30Days: flow(cf.current), previous30Days: flow(cf.previous), netChange: r2(cf.change), note: "Base currency. Transfers between the user's own accounts are excluded." },
      };
    },
  },
  {
    name: "get_spending_by_category",
    description: "Total spending per category for a date range, largest first, plus total income and spending for the range. Use for 'where does my money go', 'how much on dining last month', comparing two periods (call once per period).",
    properties: { ...DATE_RANGE, limit: { type: "integer", minimum: 1, maximum: 20, description: "Max categories to return (default 10)." } },
    check: rangeCheck,
    run: (a, { ledger: l, now }) => {
      const { from, to } = range(a, now, "last_30_days")!;
      const cf = cashFlow(l.transactions, l.fx, from, to);
      const cats = spendByCategory(l.transactions, l.fx, from, to);
      return {
        from, to, baseCurrency: l.base, totalSpending: r2(cf.outflow), totalIncome: r2(cf.inflow), net: r2(cf.net),
        categories: cats.slice(0, Number(a.limit ?? 10)).map((c) => ({ category: c.category, amount: r2(c.amount) })),
        categoryCount: cats.length,
      };
    },
  },
  {
    name: "get_cash_forecast",
    description: "30-day cash projection ('wallet weather'): liquid cash today, projected end balance, lowest point and its date, any shortfall date, daily discretionary burn, and the dated income, bills and card payments it expects. Use for 'can I afford X', 'will I run out', upcoming bills.",
    properties: {},
    run: (_a, { ledger: l, now }) => {
      const f = forecastCash(l.accounts, l.transactions, l.fx, { now });
      return {
        baseCurrency: l.base, horizonDays: 30, weather: f.weather,
        liquidCashToday: r2(f.start), projectedEnd: r2(f.end), lowestBalance: r2(f.min), lowestBalanceDate: f.minDate, shortfallDate: f.shortfallDate,
        dailyDiscretionaryBurn: r2(f.dailyBurn), daysOfBurnCoveredAtLowPoint: Number.isFinite(f.bufferDays) ? r2(f.bufferDays) : null,
        upcoming: f.events.slice(0, 20).map((e) => ({ date: e.date, label: e.label, amount: r2(e.amount), kind: e.kind })),
        note: "upcoming amounts: positive = money in, negative = money out. Card balances are assumed due in 21 days. weather: storm = goes below 0, overcast = low point covers under 14 days of burn.",
      };
    },
  },
  {
    name: "get_budget_pacing",
    description: "This month's budgets: spent so far, limit, velocity (1.00 = exactly on pace for the day of the month), projected month-end spend and status (under / on-track / over). Use for 'am I over budget', 'how is my dining budget'.",
    properties: { category: { type: "string", enum: CATEGORIES, description: "Only this budget category. Omit for all budgets." } },
    run: (a, { ledger: l, now }) => {
      const p = budgetPacing(l.budgets, l.transactions, l.fx, now);
      const row = (r: (typeof p.rows)[number]) => ({ category: r.category, spent: r2(r.spent), limit: r2(r.limit), usedShare: r2(r.used), velocity: r2(r.velocity), projectedMonthEnd: r2(r.projected), status: r.status });
      const rows = p.rows.filter((r) => a.category === undefined || r.category === a.category);
      return {
        baseCurrency: l.base, dayOfMonth: p.day, daysInMonth: p.daysInMonth, monthElapsedShare: r2(p.monthProgress),
        budgets: rows.map(row), ...(a.category === undefined ? { allBudgets: row(p.total) } : {}),
        ...(rows.length ? {} : { note: a.category === undefined ? "No budgets are set on this dashboard." : `No budget is set for ${a.category}. Budgets exist for: ${p.rows.map((r) => r.category).join(", ") || "none"}.` }),
      };
    },
  },
  {
    name: "get_recurring_streams",
    description: "Detected recurring money streams: paycheques and other regular income, rent, bills and subscriptions, with cadence, typical and latest amount and next expected date. Use for 'what subscriptions do I have', 'when is my next paycheque', fixed costs.",
    properties: { direction: { type: "string", enum: ["in", "out"], description: "'in' = income only, 'out' = bills and subscriptions only. Omit for both." } },
    run: (a, { ledger: l, now }) => {
      const streams = detectRecurring(l.transactions, todayKey(now)).filter((s) => a.direction === undefined || s.direction === a.direction);
      return {
        count: streams.length,
        streams: streams.slice(0, 40).map((s) => ({ merchant: s.merchant, direction: s.direction, everyDays: s.cadenceDays, typicalAmount: r2(s.amount), lastAmount: r2(s.lastAmount), currency: s.currency, lastDate: s.lastDate, nextDate: s.nextDate, timesSeen: s.occurrences.length })),
        note: "Amounts are positive, in each stream's own currency; direction says whether it is money in or out.",
      };
    },
  },
  {
    name: "get_anomalies",
    description: "Money leaks found in the last 45 days: possible duplicate charges, subscription price increases, bank fees and unusually large charges. Use for 'anything unusual', 'did a subscription go up', 'what fees did I pay'.",
    properties: { kind: { type: "string", enum: ANOMALY_KINDS, description: "Only this kind. Omit for all kinds." } },
    run: (a, { ledger: l, now }) => {
      const all = detectAnomalies(l.transactions, { now }).filter((x) => a.kind === undefined || x.kind === a.kind);
      return {
        count: all.length, lookbackDays: 45,
        anomalies: all.slice(0, 25).map((x) => ({ kind: x.kind, title: x.title, detail: x.detail, date: x.date, amount: x.amount, currency: x.currency, severity: x.severity })),
      };
    },
  },
  {
    name: "search_transactions",
    description: "Find individual transactions by merchant text, category and/or date range, newest first, with pre-summed totals for everything that matched. Use for 'how much at Trader Joe's', 'show my Uber rides', 'biggest purchases last month'.",
    properties: {
      merchant: { type: "string", maxLength: 80, description: "Case-insensitive text to find in the merchant name, e.g. 'netflix'." },
      category: { type: "string", enum: CATEGORIES, description: "Only this category." },
      ...DATE_RANGE,
      min_amount: { type: "number", minimum: 0, description: "Only transactions of at least this size (absolute value, in the transaction's own currency)." },
      limit: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: `Max rows to return (default 20, max ${MAX_ROWS}). Totals always cover every match.` },
    },
    check: rangeCheck,
    run: (a, { ledger: l, now }) => {
      const rg = range(a, now, null);
      const needle = a.merchant === undefined ? null : String(a.merchant).toLowerCase();
      const hits = l.transactions.filter((t) => {
        // own-account transfers are neither spending nor income; only listed when asked for by category
        if (isTransfer(t) && a.category !== "Transfer") return false;
        if (a.category !== undefined && t.category !== a.category) return false;
        if (rg && (t.date < rg.from || t.date > rg.to)) return false;
        if (a.min_amount !== undefined && Math.abs(t.amount) < Number(a.min_amount)) return false;
        return !needle || `${t.cleaned_merchant_name ?? ""} ${t.raw_merchant_string}`.toLowerCase().includes(needle);
      }).sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
      const base = (t: Transaction) => { try { return convert(t.amount, t.iso_currency_code, l.fx); } catch { return null; } };
      let spent = 0, received = 0, noRate = 0;
      for (const t of hits) { const v = base(t); if (v === null) noRate++; else if (v > 0) spent += v; else received -= v; }
      const limit = Number(a.limit ?? 20);
      return {
        ...(rg ?? {}), baseCurrency: l.base, matched: hits.length, returned: Math.min(limit, hits.length), truncated: hits.length > limit,
        totals: { spent: r2(spent), received: r2(received), ...(noRate ? { excludedNoFxRate: noRate } : {}), note: "Base currency, over ALL matches (not only the rows returned)." },
        rows: hits.slice(0, limit).map((t) => { const v = base(t); return { date: t.date, merchant: t.cleaned_merchant_name ?? t.raw_merchant_string, amount: t.amount, currency: t.iso_currency_code, amountBase: v === null ? null : r2(v), category: t.category ?? "Uncategorized", ...(t.is_pending ? { pending: true } : {}) }; }),
        note: "amount: positive = money spent, negative = money received.",
      };
    },
  },
];

const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));
export const TOOL_NAMES = DEFS.map((d) => d.name);

/** Function schemas in the shape Ollama's `/api/chat` (and the OpenAI API) expects. */
export const TOOL_SCHEMAS = DEFS.map((d) => ({
  type: "function" as const,
  function: { name: d.name, description: d.description, parameters: { type: "object" as const, properties: d.properties as Record<string, unknown>, required: d.required ?? [] } },
}));
export type ToolSchema = (typeof TOOL_SCHEMAS)[number];

// ── validation + dispatch ────────────────────────────────────────────────────────────────────────

/**
 * Check model-supplied arguments against a tool's schema. Lenient where small models are sloppy
 * (numeric strings, enum casing, null for "not set", unknown extra keys are dropped), strict on
 * meaning: wrong types, unknown enum values and impossible dates are errors, and numbers above a
 * cap are clamped to it.
 */
export function validateArgs(name: string, raw: unknown): { ok: true; args: Args } | { ok: false; message: string } {
  const def = BY_NAME.get(name);
  if (!def) return { ok: false, message: `Unknown tool "${name}".` };
  let input = raw;
  if (typeof input === "string") { try { input = input.trim() ? JSON.parse(input) : {}; } catch { return { ok: false, message: "Arguments must be a JSON object." }; } }
  if (input == null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "Arguments must be a JSON object." };
  const args: Args = {};
  const problems: string[] = [];
  for (const [key, p] of Object.entries(def.properties)) {
    let v = (input as Record<string, unknown>)[key];
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) {
      if (def.required?.includes(key)) problems.push(`\`${key}\` is required.`);
      continue;
    }
    if (p.type === "string") {
      if (typeof v !== "string") { problems.push(`\`${key}\` must be a string.`); continue; }
      v = v.trim();
      if (p.enum) {
        const hit = p.enum.find((e) => e.toLowerCase() === (v as string).toLowerCase());
        if (!hit) { problems.push(`\`${key}\` must be one of: ${p.enum.join(", ")}.`); continue; }
        v = hit;
      }
      if (p.format === "date" && !isDate(v as string)) { problems.push(`\`${key}\` must be a real calendar date in YYYY-MM-DD format.`); continue; }
      if (p.maxLength && (v as string).length > p.maxLength) { problems.push(`\`${key}\` must be at most ${p.maxLength} characters.`); continue; }
      args[key] = v as string;
    } else {
      const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
      if (!Number.isFinite(n)) { problems.push(`\`${key}\` must be a number.`); continue; }
      if (p.type === "integer" && !Number.isInteger(n)) { problems.push(`\`${key}\` must be a whole number.`); continue; }
      if (p.minimum !== undefined && n < p.minimum) { problems.push(`\`${key}\` must be at least ${p.minimum}.`); continue; }
      args[key] = p.maximum !== undefined && n > p.maximum ? p.maximum : n; // caps clamp instead of failing
    }
  }
  if (!problems.length) { const cross = def.check?.(args); if (cross) problems.push(cross); }
  return problems.length ? { ok: false, message: problems.join(" ") } : { ok: true, args };
}

/**
 * Run one tool call. Never throws: an unknown tool, bad arguments or a failure inside the engine
 * all come back as a structured error the model can read and correct.
 */
export function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): ToolResult {
  const tool = String(name ?? "");
  const def = BY_NAME.get(tool);
  if (!def) return { ok: false, tool, error: { code: "unknown_tool", message: `There is no tool named "${tool}".`, validTools: TOOL_NAMES } };
  const v = validateArgs(tool, rawArgs);
  if (!v.ok) return { ok: false, tool, error: { code: "invalid_arguments", message: v.message } };
  try { return { ok: true, tool, result: def.run(v.args, ctx) }; }
  catch (e) { return { ok: false, tool, error: { code: "tool_failed", message: e instanceof Error ? e.message : String(e) } }; }
}
