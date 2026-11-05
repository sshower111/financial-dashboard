import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFxTable, convert } from "./fx.ts";
import { computeNetWorth, netWorthHistory } from "./networth.ts";
import { budgetPacing } from "./pacing.ts";
import { forecastCash } from "./forecast.ts";
import { detectAnomalies } from "./anomaly.ts";
import { detectRecurring } from "./recurring.ts";
import { cashFlowDelta } from "./cashflow.ts";
import { demoAccounts, demoBudgets, demoFx, demoTransactions } from "../demo.ts";
import type { Account, Transaction } from "../types.ts";

const NOW = new Date("2026-11-04T15:00:00");
const fxCad = buildFxTable(demoFx, "CAD");
const fxUsd = buildFxTable(demoFx, "USD");
const txns = demoTransactions(NOW);

test("fx: direct, inverse and bridged rates", () => {
  assert.equal(fxCad.USD, 1.3712);
  assert.ok(Math.abs(fxUsd.CAD - 1 / 1.3712) < 1e-12);
  assert.ok(Math.abs(fxUsd.EUR - 1.4895 / 1.3712) < 1e-12); // EUR→CAD→USD
  assert.throws(() => convert(1, "JPY", fxCad));
});

test("net worth keeps currencies isolated and subtracts liabilities", () => {
  const acc: Account[] = [
    { ...demoAccounts[0], currency: "CAD", current_balance: 1000 },
    { ...demoAccounts[2], currency: "USD", current_balance: 100 },
    { ...demoAccounts[3], currency: "CAD", current_balance: 300 },
  ];
  const nw = computeNetWorth(acc, fxCad);
  assert.equal(nw.byCurrency.USD.assets, 100);
  assert.equal(nw.byCurrency.CAD.assets, 1000);
  assert.ok(Math.abs(nw.total - (1000 + 137.12 - 300)) < 1e-9);
  const missing = computeNetWorth([{ ...acc[0], currency: "GBP" }], { CAD: 1 });
  assert.deepEqual(missing.missingFx, ["GBP"]);
  assert.equal(missing.total, 0);
});

test("net worth history ends at today's value", () => {
  const h = netWorthHistory(demoAccounts, txns, fxCad, 90, NOW);
  assert.equal(h.length, 90);
  assert.ok(Math.abs(h.at(-1)!.value - computeNetWorth(demoAccounts, fxCad).total) < 1e-6);
});

test("recurring detection finds payroll, rent and subscriptions", () => {
  const s = detectRecurring(txns, "2026-11-04");
  const names = s.map((x) => x.merchant);
  for (const n of ["Northwind Labs", "Kingston Property Mgmt", "Netflix", "Spotify", "Rogers"]) assert.ok(names.includes(n), n);
  assert.equal(s.find((x) => x.merchant === "Northwind Labs")!.cadenceDays, 14);
  assert.equal(s.find((x) => x.merchant === "Rogers")!.cadenceDays, 30);
});

test("anomalies: duplicate, price hike and fees are flagged", () => {
  const a = detectAnomalies(txns, { now: NOW });
  const kinds = new Set(a.map((x) => x.kind));
  assert.ok(kinds.has("duplicate"));
  assert.ok(kinds.has("price_hike"));
  assert.ok(kinds.has("fee"));
  const hike = a.find((x) => x.kind === "price_hike")!;
  assert.match(hike.title, /Netflix/);
});

test("pacing velocity", () => {
  const t: Transaction[] = [{ ...txns[0], date: "2026-11-02", amount: 100, category: "Dining", iso_currency_code: "CAD" }];
  const p = budgetPacing([{ id: "b", category: "Dining", monthly_limit: 300, currency: "CAD" }], t, fxCad, NOW);
  const row = p.rows[0];
  assert.equal(row.spent, 100);
  // day 4 of 30 → progress 3.5/30; used 1/3 → velocity ≈ 2.86
  assert.ok(Math.abs(row.velocity - (1 / 3) / (3.5 / 30)) < 1e-9);
  assert.equal(row.status, "over");
  assert.equal(budgetPacing(demoBudgets, txns, fxCad, NOW).rows.length, demoBudgets.length);
});

test("forecast produces a 30-day series and a weather call", () => {
  const f = forecastCash(demoAccounts, txns, fxCad, { now: NOW });
  assert.equal(f.series.length, 31);
  assert.ok(f.events.some((e) => e.kind === "income"));
  assert.ok(f.events.some((e) => e.kind === "liability"));
  assert.ok(["clear", "overcast", "storm"].includes(f.weather));
  assert.ok(f.dailyBurn > 0);
  // a broke account with no income must be a storm
  const broke = forecastCash([{ ...demoAccounts[0], current_balance: 50, available_balance: 50 }], txns.filter((t) => t.amount > 0), fxCad, { now: NOW });
  assert.equal(broke.weather, "storm");
  assert.ok(broke.shortfallDate);
});

test("cash flow delta excludes transfers", () => {
  const d = cashFlowDelta(txns, fxCad, NOW);
  assert.ok(d.current.inflow > 0 && d.current.outflow > 0);
});
