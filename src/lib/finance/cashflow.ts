import type { FxTable, Transaction } from "../types.ts";
import { convert } from "./fx.ts";
import { addDays, todayKey } from "./dates.ts";

const isTransfer = (t: Transaction) => t.category === "Transfer";

export interface CashFlow { inflow: number; outflow: number; net: number }

/** Inflow/outflow over [from, to], excluding internal transfers. */
export function cashFlow(txns: Transaction[], fx: FxTable, from: string, to: string): CashFlow {
  let inflow = 0, outflow = 0;
  for (const t of txns) {
    if (t.date < from || t.date > to || isTransfer(t)) continue;
    let v: number;
    try { v = convert(t.amount, t.iso_currency_code, fx); } catch { continue; }
    if (v < 0) inflow += -v; else outflow += v;
  }
  return { inflow, outflow, net: inflow - outflow };
}

/** Trailing-30-day net cash flow and its change vs the prior 30 days. */
export function cashFlowDelta(txns: Transaction[], fx: FxTable, now = new Date()) {
  const today = todayKey(now);
  const cur = cashFlow(txns, fx, addDays(today, -29), today);
  const prev = cashFlow(txns, fx, addDays(today, -59), addDays(today, -30));
  return { current: cur, previous: prev, change: cur.net - prev.net };
}

export function spendByCategory(txns: Transaction[], fx: FxTable, from: string, to: string) {
  const m = new Map<string, number>();
  for (const t of txns) {
    if (t.date < from || t.date > to || t.amount <= 0 || isTransfer(t) || t.category === "Income") continue;
    let v: number;
    try { v = convert(t.amount, t.iso_currency_code, fx); } catch { continue; }
    const c = t.category ?? "Uncategorized";
    m.set(c, (m.get(c) ?? 0) + v);
  }
  return [...m.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}
