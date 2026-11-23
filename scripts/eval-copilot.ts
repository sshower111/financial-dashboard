/**
 * Copilot tool-selection eval (see src/lib/ai/eval/). Runs ~25 questions through the real agent loop
 * over the deterministic demo ledger (no real account data) and prints a scorecard.
 *
 *   npm run eval:copilot                           real model from .env.local / env (default: Ollama, OLLAMA_MODEL)
 *   npm run eval:copilot -- --model qwen3.5:9b     override the model (Ollama tag, or hosted model / deployment)
 *   npm run eval:copilot -- --base-url http://localhost:11434
 *   npm run eval:copilot -- --provider openai-compatible   (needs COPILOT_BASE_URL, COPILOT_API_KEY, COPILOT_MODEL)
 *   npm run eval:copilot -- --only afford-1200,compare-months
 *   npm run eval:copilot -- --fake                 scripted model: tests the harness, writes to the temp dir
 *
 * Options: --out <dir> (default docs/evals for real runs, <temp>/copilot-eval for --fake),
 * --timeout <ms per case> (default 180000), --min-pass <0-100> (exit 1 below this pass rate),
 * --no-warmup (skip the untimed first call that loads the model).
 *
 * Real runs write docs/evals/copilot-<model>-<date>.json and .md. Commit those: they are the
 * measured results. --fake output is a harness self-test and must not be committed as a result.
 */
import { loadEnvFile } from "node:process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
for (const f of [".env.local", ".env"]) if (existsSync(f)) loadEnvFile(f); // before the imports that read env

const { values } = parseArgs({
  options: {
    fake: { type: "boolean", default: false },
    model: { type: "string" },
    "base-url": { type: "string" },
    provider: { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    timeout: { type: "string", default: "180000" },
    "min-pass": { type: "string" },
    "no-warmup": { type: "boolean", default: false },
  },
});

const { CASES, EVAL_NOW, oracleChat, renderMarkdown, runCases, summarize } = await import("../src/lib/ai/eval/harness.ts");
const { getProvider } = await import("../src/lib/ai/provider.ts");
const { todayKey } = await import("../src/lib/finance/dates.ts");

const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean);
const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
if (!cases.length) { console.error(`No cases match --only ${values.only}. Ids: ${CASES.map((c) => c.id).join(", ")}`); process.exit(2); }

const fake = values.fake;
let chat, provider = "fake", model = "oracle", host = "in-process";
if (fake) chat = oracleChat(CASES);
else {
  // eval-time temperature: low, so repeated runs are comparable
  const p = getProvider(process.env, { provider: values.provider, model: values.model, baseUrl: values["base-url"], temperature: 0 });
  ({ chat } = p); provider = p.name; model = p.model; host = p.host;
}

console.log(`Copilot eval: ${cases.length} cases, ${fake ? "FAKE scripted model (harness self-test)" : `${provider} ${model} @ ${host}`}\n`);

let warmupMs: number | null = null;
if (!fake && !values["no-warmup"]) {
  const t = performance.now();
  try {
    for await (const _ of chat({ messages: [{ role: "user", content: "Reply with OK." }], signal: AbortSignal.timeout(Number(values.timeout)) })) { /* drain */ }
    warmupMs = performance.now() - t;
    console.log(`warm-up (model load, not counted): ${Math.round(warmupMs)} ms\n`);
  } catch (e) {
    console.error(`Model unreachable: ${e instanceof Error ? e.message : e}`);
    console.error(provider === "ollama" ? `Is Ollama running, and is the model pulled? Try: ollama pull ${model}` : "Check COPILOT_BASE_URL, COPILOT_API_KEY and COPILOT_MODEL.");
    process.exit(2);
  }
}

const startedAt = new Date().toISOString();
const t0 = performance.now();
const results = await runCases({
  chat, cases, timeoutMs: Number(values.timeout),
  onCase: (r, i, n) => {
    const called = r.selection.called.join(", ") || "(no tools)";
    console.log(`${String(i + 1).padStart(2)}/${n} ${r.pass ? "pass" : "FAIL"}  ${r.id.padEnd(26)} ${String(r.latencyMs).padStart(7)} ms  ${called}${r.error ? `  [${r.error.slice(0, 80)}]` : ""}`);
  },
});
const s = summarize(results);
const meta = { mode: fake ? "fake" as const : "real" as const, provider, model, host, startedAt, durationMs: performance.now() - t0, evalDate: todayKey(EVAL_NOW), warmupMs, ...(only ? { note: `Subset: ${only.join(", ")}.` } : {}) };

const p = (v: number | null) => (v === null ? "n/a" : `${v}%`);
console.log(`
Passed                 ${s.passed}/${s.cases} (${p(s.passRate)})
Tool selection         ${p(s.toolSelectionAccuracy)}
Argument validity      ${p(s.argValidity)} of ${s.toolCalls} calls
Argument constraints   ${p(s.argConstraintAccuracy)}
Mean tool rounds       ${s.meanToolRounds}   (hit cap: ${s.hitMaxRounds})
Failures               ${s.failures}
Latency p50/p95/max    ${s.latencyMs.p50} / ${s.latencyMs.p95} / ${s.latencyMs.max} ms
Tokens prompt/compl.   ${s.tokens.prompt ?? "n/a"} / ${s.tokens.completion ?? "n/a"}`);

const outDir = values.out ?? (fake ? join(tmpdir(), "copilot-eval") : join("docs", "evals"));
mkdirSync(outDir, { recursive: true });
const slug = `copilot-${fake ? "FAKE" : `${model.replace(/[^a-z0-9.]+/gi, "-")}`}-${startedAt.slice(0, 10)}${only ? "-subset" : ""}`;
writeFileSync(join(outDir, `${slug}.json`), `${JSON.stringify({ meta, summary: s, results }, null, 2)}\n`);
writeFileSync(join(outDir, `${slug}.md`), renderMarkdown(meta, s, results));
console.log(`\nReport: ${join(outDir, `${slug}.md`)} (+ .json)`);

const min = values["min-pass"] !== undefined ? Number(values["min-pass"]) : fake ? 100 : null;
if (min !== null && (s.passRate ?? 0) < min) { console.error(`Pass rate ${s.passRate}% is below ${min}%.`); process.exit(1); }
