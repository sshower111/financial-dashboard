import type { Account, Budget, FxTable, Holding, Transaction } from "../types.ts";
import { computeNetWorth } from "../finance/networth.ts";
import { cashFlow, spendByCategory } from "../finance/cashflow.ts";
import { addDays, parseKey, todayKey } from "../finance/dates.ts";
import { forecastCash } from "../finance/forecast.ts";
import { detectAnomalies } from "../finance/anomaly.ts";
import { budgetPacing } from "../finance/pacing.ts";
import { convert } from "../finance/fx.ts";
import { accountLabel } from "../format.ts";
import { isTransfer } from "../finance/transfers.ts";

/** Everyday phrases → merchants / categories they mean (rideshare must not pull in Uber Eats). */
const TOPICS: { ask: RegExp; match: RegExp; not?: RegExp; label: string }[] = [
  { ask: /\b(ride ?share|share ?ride|ride[- ]?hail|uber(?![\s*]*eats)|lyft|taxi|cab)s?\b/i, match: /\b(uber|lyft|taxi|cab)\b/i, not: /eats/i, label: "rideshare (Uber, Lyft, taxi)" },
  { ask: /\b(food delivery|delivery|takeout|take-out|uber ?eats|doordash|skip the dishes|instacart)\b/i, match: /\b(uber[\s*]*eats|doordash|skip ?the ?dishes|instacart|grubhub|food delivery)\b/i, label: "food delivery" },
  { ask: /\b(gas|fuel|petrol)\b/i, match: /\b(gas|fuel|shell|esso|petro|chevron|exxon|circle k)\b/i, label: "gas / fuel" },
  { ask: /\b(coffee|cafe|starbucks|tim hortons)\b/i, match: /\b(coffee|cafe|starbucks|tim hortons)\b/i, label: "coffee" },
];
const STOP = new Set("about after also amount average been between could does each from have help into last least many month monthly months more much past paid pay spend spent than that their them they this those total what when which with year years your".split(" "));

/**
 * Transactions from the WHOLE history that the question is about: topic phrases (rideshare, delivery…),
 * or question words that name a merchant / category / subcategory. Pre-summed per month so a small
 * model reads the answer instead of adding up rows.
 */
export function questionMatches(question: string, txns: Transaction[], fx: FxTable) {
  const topics = TOPICS.filter((t) => t.ask.test(question));
  const words = (question.toLowerCase().match(/[a-z][a-z0-9&']{3,}/g) ?? []).filter((w) => !STOP.has(w));
  const fields = (t: Transaction) => `${t.cleaned_merchant_name ?? ""} ${t.raw_merchant_string} ${t.category ?? ""} ${t.subcategory ?? ""}`;
  const wordHit = (t: Transaction) => {
    const toks = new Set(fields(t).toLowerCase().split(/[^a-z0-9&']+/));
    return words.some((w) => toks.has(w) || toks.has(w.replace(/s$/, "")));
  };
  // topics match the bank's merchant text only: AI subcategories can be wrong (e.g. airlines tagged "Rideshare")
  const merchant = (t: Transaction) => `${t.cleaned_merchant_name ?? ""} ${t.raw_merchant_string}`;
  const hits = txns.filter((t) => !isTransfer(t) && (topics.length ? topics.some((p) => p.match.test(merchant(t)) && !p.not?.test(merchant(t))) : wordHit(t)));
  if (!hits.length) return null;
  const months = new Map<string, { count: number; spent: number; refunds: number }>();
  for (const t of hits) {
    let v = 0; try { v = convert(t.amount, t.iso_currency_code, fx); } catch { continue; }
    const m = months.get(t.date.slice(0, 7)) ?? { count: 0, spent: 0, refunds: 0 };
    m.count++; if (v > 0) m.spent += v; else m.refunds -= v;
    months.set(t.date.slice(0, 7), m);
  }
  return {
    matchedOn: topics.length ? topics.map((t) => t.label) : words,
    note: "Every matching transaction in the full history, summed per month in the base currency (spent = money out, refunds = money back). Months not listed had none.",
    monthly: [...months].sort(([a], [b]) => b.localeCompare(a)).map(([month, m]) => ({ month, count: m.count, spent: r2(m.spent), refunds: r2(m.refunds) })),
    rowsFormat: "date|merchant|amount(native,+=spent)|ccy|category",
    rows: hits.slice(0, 150).map((t) => [t.date, t.cleaned_merchant_name ?? t.raw_merchant_string, t.amount, t.iso_currency_code, t.category ?? "?"].join("|")),
  };
}

export interface Ledger { accounts: Account[]; transactions: Transaction[]; holdings: Holding[]; budgets: Budget[]; fx: FxTable; base: string }

const r2 = (n: number) => Math.round(n * 100) / 100;
/** last day of a "YYYY-MM" month */
const endOf = (ym: string) => { const [y, m] = ym.split("-").map(Number); return addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`, -1); };

/**
 * Compact, pre-aggregated snapshot of the ledger for the copilot prompt.
 * Numbers are computed here (deterministically) so the model explains rather than does arithmetic.
 */
export function buildLedgerContext(l: Ledger, now = new Date(), question = ""): string {
  const today = todayKey(now);
  const nw = computeNetWorth(l.accounts, l.fx);
  const weeks = [0, 1, 2, 3].map((w) => {
    const to = addDays(today, -7 * w), from = addDays(to, -6);
    const cf = cashFlow(l.transactions, l.fx, from, to);
    return { week: `${from}..${to}`, spend: r2(cf.outflow), income: r2(cf.inflow), byCategory: spendByCategory(l.transactions, l.fx, from, to).slice(0, 6).map((c) => ({ ...c, amount: r2(c.amount) })) };
  });
  const fc = forecastCash(l.accounts, l.transactions, l.fx, { now });
  const recent = l.transactions.filter((t) => t.date >= addDays(today, -45)).slice(0, 220).map((t) => {
    let base: number | null = null; try { base = r2(convert(t.amount, t.iso_currency_code, l.fx)); } catch { /* */ }
    return [t.date, t.cleaned_merchant_name ?? t.raw_merchant_string, t.amount, t.iso_currency_code, base, t.category ?? "?", t.is_anomaly ? "ANOMALY" : ""].join("|");
  });
  // whole history as monthly totals, so questions beyond the 45-day detail window still get answers
  let oldest = today;
  for (const t of l.transactions) if (t.date < oldest) oldest = t.date;
  const monthly: { month: string; spend: number; income: number }[] = [];
  for (let m = oldest.slice(0, 7); m <= today.slice(0, 7);) {
    const [y, mo] = m.split("-").map(Number);
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    const cf = cashFlow(l.transactions, l.fx, `${m}-01`, addDays(`${next}-01`, -1));
    monthly.push({ month: m, spend: r2(cf.outflow), income: r2(cf.inflow) });
    m = next;
  }
  // spending by category for each of the last 6 calendar months (current month to date)
  const byCategory = monthly.slice(-6).reverse().map(({ month }) => ({
    month, categories: spendByCategory(l.transactions, l.fx, `${month}-01`, today < endOf(month) ? today : endOf(month)).slice(0, 10).map((c) => ({ ...c, amount: r2(c.amount) })),
  }));
  const matches = question ? questionMatches(question, l.transactions, l.fx) : null;
  const dow = parseKey(today).getUTCDay();
  return JSON.stringify({
    today, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow], baseCurrency: l.base,
    netWorth: { total: r2(nw.total), assets: r2(nw.assets), liabilities: r2(nw.liabilities), byType: Object.fromEntries(Object.entries(nw.byType).map(([k, v]) => [k, r2(v)])), nativeByCurrency: nw.byCurrency },
    accounts: l.accounts.map((a) => ({ name: accountLabel(a), type: a.type, currency: a.currency, balance: a.current_balance })),
    holdings: l.holdings.map((h) => ({ ticker: h.ticker, qty: h.quantity, value: h.institution_value, ccy: h.currency })),
    weeklyBurn: weeks,
    budgets: budgetPacing(l.budgets, l.transactions, l.fx, now).rows.map((r) => ({ category: r.category, spent: r2(r.spent), limit: r2(r.limit), velocity: r2(r.velocity), status: r.status })),
    forecast30d: { start: r2(fc.start), end: r2(fc.end), min: r2(fc.min), minDate: fc.minDate, weather: fc.weather, dailyDiscretionaryBurn: r2(fc.dailyBurn), upcoming: fc.events.slice(0, 15).map((e) => ({ ...e, amount: r2(e.amount) })) },
    recurring: fc.streams.map((s) => ({ merchant: s.merchant, everyDays: s.cadenceDays, amount: r2(s.amount), ccy: s.currency, direction: s.direction, next: s.nextDate })),
    anomalies: detectAnomalies(l.transactions, { now }).map((a) => ({ kind: a.kind, title: a.title, detail: a.detail, date: a.date })),
    ...(matches ? { matchingTransactions: matches } : {}),
    monthlySpendByCategory: byCategory,
    history: { oldestTransaction: oldest, transactionCount: l.transactions.length, monthlyTotalsBase: monthly, note: "recentTransactions lists only the last 45 days; older months are in monthlyTotalsBase" },
    recentTransactionsFormat:"date|merchant|amount(native,+=spent)|ccy|amount(base)|category|flag",
    recentTransactions: recent,
  });
}

export const COPILOT_SYSTEM = `You are the assistant inside a personal finance dashboard. You answer questions about the user's own finances using ONLY the JSON ledger snapshot provided.
Rules:
- Be direct and brief: lead with the answer in one sentence, then up to 4 short supporting bullets with specific merchants, dates and amounts.
- Prefer the precomputed figures (weeklyBurn, budgets, forecast30d) over doing your own arithmetic. If you must compute, show the inputs.
- Amounts: positive = spent, negative = received. Quote totals in baseCurrency (the snapshot figures are already in it), with the code, e.g. "CAD 1,204.50".
- If the snapshot cannot answer the question, say exactly what data is missing. Never invent transactions.
- No investment, tax or legal advice beyond describing the user's own data.`;
