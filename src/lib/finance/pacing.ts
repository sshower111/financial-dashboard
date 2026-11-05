import type { Budget, FxTable, Transaction } from "../types.ts";
import { convert } from "./fx.ts";
import { daysInMonth, toKey } from "./dates.ts";

export type PaceStatus = "under" | "on-track" | "over";

export interface PaceRow {
  category: string;
  spent: number;
  limit: number;
  /** spent / limit */
  used: number;
  /** used / monthProgress — 1.0 means exactly on pace */
  velocity: number;
  projected: number;
  status: PaceStatus;
}

export interface Pacing {
  monthProgress: number;
  day: number;
  daysInMonth: number;
  rows: PaceRow[];
  total: PaceRow;
}

function status(velocity: number): PaceStatus {
  if (velocity > 1.1) return "over";
  if (velocity < 0.9) return "under";
  return "on-track";
}

/** Month-to-date spend vs. day-of-month progress, per budget and overall. */
export function budgetPacing(budgets: Budget[], txns: Transaction[], fx: FxTable, now = new Date()): Pacing {
  const y = now.getFullYear(), m = now.getMonth();
  const dim = daysInMonth(y, m);
  const day = now.getDate();
  // count today as ~half elapsed so the first morning of the month doesn't read as 0%
  const progress = Math.min(1, (day - 0.5) / dim);
  const start = toKey(new Date(Date.UTC(y, m, 1)));
  const end = toKey(new Date(Date.UTC(y, m, dim)));

  const spent = new Map<string, number>();
  for (const t of txns) {
    if (t.date < start || t.date > end || t.amount <= 0 || !t.category) continue;
    try { spent.set(t.category, (spent.get(t.category) ?? 0) + convert(t.amount, t.iso_currency_code, fx)); }
    catch { /* skip unknown ccy */ }
  }
  const mk = (category: string, s: number, limit: number): PaceRow => {
    const used = limit > 0 ? s / limit : 0;
    const velocity = progress > 0 ? used / progress : 0;
    return { category, spent: s, limit, used, velocity, projected: progress > 0 ? s / progress : s, status: status(velocity) };
  };
  const rows = budgets.map((b) => mk(b.category, spent.get(b.category) ?? 0, convert(b.monthly_limit, b.currency, fx)))
    .sort((a, b) => b.velocity - a.velocity);
  const total = mk("All budgets", rows.reduce((s, r) => s + r.spent, 0), rows.reduce((s, r) => s + r.limit, 0));
  return { monthProgress: progress, day, daysInMonth: dim, rows, total };
}
