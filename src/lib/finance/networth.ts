import type { Account, FxTable, Transaction } from "../types.ts";
import { convert } from "./fx.ts";

export interface NetWorth {
  total: number;
  assets: number;
  liabilities: number;
  byType: Record<"depository" | "investment" | "credit" | "loan" | "other", number>;
  /** native-currency subtotals, so USD and CAD stay visible before conversion */
  byCurrency: Record<string, { assets: number; liabilities: number }>;
  missingFx: string[];
}

const isLiability = (a: Account) => a.type === "credit" || a.type === "loan";

export function computeNetWorth(accounts: Account[], fx: FxTable): NetWorth {
  const out: NetWorth = {
    total: 0, assets: 0, liabilities: 0,
    byType: { depository: 0, investment: 0, credit: 0, loan: 0, other: 0 },
    byCurrency: {}, missingFx: [],
  };
  for (const a of accounts) {
    if (!a.is_active || a.current_balance == null) continue;
    const native = a.current_balance;
    const bucket = (out.byCurrency[a.currency] ??= { assets: 0, liabilities: 0 });
    if (isLiability(a)) bucket.liabilities += native; else bucket.assets += native;
    let base: number;
    try { base = convert(native, a.currency, fx); }
    catch { if (!out.missingFx.includes(a.currency)) out.missingFx.push(a.currency); continue; }
    out.byType[a.type] += base;
    if (isLiability(a)) out.liabilities += base; else out.assets += base;
  }
  out.total = out.assets - out.liabilities;
  return out;
}

/**
 * Estimated daily net-worth history, rolled back from today's balances using
 * transactions. Investment values are held constant (no price history), so
 * the series reflects cash movement only — label it as an estimate.
 */
export function netWorthHistory(
  accounts: Account[], txns: Transaction[], fx: FxTable, days: number, today = new Date(),
): { date: string; value: number }[] {
  const nowTotal = computeNetWorth(accounts, fx).total;
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  // effect of each txn on net worth (base ccy): outflow from an asset lowers NW,
  // a charge on a credit card raises the liability — both are −amount.
  const deltaByDate = new Map<string, number>();
  for (const t of txns) {
    const a = acctById.get(t.account_id);
    if (!a || !a.is_active || t.is_pending) continue;
    if (a.type === "investment") continue;
    let v: number;
    try { v = convert(-t.amount, t.iso_currency_code, fx); } catch { continue; }
    deltaByDate.set(t.date, (deltaByDate.get(t.date) ?? 0) + v);
  }
  const series: { date: string; value: number }[] = [];
  let value = nowTotal;
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, value });
    value -= deltaByDate.get(key) ?? 0; // undo that day's movement to get the prior close
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return series.reverse();
}
