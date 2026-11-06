import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFxTable, convert } from "./fx.ts";
import { computeNetWorth, netWorthHistory } from "./networth.ts";
import { budgetPacing } from "./pacing.ts";
import { forecastCash } from "./forecast.ts";
import { detectAnomalies } from "./anomaly.ts";
import { detectRecurring } from "./recurring.ts";
import { cashFlow, cashFlowDelta, spendByCategory } from "./cashflow.ts";
import { demoAccounts, demoBudgets, demoFx, demoTransactions } from "../demo.ts";
import type { Account, Transaction } from "../types.ts";

const NOW = new Date("2026-11-04T15:00:00");
const fxUsd = buildFxTable(demoFx, "USD");
const fxEur = buildFxTable(demoFx, "EUR");
const txns = demoTransactions(NOW);

test("fx: direct, inverse and bridged rates", () => {
  assert.equal(fxEur.USD, 0.8876);                               // USD→EUR stored directly
  assert.ok(Math.abs(fxUsd.EUR - 1 / 0.8876) < 1e-12);           // inverted
  assert.ok(Math.abs(fxEur.GBP - 0.8876 / 0.7408) < 1e-12);      // GBP→USD→EUR bridged
  assert.throws(() => convert(1, "JPY", fxUsd));
});

test("net worth keeps currencies isolated and subtracts liabilities", () => {
  const acc: Account[] = [
    { ...demoAccounts[0], currency: "USD", current_balance: 1000 },
    { ...demoAccounts[2], currency: "EUR", current_balance: 100 },
    { ...demoAccounts[3], currency: "USD", current_balance: 300 },
  ];
  const nw = computeNetWorth(acc, fxUsd);
  assert.equal(nw.byCurrency.EUR.assets, 100);
  assert.equal(nw.byCurrency.USD.assets, 1000);
  assert.ok(Math.abs(nw.total - (1000 + 100 / 0.8876 - 300)) < 1e-9);
  const missing = computeNetWorth([{ ...acc[0], currency: "GBP" }], { USD: 1 });
  assert.deepEqual(missing.missingFx, ["GBP"]);
  assert.equal(missing.total, 0);
});

test("net worth history ends at today's value", () => {
  const h = netWorthHistory(demoAccounts, txns, fxUsd, 90, NOW);
  assert.equal(h.length, 90);
  assert.ok(Math.abs(h.at(-1)!.value - computeNetWorth(demoAccounts, fxUsd).total) < 1e-6);
});

test("recurring detection finds payroll, rent and subscriptions", () => {
  const s = detectRecurring(txns, "2026-11-04");
  const names = s.map((x) => x.merchant);
  for (const n of ["Northwind Labs", "Greystar", "Netflix", "Spotify", "Verizon", "Studio Nord GmbH"]) assert.ok(names.includes(n), n);
  assert.equal(s.find((x) => x.merchant === "Northwind Labs")!.cadenceDays, 14);
  assert.equal(s.find((x) => x.merchant === "Verizon")!.cadenceDays, 30);
  assert.equal(s.find((x) => x.merchant === "Studio Nord GmbH")!.currency, "EUR");
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
  const t: Transaction[] = [{ ...txns[0], date: "2026-11-02", amount: 100, category: "Dining", iso_currency_code: "USD" }];
  const p = budgetPacing([{ id: "b", category: "Dining", monthly_limit: 300, currency: "USD" }], t, fxUsd, NOW);
  const row = p.rows[0];
  assert.equal(row.spent, 100);
  // day 4 of 30 → progress 3.5/30; used 1/3 → velocity ≈ 2.86
  assert.ok(Math.abs(row.velocity - (1 / 3) / (3.5 / 30)) < 1e-9);
  assert.equal(row.status, "over");
  assert.equal(budgetPacing(demoBudgets, txns, fxUsd, NOW).rows.length, demoBudgets.length);
});

test("forecast produces a 30-day series and a weather call", () => {
  const f = forecastCash(demoAccounts, txns, fxUsd, { now: NOW });
  assert.equal(f.series.length, 31);
  assert.ok(f.events.some((e) => e.kind === "income"));
  assert.ok(f.events.some((e) => e.kind === "liability"));
  assert.ok(["clear", "overcast", "storm"].includes(f.weather));
  assert.ok(f.dailyBurn > 0);
  // a broke account with no income must be a storm
  const broke = forecastCash([{ ...demoAccounts[0], current_balance: 50, available_balance: 50 }], txns.filter((t) => t.amount > 0), fxUsd, { now: NOW });
  assert.equal(broke.weather, "storm");
  assert.ok(broke.shortfallDate);
});

test("cash flow delta excludes transfers", () => {
  const d = cashFlowDelta(txns, fxUsd, NOW);
  assert.ok(d.current.inflow > 0 && d.current.outflow > 0);
});

test("dashboards: each shows only its own accounts, transactions, holdings and budgets", async () => {
  const { scopeLedger, dashboardList, dashboardName, guessDashboard, DEFAULT_DASHBOARDS } = await import("./scope.ts");
  const { demoHoldings } = await import("../demo.ts");
  const budgets = [...demoBudgets, { id: "b-biz", category: "Travel", monthly_limit: 900, currency: "USD" as const, dashboard: "business" }];
  const d = { accounts: demoAccounts, transactions: demoTransactions(), holdings: demoHoldings, budgets };

  const biz = scopeLedger(d, "business");
  assert.deepEqual(biz.accounts.map((a) => a.id).sort(), ["acc-amex", "acc-schwab"]);
  assert.ok(biz.transactions.length > 0 && biz.transactions.every((t) => t.account_id === "acc-amex" || t.account_id === "acc-schwab"));
  assert.ok(biz.holdings.length > 0 && biz.holdings.every((h) => h.account_id === "acc-schwab"));
  assert.deepEqual(biz.budgets.map((b) => b.id), ["b-biz"]);

  const personal = scopeLedger(d, "personal");
  assert.equal(personal.accounts.length + biz.accounts.length, demoAccounts.length, "every account is on exactly one dashboard");
  assert.equal(personal.budgets.length, demoBudgets.length, "budgets without a dashboard are Personal");
  assert.ok(!personal.transactions.some((t) => t.account_id === "acc-amex"));

  // unassigned accounts are Personal; ids on accounts but missing from the saved list still get a tab
  const loose = [{ ...demoAccounts[0], owner_label: null }, { ...demoAccounts[1], owner_label: "d-x" }];
  assert.equal(scopeLedger({ ...d, accounts: loose }, "personal").accounts.length, 1);
  assert.deepEqual(dashboardList(null, loose).map((x) => x.id), ["personal", "business", "d-x"]);
  // renaming only changes the name, never the id the data hangs off
  const renamed = DEFAULT_DASHBOARDS.map((x) => (x.id === "business" ? { ...x, name: "Acme Bakery" } : x));
  assert.equal(dashboardName(renamed, "business"), "Acme Bakery");
  assert.equal(scopeLedger(d, "business").accounts.length, 2);

  assert.equal(guessDashboard({ name: "BUS COMPLETE CHK" }), "business");
  assert.equal(guessDashboard({ name: "TOTAL CHECKING" }), "personal");
  assert.equal(guessDashboard({ name: "Ultimate Rewards", holder_category: "business" }), "business");
});

test("transfers: a card payment counts once as neither spending nor income, both legs excluded", async () => {
  const { markTransfers } = await import("./transfers.ts");
  const fx = buildFxTable(demoFx, "USD");
  const base = { iso_currency_code: "USD", subcategory: null, cleaned_merchant_name: null, ai_confidence_score: null, ai_tags: [], is_anomaly: false, is_pending: false, created_at: "2026-10-01T00:00:00Z" };
  const txns = [
    // bank leg: mislabelled by the LLM as a bill; card leg: still queued (null)
    { ...base, id: "out", account_id: "acc-chase-chk", amount: 500, date: "2026-10-03", raw_merchant_string: "AMEX EPAYMENT ACH PMT", category: "Utilities" },
    { ...base, id: "in", account_id: "acc-amex", amount: -500, date: "2026-10-05", raw_merchant_string: "ONLINE PAYMENT", category: null },
    // card leg whose paying account isn't linked: caught by wording
    { ...base, id: "solo", account_id: "acc-chase-cc", amount: -120, date: "2026-10-06", raw_merchant_string: "PAYMENT THANK YOU", category: "Income" },
    // chequing → savings, one leg recognisable
    { ...base, id: "s-out", account_id: "acc-chase-chk", amount: 300, date: "2026-10-07", raw_merchant_string: "ONLINE TRANSFER TO SAV ...4821", category: null },
    { ...base, id: "s-in", account_id: "acc-chase-sav", amount: -300, date: "2026-10-07", raw_merchant_string: "ONLINE TRANSFER FROM CHK ...1180", category: null },
    // NOT a transfer: paycheque and an equal card purchase on different accounts
    { ...base, id: "pay", account_id: "acc-chase-chk", amount: -900, date: "2026-10-08", raw_merchant_string: "NORTHWIND LABS PAYROLL", category: "Income" },
    { ...base, id: "buy", account_id: "acc-amex", amount: 900, date: "2026-10-08", raw_merchant_string: "APPLE STORE", category: "Shopping" },
  ] as Parameters<typeof cashFlow>[0];
  const marked = markTransfers({ accounts: demoAccounts, transactions: txns }).transactions;
  const cat = Object.fromEntries(marked.map((t) => [t.id, t.category]));
  assert.deepEqual(cat, { out: "Transfer", in: "Transfer", solo: "Transfer", "s-out": "Transfer", "s-in": "Transfer", pay: "Income", buy: "Shopping" });
  assert.equal(marked.find((t) => t.id === "in")!.subcategory, "Credit card payment");
  const cf = cashFlow(marked, fx, "2026-10-01", "2026-10-31");
  assert.equal(cf.outflow, 900);
  assert.equal(cf.inflow, 900);
  assert.deepEqual(spendByCategory(marked, fx, "2026-10-01", "2026-10-31"), [{ category: "Shopping", amount: 900 }]);
  assert.equal(txns[0].category, "Utilities", "input is not mutated");
});

test("merchant cache key: strips store numbers, hashes and prefixes; splits in/out", async () => {
  const { merchantKey, cacheKey } = await import("../ai/merchant.ts");
  assert.equal(merchantKey("SQ *BLUE BOTTLE COFFEE 4821"), "BLUE BOTTLE COFFEE");
  assert.equal(merchantKey("SQ *BLUE BOTTLE COFFEE 9902"), merchantKey("SQ *BLUE BOTTLE COFFEE 4821"));
  assert.equal(merchantKey("AMZN Mktp US*7Q1M02 AMZN.COM/BILL"), merchantKey("AMZN Mktp US*2K9XZ1 AMZN.COM/BILL"));
  assert.equal(merchantKey("TRADER JOE'S #552 BROOKLYN NY"), "TRADER JOES BROOKLYN NY");
  assert.equal(merchantKey("TST* LUCALI 00012 BROOKLYN"), "LUCALI BROOKLYN");
  assert.equal(merchantKey("Café Einstein"), "CAFE EINSTEIN");
  assert.equal(merchantKey("12345 678"), "", "nothing stable left → no key");
  assert.notEqual(cacheKey("u1", "AMAZON", 20), cacheKey("u1", "AMAZON", -20), "refund ≠ purchase");
  assert.notEqual(cacheKey("u1", "AMAZON", 20), cacheKey("u2", "AMAZON", 20), "per user");
});

test("categorizeWithLLM: short ids map back to rows; missing items omitted or rule-filled", async () => {
  const { categorizeWithLLM } = await import("../ai/categorize.ts");
  const real = globalThis.fetch;
  let sent: { model: string; prompt: string } | null = null;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    sent = JSON.parse(init!.body!);
    const response = JSON.stringify({ results: [{ id: "2", merchant: "Netflix", category: "Subscriptions", subcategory: "Streaming", confidence: 0.97, tags: ["subscription"] }] });
    return new Response(JSON.stringify({ response }));
  }) as typeof fetch;
  try {
    const items = [
      { id: "uuid-a", raw: "MYSTERY 001", amount: 5, currency: "USD" },
      { id: "uuid-b", raw: "NETFLIX.COM 866-579", amount: 17.99, currency: "USD" },
    ];
    const omit = await categorizeWithLLM(items, { model: "qwen2.5:1.5b", missing: "omit" });
    assert.deepEqual(omit.map((r) => [r.id, r.category, r.source]), [["uuid-b", "Subscriptions", "llm"]]);
    assert.equal(sent!.model, "qwen2.5:1.5b");
    assert.deepEqual(JSON.parse(sent!.prompt).map((p: { id: string }) => p.id), ["1", "2"], "UUIDs never reach the prompt");
    assert.ok(!("think" in sent!), "no think flag for non-reasoning models");
    const filled = await categorizeWithLLM(items, { model: "qwen2.5:1.5b" });
    assert.deepEqual(filled.map((r) => r.source), ["rules", "llm"]);
  } finally { globalThis.fetch = real; }
});
