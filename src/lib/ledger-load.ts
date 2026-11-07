import type { SupabaseClient } from "@supabase/supabase-js";
import type { Account, Budget, Currency, Holding, Institution, Transaction } from "./types.ts";
import { buildFxTable, type FxRow } from "./finance/fx.ts";
import { demoAccounts, demoBudgets, demoFx, demoHoldings, demoInstitutions, demoTransactions } from "./demo.ts";
import type { Ledger } from "./ai/context.ts";
import { DEFAULT_DASHBOARDS, type Dashboard } from "./finance/scope.ts";

export interface LedgerData {
  institutions: Institution[]; accounts: Account[]; transactions: Transaction[];
  holdings: Holding[]; budgets: Budget[]; fxRows: FxRow[]; base: Currency;
  /** dashboard ids + names, in tab order (migration 0004) */
  dashboards: Dashboard[];
}

const num = (v: unknown) => (v == null ? null : Number(v));

/** Load everything the dashboard needs. RLS scopes every query to the signed-in user. */
export async function loadLedger(sb: SupabaseClient, days = 180): Promise<LedgerData> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const [ins, acc, tx, hold, bud, fx, settings] = await Promise.all([
    sb.from("institutions").select("id,name,country,created_at,plaid_institution_id").order("created_at"),
    sb.from("accounts").select("*").eq("is_active", true),
    sb.from("transactions").select("*").gte("date", since).order("date", { ascending: false }).order("created_at", { ascending: false }).limit(5000),
    sb.from("investment_holdings").select("*"),
    sb.from("budgets").select("*"),
    sb.from("fx_rates").select("base,quote,rate"),
    sb.from("user_settings").select("base_currency,dashboards").maybeSingle(),
  ]);
  for (const r of [ins, acc, tx, hold, bud, fx]) if (r.error) throw r.error;
  return {
    institutions: ins.data as Institution[],
    accounts: (acc.data ?? []).map((a) => ({ ...a, current_balance: num(a.current_balance), available_balance: num(a.available_balance), limit_amount: num(a.limit_amount) })) as Account[],
    transactions: (tx.data ?? []).map((t) => ({ ...t, amount: Number(t.amount), ai_confidence_score: num(t.ai_confidence_score) })) as Transaction[],
    holdings: (hold.data ?? []).map((h) => ({ ...h, quantity: Number(h.quantity), institution_price: Number(h.institution_price), institution_value: Number(h.institution_value) })) as Holding[],
    budgets: (bud.data ?? []).map((b) => ({ ...b, monthly_limit: Number(b.monthly_limit) })) as Budget[],
    fxRows: (fx.data ?? []).map((f) => ({ ...f, rate: Number(f.rate) })) as FxRow[],
    base: (settings.data?.base_currency as Currency) ?? "USD",
    dashboards: Array.isArray(settings.data?.dashboards) ? (settings.data.dashboards as Dashboard[]) : DEFAULT_DASHBOARDS,
  };
}

export function demoLedger(): LedgerData {
  return { institutions: demoInstitutions, accounts: demoAccounts, transactions: demoTransactions(), holdings: demoHoldings, budgets: demoBudgets, fxRows: demoFx, base: "USD", dashboards: DEFAULT_DASHBOARDS };
}

export const toLedger = (d: LedgerData, base: Currency = d.base): Ledger => ({
  accounts: d.accounts, transactions: d.transactions, holdings: d.holdings, budgets: d.budgets, fx: buildFxTable(d.fxRows, base), base,
});
