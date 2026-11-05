"use client";
import { useMemo } from "react";
import { useLedger } from "./ledger";
import { buildFxTable } from "@/lib/finance/fx";
import { computeNetWorth, netWorthHistory } from "@/lib/finance/networth";
import { cashFlowDelta } from "@/lib/finance/cashflow";
import { forecastCash } from "@/lib/finance/forecast";
import { detectAnomalies } from "@/lib/finance/anomaly";
import { budgetPacing } from "@/lib/finance/pacing";

/** All derived figures, memoized on the raw ledger + base currency. */
export function useDerived() {
  const data = useLedger((s) => s.data);
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
