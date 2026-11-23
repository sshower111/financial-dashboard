/**
 * Eval harness for copilot tool selection. Runs each case through the real agent loop (`runAgent`)
 * against the demo ledger, records what the model called, and scores it:
 *
 *   tool selection   the called tools match an acceptable plan (all required, nothing outside it)
 *   argument validity  each call's arguments pass `validateArgs` (the same check production uses)
 *   argument constraints  the expected arguments (period, category, merchant, dates) are right
 *   rounds, latency, tokens, failures (model errors, timeouts, empty answers)
 *
 * The model is injected (`ChatFn`): `scripts/eval-copilot.ts` passes a real provider, and tests and
 * `--fake` pass `oracleChat`, a scripted model that follows the first plan of every case.
 */
import { agentMessages, runAgent, type ChatFn } from "../agent.ts";
import type { ChatChunk, ChatMessage } from "../ollama.ts";
import { TOOL_NAMES, resolvePeriod, validateArgs, type ToolContext } from "../tools.ts";
import type { Ledger } from "../context.ts";
import { demoAccounts, demoBudgets, demoFx, demoHoldings, demoTransactions } from "../../demo.ts";
import { buildFxTable } from "../../finance/fx.ts";
import { CASES, EVAL_NOW, type ArgRule, type EvalCase, type ExpectCall, type Plan } from "./cases.ts";

export function evalLedger(now = EVAL_NOW): Ledger {
  return { accounts: demoAccounts, transactions: demoTransactions(now), holdings: demoHoldings, budgets: demoBudgets, fx: buildFxTable(demoFx, "USD"), base: "USD" };
}

export interface CallRecord { round: number; name: string; args: unknown; valid: boolean; ok: boolean; error?: string }
export interface CaseResult {
  id: string;
  question: string;
  tags: string[];
  pass: boolean;
  selection: { pass: boolean; called: string[]; missing: string[]; extra: string[]; plan: number | null };
  args: { valid: number; total: number; constraints: boolean | null; problems: string[] };
  modelCalls: number;
  toolRounds: number;
  hitMaxRounds: boolean;
  latencyMs: number;
  firstTokenMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error?: string;
  answer: string;
  calls: CallRecord[];
}

const plans = (c: EvalCase): Plan[] => (Array.isArray(c.expect) ? c.expect : [c.expect]);
const isAbsent = (v: unknown) => v === undefined;

function ruleOk(rule: ArgRule, v: unknown): boolean {
  if ("absent" in rule) return isAbsent(v);
  if ("equals" in rule) return typeof v === "string" && typeof rule.equals === "string" ? v.toLowerCase() === rule.equals.toLowerCase() : v === rule.equals;
  if ("oneOf" in rule) return rule.oneOf.some((o) => (o === null ? isAbsent(v) : typeof v === "string" && typeof o === "string" ? v.toLowerCase() === o.toLowerCase() : v === o));
  return typeof v === "string" && v.toLowerCase().includes(rule.includes.toLowerCase());
}

/** Does one (validated) call satisfy an expected call's argument constraints? */
export function callSatisfies(exp: ExpectCall, args: Record<string, unknown>, now = EVAL_NOW): boolean {
  for (const [k, rule] of Object.entries(exp.args ?? {})) if (!ruleOk(rule, args[k])) return false;
  if (exp.range) {
    if (args.period !== undefined) return args.period === exp.range;
    const want = resolvePeriod(exp.range, now);
    return args.from === want.from && args.to === want.to;
  }
  return true;
}

/** Score the calls one case made. Pure, so the scorer itself is unit-tested. */
export function scoreCalls(c: EvalCase, calls: { name: string; args: unknown }[], now = EVAL_NOW): Pick<CaseResult, "selection" | "args"> {
  const called = [...new Set(calls.map((x) => x.name))];
  const validated = calls.map((x) => ({ name: x.name, v: validateArgs(x.name, x.args) }));
  const valid = validated.filter((x) => x.v.ok).length;
  let best: { idx: number; missing: string[]; extra: string[]; constraints: boolean | null; problems: string[] } | null = null;
  for (const [idx, plan] of plans(c).entries()) {
    const required = [...new Set(plan.calls.map((e) => e.tool))];
    const allowed = new Set([...required, ...(plan.optional ?? [])]);
    const missing = required.filter((t) => !called.includes(t));
    const extra = called.filter((t) => !allowed.has(t));
    const problems: string[] = [];
    const constrained = plan.calls.filter((e) => e.args || e.range);
    for (const e of constrained) {
      const hit = validated.some((x) => x.name === e.tool && x.v.ok && callSatisfies(e, x.v.args, now));
      if (!hit) problems.push(`${e.tool}: expected ${JSON.stringify({ ...(e.range ? { range: e.range } : {}), ...(e.args ?? {}) })}`);
    }
    const constraints = constrained.length ? problems.length === 0 : null;
    const score = (missing.length + extra.length) * 10 + problems.length;
    const bestScore = best ? (best.missing.length + best.extra.length) * 10 + best.problems.length : Infinity;
    if (score < bestScore) best = { idx, missing, extra, constraints, problems };
  }
  const b = best!;
  const selectionPass = b.missing.length === 0 && b.extra.length === 0;
  return {
    selection: { pass: selectionPass, called, missing: b.missing, extra: b.extra, plan: selectionPass ? b.idx : null },
    args: { valid, total: calls.length, constraints: b.constraints, problems: b.problems },
  };
}

export interface RunOptions {
  chat: ChatFn;
  cases?: EvalCase[];
  now?: Date;
  /** per case; the model call is aborted after this */
  timeoutMs?: number;
  onCase?: (r: CaseResult, i: number, n: number) => void;
}

/** Runs every case sequentially (one model at a time, like the app) and returns per-case results. */
export async function runCases(o: RunOptions): Promise<CaseResult[]> {
  const cases = o.cases ?? CASES;
  const now = o.now ?? EVAL_NOW;
  const ctx: ToolContext = { ledger: evalLedger(now), now };
  const out: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const calls: CallRecord[] = [];
    let modelCalls = 0, toolRounds = 0, hitMaxRounds = false, firstTokenMs: number | null = null;
    let promptTokens: number | null = null, completionTokens: number | null = null;
    let answer = "", error: string | undefined;
    const t0 = performance.now();
    const signal = o.timeoutMs ? AbortSignal.timeout(o.timeoutMs) : undefined;
    try {
      for await (const ev of runAgent({
        chat: o.chat, ctx, signal,
        messages: agentMessages({ question: c.question, history: c.history, now, base: "USD", dashboard: "Personal" }),
        observer: {
          modelCall: (m) => {
            modelCalls++;
            if (m.toolCalls.length) toolRounds++;
            if (m.final) hitMaxRounds = true;
            if (firstTokenMs === null && m.firstTokenMs !== null) firstTokenMs = performance.now() - t0 - m.ms + m.firstTokenMs;
            if (m.usage?.promptTokens !== undefined) promptTokens = (promptTokens ?? 0) + m.usage.promptTokens;
            if (m.usage?.completionTokens !== undefined) completionTokens = (completionTokens ?? 0) + m.usage.completionTokens;
          },
          toolCall: (t) => calls.push({ round: t.round, name: t.name, args: t.args, valid: validateArgs(t.name, t.args).ok, ok: t.ok, ...(t.errorCode ? { error: t.errorCode } : {}) }),
        },
      })) {
        if (ev.type === "token") answer += ev.text;
        else if (ev.type === "reset") answer = "";
      }
    } catch (e) {
      error = signal?.aborted ? `timeout after ${o.timeoutMs} ms` : e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
    const scored = scoreCalls(c, calls, now);
    const r: CaseResult = {
      id: c.id, question: c.question, tags: c.tags,
      // an invalid call the model then corrected still passes; argValidity reports it
      pass: !error && scored.selection.pass && scored.args.constraints !== false,
      ...scored, modelCalls, toolRounds, hitMaxRounds,
      latencyMs: Math.round(performance.now() - t0), firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      promptTokens, completionTokens, ...(error ? { error } : {}), answer: answer.trim().slice(0, 500), calls,
    };
    out.push(r);
    o.onCase?.(r, i, cases.length);
  }
  return out;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const quantile = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

export function summarize(results: CaseResult[]) {
  const constrained = results.filter((r) => r.args.constraints !== null);
  const totalCalls = results.reduce((a, r) => a + r.args.total, 0);
  const lat = results.map((r) => r.latencyMs);
  const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
  return {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    passRate: pct(results.filter((r) => r.pass).length, results.length),
    toolSelectionAccuracy: pct(results.filter((r) => r.selection.pass).length, results.length),
    argValidity: pct(results.reduce((a, r) => a + r.args.valid, 0), totalCalls),
    argConstraintAccuracy: pct(constrained.filter((r) => r.args.constraints).length, constrained.length),
    toolCalls: totalCalls,
    meanToolRounds: results.length ? Math.round((results.reduce((a, r) => a + r.toolRounds, 0) / results.length) * 100) / 100 : null,
    hitMaxRounds: results.filter((r) => r.hitMaxRounds).length,
    failures: results.filter((r) => r.error).length,
    latencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: lat.length ? Math.max(...lat) : null },
    tokens: {
      prompt: results.some((r) => r.promptTokens !== null) ? results.reduce((a, r) => a + (r.promptTokens ?? 0), 0) : null,
      completion: results.some((r) => r.completionTokens !== null) ? results.reduce((a, r) => a + (r.completionTokens ?? 0), 0) : null,
    },
    byTag: Object.fromEntries(tags.map((t) => { const rs = results.filter((r) => r.tags.includes(t)); return [t, { cases: rs.length, toolSelection: pct(rs.filter((r) => r.selection.pass).length, rs.length) }]; })),
  };
}
export type Summary = ReturnType<typeof summarize>;

export interface ReportMeta { mode: "real" | "fake"; provider: string; model: string; host: string; startedAt: string; durationMs: number; evalDate: string; warmupMs?: number | null; note?: string }

export function renderMarkdown(meta: ReportMeta, s: Summary, results: CaseResult[]): string {
  const f = (v: number | null, unit = "") => (v === null ? "n/a" : `${v}${unit}`);
  const esc = (x: string) => x.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# Copilot tool-selection eval: ${meta.model}`,
    "",
    `${meta.mode === "fake" ? "**FAKE MODEL RUN (harness self-test, not a model result).** " : ""}Provider \`${meta.provider}\` (${meta.host}), run ${meta.startedAt}, ${Math.round(meta.durationMs / 1000)} s total${meta.warmupMs != null ? `, warm-up ${Math.round(meta.warmupMs)} ms (not counted)` : ""}. Demo ledger as of ${meta.evalDate}.${meta.note ? ` ${meta.note}` : ""}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Cases passed | ${s.passed} / ${s.cases} (${f(s.passRate, "%")}) |`,
    `| Tool-selection accuracy | ${f(s.toolSelectionAccuracy, "%")} |`,
    `| Argument validity (calls passing schema validation) | ${f(s.argValidity, "%")} of ${s.toolCalls} calls |`,
    `| Argument constraints met (cases with constraints) | ${f(s.argConstraintAccuracy, "%")} |`,
    `| Mean tool rounds per case | ${f(s.meanToolRounds)} |`,
    `| Cases that hit the round cap | ${s.hitMaxRounds} |`,
    `| Failures (errors / timeouts) | ${s.failures} |`,
    `| Latency p50 / p95 / max | ${f(s.latencyMs.p50, " ms")} / ${f(s.latencyMs.p95, " ms")} / ${f(s.latencyMs.max, " ms")} |`,
    `| Tokens prompt / completion | ${f(s.tokens.prompt)} / ${f(s.tokens.completion)} |`,
    "",
    "## By tag",
    "",
    "| Tag | Cases | Tool selection |",
    "|---|---|---|",
    ...Object.entries(s.byTag).map(([t, v]) => `| ${t} | ${v.cases} | ${f(v.toolSelection, "%")} |`),
    "",
    "## Cases",
    "",
    "| | Case | Called | Args valid | Constraints | Rounds | Latency |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.pass ? "pass" : "**FAIL**"} | ${r.id} | ${r.selection.called.join(", ") || "(none)"} | ${r.args.valid}/${r.args.total} | ${r.args.constraints === null ? "n/a" : r.args.constraints ? "ok" : "no"} | ${r.toolRounds} | ${r.latencyMs} ms |`),
  ];
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    lines.push("", "## Failures", "");
    for (const r of failed) {
      const why = [
        r.error && `error: ${r.error}`,
        r.selection.missing.length && `missing: ${r.selection.missing.join(", ")}`,
        r.selection.extra.length && `unexpected: ${r.selection.extra.join(", ")}`,
        r.args.valid < r.args.total && `${r.args.total - r.args.valid} call(s) with invalid arguments`,
        ...r.args.problems,
      ].filter(Boolean);
      lines.push(`- **${r.id}** ("${esc(r.question)}"): ${esc(why.join("; "))}`);
      for (const c of r.calls) lines.push(`  - round ${c.round}: \`${c.name}\` ${esc(JSON.stringify(c.args ?? {}))}${c.valid ? "" : " (invalid)"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ── fake model ───────────────────────────────────────────────────────────────────────────────────

/** Arguments that satisfy an expected call (what a perfect model would send). */
export function oracleArgs(e: ExpectCall): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (e.range) a.period = e.range;
  for (const [k, rule] of Object.entries(e.args ?? {})) {
    if ("equals" in rule) a[k] = rule.equals;
    else if ("includes" in rule) a[k] = rule.includes;
    else if ("oneOf" in rule) { const v = rule.oneOf.find((x) => x !== null); if (v !== undefined) a[k] = v; }
  }
  return a;
}

/**
 * A scripted model that answers every eval case perfectly: it recognises the case by its question,
 * calls the first plan's tools in one round, then answers. `--fake` runs and tests use it to check
 * the harness end to end; its report is a self-test, never a model result.
 */
export function oracleChat(cases: EvalCase[] = CASES): ChatFn {
  const byQuestion = new Map(cases.map((c) => [c.question, c]));
  return async function* ({ messages }): AsyncGenerator<ChatChunk> {
    const question = [...messages].reverse().find((m: ChatMessage) => m.role === "user" && !/^You have used all your tool calls/.test(m.content))?.content ?? "";
    const c = byQuestion.get(question);
    const toolsDone = messages.some((m) => m.role === "tool");
    const plan = c ? plans(c)[0] : { calls: [] };
    if (!toolsDone && plan.calls.length) {
      yield { tool_calls: plan.calls.map((e) => ({ function: { name: e.tool, arguments: oracleArgs(e) } })) };
      yield { usage: { promptTokens: 0, completionTokens: 0 } };
      return;
    }
    yield { content: `Fake answer for ${c?.id ?? "unknown case"}.` };
  };
}

export { CASES, EVAL_NOW, TOOL_NAMES };
