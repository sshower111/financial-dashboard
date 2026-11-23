/**
 * The eval harness itself: case-set sanity, the scorer (it must catch wrong tools, missing tools,
 * invalid and wrong arguments), and a full `--fake` style run with the scripted oracle model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES, EVAL_NOW, callSatisfies, oracleArgs, oracleChat, renderMarkdown, runCases, scoreCalls, summarize } from "./harness.ts";
import type { EvalCase } from "./cases.ts";
import { TOOL_NAMES, resolvePeriod, validateArgs } from "../tools.ts";
import type { ChatFn } from "../agent.ts";

const byId = (id: string) => CASES.find((c) => c.id === id)!;
const plansOf = (c: EvalCase) => (Array.isArray(c.expect) ? c.expect : [c.expect]);

test("eval set: about 25 unique cases, real tool names, oracle arguments pass validation and constraints", () => {
  assert.ok(CASES.length >= 24 && CASES.length <= 30, `${CASES.length} cases`);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  assert.equal(new Set(CASES.map((c) => c.question)).size, CASES.length, "the oracle finds cases by question");
  for (const c of CASES) for (const p of plansOf(c)) {
    for (const t of [...p.calls.map((e) => e.tool), ...(p.optional ?? [])]) assert.ok(TOOL_NAMES.includes(t), `${c.id}: ${t}`);
    for (const e of p.calls) {
      const v = validateArgs(e.tool, oracleArgs(e));
      assert.ok(v.ok, `${c.id}: ${e.tool} ${v.ok ? "" : v.message}`);
      assert.ok(callSatisfies(e, v.args), `${c.id}: oracle args satisfy ${e.tool}`);
    }
  }
  // every tool is exercised, and the set includes multi-tool, memory and no-tool cases
  const used = new Set(CASES.flatMap((c) => plansOf(c).flatMap((p) => p.calls.map((e) => e.tool))));
  for (const t of TOOL_NAMES) assert.ok(used.has(t), t);
  for (const tag of ["multi-tool", "memory", "no-tools"]) assert.ok(CASES.some((c) => c.tags.includes(tag)), tag);
});

test("scorer: right plan passes; missing, extra and unknown tools fail selection", () => {
  const afford = byId("afford-1200");
  assert.equal(scoreCalls(afford, [{ name: "get_cash_forecast", args: {} }, { name: "get_budget_pacing", args: {} }]).selection.pass, true);
  const missing = scoreCalls(afford, [{ name: "get_cash_forecast", args: {} }]);
  assert.deepEqual([missing.selection.pass, missing.selection.missing], [false, ["get_budget_pacing"]]);
  const extra = scoreCalls(byId("net-worth"), [{ name: "get_financial_overview", args: {} }, { name: "get_anomalies", args: {} }]);
  assert.deepEqual(extra.selection.extra, ["get_anomalies"]);
  const made_up = scoreCalls(byId("net-worth"), [{ name: "get_net_worth", args: {} }]);
  assert.equal(made_up.selection.pass, false);
  assert.equal(made_up.args.valid, 0);
  // optional tools are allowed; no-tool questions fail if a non-optional tool is called
  assert.equal(scoreCalls(byId("afford-1200"), [{ name: "get_cash_forecast", args: {} }, { name: "get_budget_pacing", args: {} }, { name: "get_recurring_streams", args: {} }]).selection.pass, true);
  assert.equal(scoreCalls(byId("greeting"), []).selection.pass, true);
  assert.equal(scoreCalls(byId("greeting"), [{ name: "get_financial_overview", args: {} }]).selection.pass, false);
  assert.equal(scoreCalls(byId("stock-tip"), [{ name: "get_financial_overview", args: {} }]).selection.pass, true);
});

test("scorer: argument constraints, named period or equivalent dates, alternative plans", () => {
  const c = byId("top-category-last-month");
  const lm = resolvePeriod("last_month", EVAL_NOW);
  assert.equal(scoreCalls(c, [{ name: "get_spending_by_category", args: { period: "last_month" } }]).args.constraints, true);
  assert.equal(scoreCalls(c, [{ name: "get_spending_by_category", args: { from: lm.from, to: lm.to } }]).args.constraints, true);
  assert.equal(scoreCalls(c, [{ name: "get_spending_by_category", args: { period: "this_month" } }]).args.constraints, false);
  assert.equal(scoreCalls(c, [{ name: "get_spending_by_category", args: {} }]).args.constraints, false); // defaults to 30 days, not last month
  // casing is normalised by validateArgs first
  assert.equal(scoreCalls(byId("followup-category"), [{ name: "get_budget_pacing", args: { category: "dining" } }]).args.constraints, true);
  assert.equal(scoreCalls(byId("over-budget"), [{ name: "get_budget_pacing", args: { category: "Dining" } }]).args.constraints, false); // absent expected
  // invalid arguments are counted and can't satisfy a constraint
  const bad = scoreCalls(byId("netflix-dates"), [{ name: "search_transactions", args: { merchant: "Netflix", from: "08/01/2026", to: "2026-10-31" } }]);
  assert.deepEqual([bad.args.valid, bad.args.total, bad.args.constraints], [0, 1, false]);
  // "fees" accepts either get_anomalies or a Fees search
  const alt = scoreCalls(byId("fees"), [{ name: "search_transactions", args: { category: "Fees" } }]);
  assert.deepEqual([alt.selection.pass, alt.selection.plan, alt.args.constraints], [true, 1, true]);
  // two calls to one tool with different periods
  const cmp = byId("compare-months");
  assert.equal(scoreCalls(cmp, [{ name: "get_spending_by_category", args: { period: "this_month" } }]).args.constraints, false);
  assert.equal(scoreCalls(cmp, [{ name: "get_spending_by_category", args: { period: "this_month" } }, { name: "get_spending_by_category", args: { period: "last_month" } }]).args.constraints, true);
});

test("fake run: the oracle model passes every case through the real agent loop", async () => {
  const results = await runCases({ chat: oracleChat() });
  const s = summarize(results);
  assert.equal(s.cases, CASES.length);
  assert.deepEqual(results.filter((r) => !r.pass).map((r) => r.id), []);
  assert.equal(s.toolSelectionAccuracy, 100);
  assert.equal(s.argValidity, 100);
  assert.equal(s.argConstraintAccuracy, 100);
  assert.equal(s.failures, 0);
  assert.ok(results.find((r) => r.id === "afford-1200")!.selection.called.length === 2);
  assert.equal(results.find((r) => r.id === "greeting")!.toolRounds, 0);
  assert.match(results[0].answer, /Fake answer for net-worth/);
  const md = renderMarkdown({ mode: "fake", provider: "fake", model: "oracle", host: "in-process", startedAt: "2026-11-23T00:00:00Z", durationMs: 10, evalDate: "2026-11-04" }, s, results);
  assert.match(md, /FAKE MODEL RUN/);
  assert.match(md, /Tool-selection accuracy \| 100%/);
  assert.doesNotMatch(md, /## Failures/);
});

test("fake run: a bad model is scored as bad, and errors and timeouts are failures", async () => {
  // always calls the overview tool with junk, then answers
  const sloppy: ChatFn = async function* ({ messages }) {
    if (!messages.some((m) => m.role === "tool")) yield { tool_calls: [{ function: { name: "get_financial_overview", arguments: {} } }, { function: { name: "search_transactions", arguments: { limit: "many" } } }] };
    else yield { content: "Something." };
  };
  const cases = ["net-worth", "afford-1200", "greeting"].map(byId);
  const r = await runCases({ chat: sloppy, cases });
  assert.deepEqual(r.map((x) => x.pass), [false, false, false]);
  assert.deepEqual(r[1].selection.missing.sort(), ["get_budget_pacing", "get_cash_forecast"]);
  const s = summarize(r);
  assert.equal(s.argValidity, 50);
  assert.equal(s.toolSelectionAccuracy, 0);
  assert.match(renderMarkdown({ mode: "real", provider: "x", model: "y", host: "h", startedAt: "t", durationMs: 1, evalDate: "d" }, s, r), /## Failures[\s\S]*afford-1200[\s\S]*missing: /);

  const broken: ChatFn = async function* () { throw new Error("Ollama 404: model not found"); };
  const [e] = await runCases({ chat: broken, cases: [byId("net-worth")] });
  assert.equal(e.pass, false);
  assert.match(e.error!, /model not found/);

  const slow: ChatFn = async function* ({ signal }) {
    await new Promise((res, rej) => { const t = setTimeout(res, 5000); signal?.addEventListener("abort", () => { clearTimeout(t); rej(signal.reason); }); });
    yield { content: "late" };
  };
  const [t] = await runCases({ chat: slow, cases: [byId("net-worth")], timeoutMs: 50 });
  assert.match(t.error!, /timeout after 50 ms/);
  assert.equal(summarize([t]).failures, 1);
});
