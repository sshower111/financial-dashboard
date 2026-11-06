"use client";
import { useMemo } from "react";
import { useLedger } from "./ledger";
import { buildFxTable } from "@/lib/finance/fx";
import { computeNetWorth, netWorthHistory } from "@/lib/finance/networth";
import { cashFlowDelta } from "@/lib/finance/cashflow";
import { forecastCash } from "@/lib/finance/forecast";
import { detectAnomalies } from "@/lib/finance/anomaly";
import { budgetPacing } from "@/lib/finance/pacing";
import { scopeLedger } from "@/lib/finance/scope";
import { markTransfers } from "@/lib/finance/transfers";

/** The ledger as seen from the open dashboard (its accounts, transactions, holdings, budgets). Every panel reads this. */
export function useScopedData() {
  const data = useLedger((s) => s.data);
  const dashboard = useLedger((s) => s.dashboard);
  // transfer pairing spans accounts, so it runs on the full ledger before scoping
  const marked = useMemo(() => (data ? markTransfers(data) : null), [data]);
  return useMemo(() => (marked ? scopeLedger(marked, dashboard) : null), [marked, dashboard]);
}

/** All derived figures, memoized on the raw ledger + base currency. */
export function useDerived() {
  const data = useScopedData();
  const base = useLedger((s) => s.base);
  return useMemo(() => {
    if (!data) return null;
    const fx = buildFxTable(data.fxRows, base);
    const txns = data.transactions;
    return {
      fx, base,
      netWorth: computeNetWorth(data.accounts, fx),
      history: netWorthHistory(data.accounts, txns, fx, 90),
      cash: cashFlowDelta(txns, fx),
      forecast: forecastCash(data.accounts, txns, fx),
      anomalies: detectAnomalies(txns),
      pacing: budgetPacing(data.budgets, txns, fx),
    };
  }, [data, base]);
}
