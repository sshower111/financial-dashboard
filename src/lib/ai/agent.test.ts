/**
 * Tool-calling copilot: argument validation, the dispatcher against the deterministic demo ledger,
 * and the agent loop driven by a scripted fake model (no network, no Ollama).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_NAMES, TOOL_SCHEMAS, executeTool, resolvePeriod, validateArgs, type ToolContext, type ToolResult } from "./tools.ts";
import { MAX_CALLS_PER_ROUND, MAX_ROUNDS, agentMessages, answerStream, runAgent, type AgentEvent, type ChatFn } from "./agent.ts";
import { WIRE_FALLBACK, WIRE_RESET, parseWire, toolLabel, wireTool } from "./wire.ts";
import type { ChatChunk, ChatMessage } from "./ollama.ts";
import { demoAccounts, demoBudgets, demoFx, demoHoldings, demoTransactions } from "../demo.ts";
import { buildFxTable, convert } from "../finance/fx.ts";
import { cashFlow, cashFlowDelta, spendByCategory } from "../finance/cashflow.ts";
import { forecastCash } from "../finance/forecast.ts";
import { budgetPacing } from "../finance/pacing.ts";
import { detectRecurring } from "../finance/recurring.ts";
import { detectAnomalies } from "../finance/anomaly.ts";
import { computeNetWorth } from "../finance/networth.ts";
import { CATEGORIES } from "../types.ts";

const NOW = new Date("2026-11-04T15:00:00");
const fx = buildFxTable(demoFx, "USD");
const txns = demoTransactions(NOW);
const ctx: ToolContext = { ledger: { accounts: demoAccounts, transactions: txns, holdings: demoHoldings, budgets: demoBudgets, fx, base: "USD" }, now: NOW };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** run a tool that must succeed and return its result */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = Record<string, any>;
function ok<T = Res>(name: string, args: unknown = {}): T {
  const r = executeTool(name, args, ctx);
  assert.ok(r.ok, r.ok ? "" : `${name}: ${r.error.message}`);
  return (r as Extract<ToolResult, { ok: true }>).result as T;
}
function err(name: string, args: unknown) {
  const r = executeTool(name, args, ctx);
  assert.equal(r.ok, false, `${name} should have failed`);
  return (r as Extract<ToolResult, { ok: false }>).error;
}

// ── schemas ──────────────────────────────────────────────────────────────────────────────────────

test("tool schemas are OpenAI-style function definitions", () => {
  assert.ok(TOOL_SCHEMAS.length >= 4 && TOOL_SCHEMAS.length <= 8);
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, "function");
    assert.match(t.function.name, /^[a-z_]+$/);
    assert.ok(t.function.description.length > 40, t.function.name);
    assert.equal(t.function.parameters.type, "object");
    for (const req of t.function.parameters.required) assert.ok(req in t.function.parameters.properties);
  }
  assert.doesNotThrow(() => JSON.stringify(TOOL_SCHEMAS));
});

// ── argument validation ──────────────────────────────────────────────────────────────────────────

test("validation: types, enums and date formats", () => {
  assert.deepEqual(validateArgs("get_spending_by_category", { period: "last_month" }), { ok: true, args: { period: "last_month" } });
  assert.equal(validateArgs("get_spending_by_category", { period: "last_year" }).ok, false);        // not in the enum
  assert.equal(validateArgs("get_spending_by_category", { period: 7 }).ok, false);                  // wrong type
  assert.equal(validateArgs("get_spending_by_category", { from: "11/01/2026", to: "2026-11-04" }).ok, false); // wrong format
  assert.equal(validateArgs("get_spending_by_category", { from: "2026-02-30", to: "2026-03-01" }).ok, false); // not a real date
  assert.equal(validateArgs("search_transactions", { min_amount: "lots" }).ok, false);
  assert.equal(validateArgs("search_transactions", { min_amount: -5 }).ok, false);
  assert.equal(validateArgs("search_transactions", { limit: 2.5 }).ok, false);                      // integer required
  assert.equal(validateArgs("search_transactions", { limit: 0 }).ok, false);
  assert.equal(validateArgs("search_transactions", { merchant: "x".repeat(81) }).ok, false);
  assert.equal(validateArgs("get_anomalies", { kind: "fraud" }).ok, false);
  assert.equal(validateArgs("get_budget_pacing", { category: "Crypto" }).ok, false);
  const bad = validateArgs("get_anomalies", { kind: "fraud" });
  assert.ok(!bad.ok && /duplicate, price_hike, fee, unusual_amount/.test(bad.message), "the error lists the valid values");
});

test("validation: date ranges must be complete, ordered and not mixed with a period", () => {
  assert.equal(validateArgs("get_spending_by_category", { from: "2026-10-01" }).ok, false);
  assert.equal(validateArgs("get_spending_by_category", { from: "2026-10-31", to: "2026-10-01" }).ok, false);
  assert.equal(validateArgs("search_transactions", { period: "this_month", from: "2026-10-01", to: "2026-10-31" }).ok, false);
  assert.equal(validateArgs("search_transactions", { from: "2026-10-01", to: "2026-10-31" }).ok, true);
});

test("validation is lenient where small models are sloppy, and clamps caps", () => {
  // numeric strings, enum casing, null / "" meaning "not set", unknown keys dropped
  const v = validateArgs("search_transactions", { limit: "5", category: "dining", merchant: null, period: "", sort: "desc" });
  assert.deepEqual(v, { ok: true, args: { limit: 5, category: "Dining" } });
  // arguments as a JSON string (OpenAI style) or missing altogether
  assert.deepEqual(validateArgs("get_anomalies", '{"kind":"fee"}'), { ok: true, args: { kind: "fee" } });
  assert.deepEqual(validateArgs("get_cash_forecast", undefined), { ok: true, args: {} });
  assert.equal(validateArgs("get_anomalies", "{not json").ok, false);
  assert.equal(validateArgs("get_anomalies", ["fee"]).ok, false);
  // caps: asking for 5000 rows gets the maximum, not an error
  assert.deepEqual(validateArgs("search_transactions", { limit: 5000 }), { ok: true, args: { limit: 50 } });
  assert.deepEqual(validateArgs("get_spending_by_category", { limit: 99 }), { ok: true, args: { limit: 20 } });
});

test("named periods resolve to dates on the server", () => {
  assert.deepEqual(resolvePeriod("this_month", NOW), { from: "2026-11-01", to: "2026-11-04" });
  assert.deepEqual(resolvePeriod("last_month", NOW), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(resolvePeriod("last_7_days", NOW), { from: "2026-10-29", to: "2026-11-04" });
  assert.deepEqual(resolvePeriod("last_30_days", NOW), { from: "2026-10-06", to: "2026-11-04" });
  assert.deepEqual(resolvePeriod("last_month", new Date("2026-01-15T12:00:00")), { from: "2025-12-01", to: "2025-12-31" });
});

// ── dispatcher: structured errors ────────────────────────────────────────────────────────────────

test("dispatcher: unknown tools and bad arguments come back as structured errors, never throws", () => {
  const unknown = err("delete_all_transactions", {});
  assert.equal(unknown.code, "unknown_tool");
  assert.deepEqual(unknown.validTools, TOOL_NAMES);
  assert.equal(err("get_spending_by_category", { period: "forever" }).code, "invalid_arguments");
  assert.equal(err("search_transactions", "]").code, "invalid_arguments");
  for (const junk of [undefined, null, 42, {}]) assert.doesNotThrow(() => executeTool(junk as unknown as string, junk, ctx));
  // a failure inside a tool is reported, not thrown
  const broken = executeTool("get_financial_overview", {}, { ...ctx, ledger: null as never });
  assert.ok(!broken.ok && broken.error.code === "tool_failed");
});

// ── dispatcher: results against the demo ledger ──────────────────────────────────────────────────

test("every tool runs on the demo ledger and returns JSON without NaN or Infinity", () => {
  for (const name of TOOL_NAMES) {
    const json = JSON.stringify(ok(name));
    assert.ok(json.length > 20 && json.length < 20_000, `${name}: ${json.length} chars`);
    assert.doesNotMatch(json, /NaN|Infinity/, name);
  }
});

test("get_financial_overview matches the net worth and cash-flow engine", () => {
  const o = ok("get_financial_overview");
  const nw = computeNetWorth(demoAccounts, fx), cf = cashFlowDelta(txns, fx, NOW);
  assert.equal(o.netWorth.total, r2(nw.total));
  assert.equal(o.netWorth.liabilities, r2(nw.liabilities));
  assert.equal(o.accounts.length, demoAccounts.length);
  assert.equal(o.cashFlow.last30Days.spending, r2(cf.current.outflow));
  assert.equal(o.cashFlow.previous30Days.income, r2(cf.previous.inflow));
  assert.equal(o.cashFlow.netChange, r2(cf.change));
});

test("get_spending_by_category: period and explicit dates give the engine's figures", () => {
  const byPeriod = ok("get_spending_by_category", { period: "last_month" });
  const byDates = ok("get_spending_by_category", { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(byPeriod, byDates);
  const want = spendByCategory(txns, fx, "2026-10-01", "2026-10-31");
  assert.equal(byPeriod.categories[0].category, "Housing"); // rent is the largest line
  assert.deepEqual(byPeriod.categories, want.slice(0, 10).map((c) => ({ category: c.category, amount: r2(c.amount) })));
  assert.equal(byPeriod.totalSpending, r2(cashFlow(txns, fx, "2026-10-01", "2026-10-31").outflow));
  assert.ok(!byPeriod.categories.some((c: { category: string }) => c.category === "Transfer" || c.category === "Income"));
  assert.equal(ok("get_spending_by_category", { period: "last_month", limit: 3 }).categories.length, 3);
  assert.equal(ok("get_spending_by_category").from, "2026-10-06"); // default: trailing 30 days
});

test("get_cash_forecast matches forecastCash", () => {
  const f = ok("get_cash_forecast"), want = forecastCash(demoAccounts, txns, fx, { now: NOW });
  assert.equal(f.weather, want.weather);
  assert.equal(f.liquidCashToday, r2(want.start));
  assert.equal(f.projectedEnd, r2(want.end));
  assert.equal(f.lowestBalance, r2(want.min));
  assert.equal(f.lowestBalanceDate, want.minDate);
  assert.ok(f.upcoming.length > 0 && f.upcoming.length <= 20);
  assert.ok(f.upcoming.some((e: { label: string; kind: string }) => e.label === "Northwind Labs" && e.kind === "income"));
});

test("get_budget_pacing: all budgets, one category, and a category with no budget", () => {
  const all = ok("get_budget_pacing"), want = budgetPacing(demoBudgets, txns, fx, NOW);
  assert.equal(all.budgets.length, demoBudgets.length);
  assert.equal(all.allBudgets.spent, r2(want.total.spent));
  assert.equal(all.dayOfMonth, 4);
  const dining = ok("get_budget_pacing", { category: "Dining" });
  const row = want.rows.find((r) => r.category === "Dining")!;
  assert.deepEqual(dining.budgets, [{ category: "Dining", spent: r2(row.spent), limit: 400, usedShare: r2(row.used), velocity: r2(row.velocity), projectedMonthEnd: r2(row.projected), status: row.status }]);
  const none = ok("get_budget_pacing", { category: "Travel" });
  assert.deepEqual(none.budgets, []);
  assert.match(none.note, /No budget is set for Travel/);
});

test("get_recurring_streams finds payroll and subscriptions, filtered by direction", () => {
  const all = ok("get_recurring_streams");
  assert.equal(all.count, detectRecurring(txns, "2026-11-04").length);
  const names = (r: Res) => (r.streams as { merchant: string }[]).map((s) => s.merchant);
  for (const n of ["Northwind Labs", "Greystar", "Netflix", "Spotify", "Verizon"]) assert.ok(names(all).includes(n), n);
  const income = ok("get_recurring_streams", { direction: "in" });
  assert.ok(names(income).includes("Northwind Labs") && !names(income).includes("Netflix"));
  assert.ok(income.streams.every((s: { direction: string }) => s.direction === "in"));
  assert.equal(income.count + ok("get_recurring_streams", { direction: "out" }).count, all.count);
  assert.equal(all.streams.find((s: { merchant: string }) => s.merchant === "Northwind Labs").everyDays, 14);
});

test("get_anomalies reports the seeded duplicate, price hike and fees", () => {
  const all = ok("get_anomalies");
  assert.equal(all.count, detectAnomalies(txns, { now: NOW }).length);
  const kinds = new Set(all.anomalies.map((a: { kind: string }) => a.kind));
  for (const k of ["duplicate", "price_hike", "fee"]) assert.ok(kinds.has(k), k);
  const hike = ok("get_anomalies", { kind: "price_hike" });
  assert.ok(hike.anomalies.every((a: { kind: string }) => a.kind === "price_hike"));
  assert.ok(hike.anomalies.some((a: { title: string; detail: string }) => /Netflix/.test(a.title) && /15\.49/.test(a.detail) && /17\.99/.test(a.detail)));
  assert.ok(ok("get_anomalies", { kind: "duplicate" }).anomalies.some((a: { title: string }) => /DoorDash/.test(a.title)));
});

test("search_transactions: merchant, category, dates, caps and pre-summed totals", () => {
  const netflix = ok("search_transactions", { merchant: "NETFLIX" });
  const want = txns.filter((t) => t.cleaned_merchant_name === "Netflix");
  assert.equal(netflix.matched, want.length);
  assert.equal(netflix.totals.spent, r2(want.reduce((s, t) => s + t.amount, 0)));
  assert.ok(netflix.rows.every((r: { merchant: string }) => r.merchant === "Netflix"));
  assert.deepEqual(netflix.rows.map((r: { date: string }) => r.date), [...netflix.rows.map((r: { date: string }) => r.date)].sort().reverse()); // newest first

  // capped rows, totals still over every match
  const dining = ok("search_transactions", { category: "Dining", limit: 3 });
  assert.equal(dining.rows.length, 3);
  assert.ok(dining.truncated && dining.matched > 3);
  const diningAll = txns.filter((t) => t.category === "Dining");
  assert.equal(dining.matched, diningAll.length);
  assert.equal(dining.totals.spent, r2(diningAll.reduce((s, t) => s + convert(t.amount, t.iso_currency_code, fx), 0)));
  assert.ok(ok("search_transactions", { limit: 9999 }).rows.length <= 50);

  // EUR rows keep their native amount and carry the converted one
  const eur = ok("search_transactions", { merchant: "studio nord" });
  assert.equal(eur.rows[0].currency, "EUR");
  assert.equal(eur.rows[0].amount, -1350);
  assert.equal(eur.rows[0].amountBase, r2(convert(-1350, "EUR", fx)));
  assert.ok(eur.totals.received > 0 && eur.totals.spent === 0);

  // date range + minimum size
  const big = ok("search_transactions", { period: "last_month", min_amount: 1000 });
  assert.ok(big.matched > 0);
  assert.ok(big.rows.every((r: { date: string; amount: number }) => r.date >= "2026-10-01" && r.date <= "2026-10-31" && Math.abs(r.amount) >= 1000));

  // own-account transfers are hidden unless asked for by category
  assert.equal(ok("search_transactions", { merchant: "amex payment" }).matched, 0);
  assert.ok(ok("search_transactions", { category: "Transfer" }).matched > 0);
  assert.equal(ok("search_transactions", { merchant: "no such merchant" }).matched, 0);
});

test("a currency with no FX rate is excluded and reported, never treated as 1:1", () => {
  const noEur: ToolContext = { ...ctx, ledger: { ...ctx.ledger, fx: { USD: 1 } } };
  const r = executeTool("search_transactions", { merchant: "studio nord" }, noEur);
  assert.ok(r.ok);
  const res = r.result as { matched: number; totals: { received: number; excludedNoFxRate: number }; rows: { amountBase: number | null }[] };
  assert.equal(res.totals.received, 0);
  assert.equal(res.totals.excludedNoFxRate, res.matched);
  assert.equal(res.rows[0].amountBase, null);
});

test("tools only read: the ledger is unchanged after every tool has run", () => {
  const before = JSON.stringify(ctx.ledger);
  for (const name of TOOL_NAMES) ok(name);
  ok("search_transactions", { category: "Dining", limit: 50 });
  assert.equal(JSON.stringify(ctx.ledger), before);
});

// ── the agent loop, with a scripted fake model ───────────────────────────────────────────────────

type Turn = ChatChunk[] | Error;
/** A model that replays `turns` in order and records what it was sent each time. */
function fakeModel(turns: Turn[]) {
  const seen: { messages: ChatMessage[]; tools: boolean }[] = [];
  const chat: ChatFn = async function* ({ messages, tools }) {
    seen.push({ messages: structuredClone(messages), tools: !!tools?.length });
    const turn = turns[Math.min(seen.length - 1, turns.length - 1)];
    if (turn instanceof Error) throw turn;
    yield* turn;
  };
  return { chat, seen };
}
const call = (name: string, args: unknown = {}): ChatChunk => ({ tool_calls: [{ function: { name, arguments: args } }] });
const say = (...parts: string[]): ChatChunk[] => parts.map((content) => ({ content }));
const messages = agentMessages({ question: "Can I afford a $1,200 trip?", now: NOW, base: "USD", dashboard: "Personal" });
async function collect(gen: AsyncIterable<AgentEvent>) { const out: AgentEvent[] = []; for await (const e of gen) out.push(e); return out; }
async function text(gen: AsyncIterable<string>) { let s = ""; for await (const t of gen) s += t; return s; }
const toolResults = (m: ChatMessage[]) => m.filter((x) => x.role === "tool").map((x) => ({ name: x.tool_name, ...(JSON.parse(x.content) as ToolResult) }));

test("agentMessages: system prompt carries the date, base currency, dashboard and history", () => {
  const m = agentMessages({ question: "And last month?", history: [{ role: "user", content: "Dining this month?" }, { role: "assistant", content: "USD 212.40." }, { role: "assistant", content: " " }], now: NOW, base: "CAD", dashboard: "Business" });
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "user"]); // the blank turn is dropped
  assert.match(m[0].content, /Today is Wednesday 2026-11-04/);
  assert.match(m[0].content, /Base currency: CAD/);
  assert.match(m[0].content, /Open dashboard: Business/);
  for (const c of CATEGORIES) assert.ok(m[0].content.includes(c));
  assert.equal(m.at(-1)!.content, "And last month?");
});

test("loop: the model asks for a tool, gets the result, then answers", async () => {
  const model = fakeModel([[call("get_cash_forecast")], say("Yes. ", "Your low point is fine.")]);
  const events = await collect(runAgent({ chat: model.chat, messages, ctx }));
  assert.deepEqual(events, [
    { type: "tool", name: "get_cash_forecast", ok: true },
    { type: "token", text: "Yes. " },
    { type: "token", text: "Your low point is fine." },
  ]);
  assert.equal(model.seen.length, 2);
  assert.ok(model.seen[0].tools, "tools are offered");
  // second request = original messages + the assistant's tool call + the tool result
  const second = model.seen[1].messages;
  assert.deepEqual(second.slice(0, messages.length), messages);
  assert.equal(second[messages.length].role, "assistant");
  assert.equal(second[messages.length].tool_calls![0].function.name, "get_cash_forecast");
  const [result] = toolResults(second);
  assert.equal(result.name, "get_cash_forecast");
  assert.ok(result.ok);
  // the figures the model reads are the engine's, computed on the server
  assert.equal((result.result as { lowestBalance: number }).lowestBalance, r2(forecastCash(demoAccounts, txns, fx, { now: NOW }).min));
  assert.equal(messages.length, 2, "the caller's messages are not mutated");
});

test("loop: several tools in one turn and across turns; a direct answer needs none", async () => {
  const model = fakeModel([
    [{ tool_calls: [{ function: { name: "get_budget_pacing", arguments: { category: "Dining" } } }, { function: { name: "get_spending_by_category", arguments: { period: "this_month" } } }] }],
    [call("search_transactions", { category: "Dining", limit: 5 })],
    say("You are on pace."),
  ]);
  const events = await collect(runAgent({ chat: model.chat, messages, ctx }));
  assert.deepEqual(events.filter((e) => e.type === "tool").map((e) => e.type === "tool" && e.name), ["get_budget_pacing", "get_spending_by_category", "search_transactions"]);
  assert.equal(toolResults(model.seen[2].messages).length, 3);
  assert.ok(toolResults(model.seen[2].messages).every((r) => r.ok));

  const direct = fakeModel([say("Hello! Ask me about your ledger.")]);
  assert.deepEqual(await collect(runAgent({ chat: direct.chat, messages, ctx })), [{ type: "token", text: "Hello! Ask me about your ledger." }]);
  assert.equal(direct.seen.length, 1);
});

test("loop: unknown tools and bad arguments are fed back as errors and the model can recover", async () => {
  const model = fakeModel([
    [call("get_stock_tips", { ticker: "AAPL" })],
    [call("get_spending_by_category", { period: "last_decade" })],
    [call("get_spending_by_category", { period: "last_month" })],
    say("Housing was your largest category."),
  ]);
  const events = await collect(runAgent({ chat: model.chat, messages, ctx }));
  assert.deepEqual(events.filter((e) => e.type === "tool"), [
    { type: "tool", name: "get_stock_tips", ok: false },
    { type: "tool", name: "get_spending_by_category", ok: false },
    { type: "tool", name: "get_spending_by_category", ok: true },
  ]);
  const results = toolResults(model.seen[3].messages);
  assert.ok(!results[0].ok && results[0].error.code === "unknown_tool" && results[0].error.validTools!.includes("get_cash_forecast"));
  assert.ok(!results[1].ok && results[1].error.code === "invalid_arguments" && /last_month/.test(results[1].error.message));
  assert.ok(results[2].ok);
  assert.equal(events.at(-1)!.type, "token");
});

test("loop: malformed tool calls don't crash it", async () => {
  const model = fakeModel([
    [{ tool_calls: [{ function: { name: "search_transactions", arguments: "{\"merchant\": " } }, {} as never, { function: { name: 7 as never, arguments: null } }] }],
    say("Sorry, I could not look that up."),
  ]);
  const events = await collect(runAgent({ chat: model.chat, messages, ctx }));
  assert.equal(events.filter((e) => e.type === "tool" && !e.ok).length, 3);
  assert.deepEqual(toolResults(model.seen[1].messages).map((r) => !r.ok && r.error.code), ["invalid_arguments", "unknown_tool", "unknown_tool"]);
});

test("loop: max-rounds cap, then one final call without tools that must answer", async () => {
  // a model that would call tools forever, until tools are withheld
  const seen: { tools: boolean; last: ChatMessage }[] = [];
  const chat: ChatFn = async function* ({ messages: m, tools }) {
    seen.push({ tools: !!tools?.length, last: m.at(-1)! });
    if (tools?.length) yield call("get_anomalies"); else yield* say("Here is what I found.");
  };
  const events = await collect(runAgent({ chat, messages, ctx }));
  assert.equal(seen.length, MAX_ROUNDS + 1);
  assert.deepEqual(seen.map((s) => s.tools), [...Array(MAX_ROUNDS).fill(true), false]);
  assert.equal(events.filter((e) => e.type === "tool").length, MAX_ROUNDS);
  assert.equal(seen.at(-1)!.last.role, "user");
  assert.match(seen.at(-1)!.last.content, /Answer the user's question now/);
  assert.deepEqual(events.at(-1), { type: "token", text: "Here is what I found." });

  // the cap is configurable, and tool calls sent in the forced-answer turn are ignored
  const stubborn = fakeModel([[call("get_anomalies")], [{ content: "Final." }, call("get_anomalies")]]);
  const capped = await collect(runAgent({ chat: stubborn.chat, messages, ctx, maxRounds: 1 }));
  assert.equal(stubborn.seen.length, 2);
  assert.deepEqual(capped, [{ type: "tool", name: "get_anomalies", ok: true }, { type: "token", text: "Final." }]);
});

test("loop: at most MAX_CALLS_PER_ROUND tools run in one turn", async () => {
  const many = Array.from({ length: MAX_CALLS_PER_ROUND + 2 }, () => ({ function: { name: "get_anomalies", arguments: {} } }));
  const model = fakeModel([[{ tool_calls: many }], say("Done.")]);
  await collect(runAgent({ chat: model.chat, messages, ctx }));
  const results = toolResults(model.seen[1].messages);
  assert.equal(results.length, many.length); // every call gets an answer
  assert.equal(results.filter((r) => r.ok).length, MAX_CALLS_PER_ROUND);
  assert.ok(results.slice(MAX_CALLS_PER_ROUND).every((r) => !r.ok && r.error.code === "too_many_calls"));
});

test("loop: a preamble before a tool call is retracted; an empty answer is an error", async () => {
  const model = fakeModel([[{ content: "Let me check." }, call("get_cash_forecast")], say("All clear.")]);
  assert.deepEqual(await collect(runAgent({ chat: model.chat, messages, ctx })), [
    { type: "token", text: "Let me check." }, { type: "reset" },
    { type: "tool", name: "get_cash_forecast", ok: true },
    { type: "token", text: "All clear." },
  ]);
  await assert.rejects(collect(runAgent({ chat: fakeModel([[call("get_anomalies")], say("  ")]).chat, messages, ctx })), /empty answer/);
});

// ── wire format + fallback ───────────────────────────────────────────────────────────────────────

const snapshot = async function* () { yield "Snapshot "; yield "answer."; };

test("answerStream: tool trace then the answer, readable by the UI parser", async () => {
  const model = fakeModel([[{ content: "Checking." }, call("get_cash_forecast")], [call("get_budget_pacing"), call("nope")], say("You can ", "afford it.")]);
  const wire = await text(answerStream({ chat: model.chat, messages, ctx, snapshot }));
  assert.equal(wire, `Checking.${WIRE_RESET}${wireTool("get_cash_forecast")}${wireTool("get_budget_pacing")}You can afford it.`);
  // unknown tools were never run, so they are not in the trace
  assert.deepEqual(parseWire(wire), { text: "You can afford it.", tools: ["get_cash_forecast", "get_budget_pacing"] });
});

test("fallback: a model without tool support gets the snapshot answer, byte for byte", async () => {
  const reasons: string[] = [];
  const noTools = fakeModel([new Error('Ollama 400: {"error":"registry.ollama.ai/library/gemma:2b does not support tools"}')]);
  const wire = await text(answerStream({ chat: noTools.chat, messages, ctx, snapshot, onFallback: (r) => reasons.push(r) }));
  assert.equal(wire, "Snapshot answer."); // no control lines: identical to the pre-tool-calling response
  assert.match(reasons[0], /does not support tools/);
});

test("fallback: a failure mid-loop discards the partial output and uses the snapshot", async () => {
  const flaky: ChatFn = async function* (req) { // the second turn dies after one token
    if (req.messages.some((m) => m.role === "tool")) { yield { content: "Your low" }; throw new Error("connection reset"); }
    yield call("get_cash_forecast");
  };
  const wire = await text(answerStream({ chat: flaky, messages, ctx, snapshot }));
  assert.equal(wire, `${wireTool("get_cash_forecast")}Your low${WIRE_FALLBACK}Snapshot answer.`);
  assert.deepEqual(parseWire(wire), { text: "Snapshot answer.", tools: [] });
  // an empty model answer also falls back
  const empty = await text(answerStream({ chat: fakeModel([say("")]).chat, messages, ctx, snapshot }));
  assert.equal(empty, "Snapshot answer.");
});

test("fallback: tools can be switched off; snapshot errors still propagate; an abort stays silent", async () => {
  const model = fakeModel([say("never used")]);
  assert.equal(await text(answerStream({ chat: model.chat, messages, ctx, snapshot, tools: false })), "Snapshot answer.");
  assert.equal(model.seen.length, 0);

  // Ollama down: the agent fails, the snapshot fails too, and the route's existing error message takes over
  const down = fakeModel([new Error("fetch failed")]);
  await assert.rejects(text(answerStream({ chat: down.chat, messages, ctx, snapshot: async function* () { throw new Error("fetch failed"); } })), /fetch failed/);

  // the user pressed stop: no fallback answer is generated
  const ac = new AbortController();
  const aborted = (async function* () { yield { content: "Partial" }; ac.abort(); throw new DOMException("aborted", "AbortError"); }) as ChatFn;
  let snapshotRan = false;
  const wire = await text(answerStream({ chat: aborted, messages, ctx, signal: ac.signal, snapshot: async function* () { snapshotRan = true; yield "x"; } }));
  assert.equal(wire, "Partial");
  assert.equal(snapshotRan, false);
});

test("wire parser: plain text passes through; partial control lines stay hidden", () => {
  assert.deepEqual(parseWire("Just text.\nSecond line."), { text: "Just text.\nSecond line.", tools: [] });
  assert.deepEqual(parseWire(""), { text: "", tools: [] });
  const full = `${wireTool("get_cash_forecast")}${wireTool("get_cash_forecast")}${wireTool("search_transactions")}Answer`;
  assert.deepEqual(parseWire(full), { text: "Answer", tools: ["get_cash_forecast", "search_transactions"] }); // de-duplicated
  // every prefix of the stream parses without leaking control characters into the text
  for (let i = 0; i <= full.length; i++) assert.doesNotMatch(parseWire(full.slice(0, i)).text, /\x1e|tool:/);
  assert.equal(wireTool("bad\nname\x1e!"), "\x1etool:badname\n");
  assert.equal(toolLabel("get_cash_forecast"), "cash forecast");
  assert.equal(toolLabel("search_transactions"), "search transactions");
});
