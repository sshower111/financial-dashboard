import type { Account, Budget, FxTable, Holding, Transaction } from "../types.ts";
import { computeNetWorth } from "../finance/networth.ts";
import { cashFlow, spendByCategory } from "../finance/cashflow.ts";
import { addDays, parseKey, todayKey } from "../finance/dates.ts";
import { forecastCash } from "../finance/forecast.ts";
import { detectAnomalies } from "../finance/anomaly.ts";
import { budgetPacing } from "../finance/pacing.ts";
import { convert } from "../finance/fx.ts";

export interface Ledger { accounts: Account[]; transactions: Transaction[]; holdings: Holding[]; budgets: Budget[]; fx: FxTable; base: string }

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compact, pre-aggregated snapshot of the ledger for the copilot prompt.
 * Numbers are computed here (deterministically) so the model explains rather than does arithmetic.
 */
export function buildLedgerContext(l: Ledger, now = new Date()): string {
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
  const dow = parseKey(today).getUTCDay();
  return JSON.stringify({
    today, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow], baseCurrency: l.base,
    netWorth: { total: r2(nw.total), assets: r2(nw.assets), liabilities: r2(nw.liabilities), byType: Object.fromEntries(Object.entries(nw.byType).map(([k, v]) => [k, r2(v)])), nativeByCurrency: nw.byCurrency },
    accounts: l.accounts.map((a) => ({ name: a.name, type: a.type, currency: a.currency, balance: a.current_balance })),
    holdings: l.holdings.map((h) => ({ ticker: h.ticker, qty: h.quantity, value: h.institution_value, ccy: h.currency })),
    weeklyBurn: weeks,
    budgets: budgetPacing(l.budgets, l.transactions, l.fx, now).rows.map((r) => ({ category: r.category, spent: r2(r.spent), limit: r2(r.limit), velocity: r2(r.velocity), status: r.status })),
    forecast30d: { start: r2(fc.start), end: r2(fc.end), min: r2(fc.min), minDate: fc.minDate, weather: fc.weather, dailyDiscretionaryBurn: r2(fc.dailyBurn), upcoming: fc.events.slice(0, 15).map((e) => ({ ...e, amount: r2(e.amount) })) },
    recurring: fc.streams.map((s) => ({ merchant: s.merchant, everyDays: s.cadenceDays, amount: r2(s.amount), ccy: s.currency, direction: s.direction, next: s.nextDate })),
    anomalies: detectAnomalies(l.transactions, { now }).map((a) => ({ kind: a.kind, title: a.title, detail: a.detail, date: a.date })),
    history: { oldestTransaction: oldest, transactionCount: l.transactions.length, monthlyTotalsBase: monthly, note: "recentTransactions lists only the last 45 days; older months are in monthlyTotalsBase" },
    recentTransactionsFormat:"date|merchant|amount(native,+=spent)|ccy|amount(base)|category|flag",
    recentTransactions: recent,
  });
}

export const COPILOT_SYSTEM = `You are the assistant inside a personal finance dashboard. You answer questions about the user's own finances using ONLY the JSON ledger snapshot provided.
Rules:
- Be direct and brief: lead with the answer in one sentence, then up to 4 short supporting bullets with specific merchants, dates and amounts.
- Prefer the precomputed figures (weeklyBurn, budgets, forecast30d) over doing your own arithmetic. If you must compute, show the inputs.
- Amounts: positive = spent, negative = received. Quote money with currency codes, e.g. "USD 1,204.50".
- If the snapshot cannot answer the question, say exactly what data is missing. Never invent transactions.
- No investment, tax or legal advice beyond describing the user's own data.`;
