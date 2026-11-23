/**
 * Lightweight per-request tracing for the copilot: model calls (latency, time to first token, token
 * counts when the host reports them), tool calls (name, argument SHAPE, ok / error code, duration)
 * and the outcome. One JSON record per request.
 *
 * Privacy: a record never holds the question, the answer, tool results, transaction descriptions,
 * merchant text, amounts or dates. Arguments are reduced to their shape: `{"merchant":"string"}`,
 * `{"from":"date"}`; only values from a tool's fixed enum (e.g. `period: "last_month"`) are kept,
 * because they cannot carry user data.
 *
 * Sinks (server env, all optional):
 *   COPILOT_TRACE=console (default) | file | off
 *   COPILOT_TRACE_FILE=logs/copilot-trace.jsonl   (file sink; logs/ is git-ignored)
 *   LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY [+ LANGFUSE_BASE_URL, default https://cloud.langfuse.com]
 *     also exports the same record to Langfuse (batch ingestion API). Off unless both keys are set.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { TOOL_SCHEMAS } from "./tools.ts";
import type { AgentObserver } from "./agent.ts";

export interface TraceModelCall { round: number; final: boolean; startMs: number; ms: number; firstTokenMs: number | null; promptTokens?: number; completionTokens?: number; toolCalls: string[]; error?: string }
export interface TraceToolCall { round: number; name: string; args: Record<string, string>; ok: boolean; errorCode?: string; startMs: number; ms: number }
export type TraceOutcome = "answered" | "fallback_answered" | "error" | "aborted";

export interface TraceRecord {
  v: 1;
  id: string;
  at: string;
  provider: string;
  model: string;
  mode: "tools" | "snapshot";
  historyMessages: number;
  fallbackReason?: string;
  outcome?: TraceOutcome;
  modelCalls: TraceModelCall[];
  toolCalls: TraceToolCall[];
  totals: { ms: number; modelMs: number; toolMs: number; rounds: number; promptTokens: number | null; completionTokens: number | null };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const cleanName = (s: unknown) => String(s ?? "").replace(/[^a-z0-9_]/gi, "").slice(0, 40) || "(none)";
const cleanError = (s: string) => s.replace(/\s+/g, " ").slice(0, 200);
const SCHEMA = new Map(TOOL_SCHEMAS.map((t) => [t.function.name, t.function.parameters.properties as Record<string, { type: string; enum?: readonly string[]; format?: string }>]));

/** The shape of model-supplied arguments, safe to log (see the privacy note above). */
export function argShape(tool: string, raw: unknown): Record<string, string> {
  let input = raw;
  if (typeof input === "string") { try { input = input.trim() ? JSON.parse(input) : {}; } catch { return { _: "unparseable" }; } }
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return { _: Array.isArray(input) ? "array" : typeof input };
  const props = SCHEMA.get(tool) ?? {};
  const out: Record<string, string> = {};
  let unknown = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const p = props[k];
    if (!p) { unknown++; continue; } // a made-up key name could carry anything; count it only
    if (v === null || v === undefined) { out[k] = "null"; continue; }
    if (p.enum && typeof v === "string") {
      const hit = p.enum.find((e) => e.toLowerCase() === v.trim().toLowerCase());
      out[k] = hit ?? "string(not in enum)";
    } else if (p.format === "date" && typeof v === "string") out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? "date" : "string(not a date)";
    else out[k] = Array.isArray(v) ? "array" : typeof v;
  }
  if (unknown) out._unknownKeys = String(unknown);
  return out;
}

export interface Tracer {
  record: TraceRecord;
  observer: AgentObserver;
  /** the agent failed and the snapshot path answered */
  fallback(reason: string): void;
  /** finish, compute totals and send to the sinks; never throws */
  end(outcome: TraceOutcome): Promise<TraceRecord>;
}

type Env = Record<string, string | undefined>;

export function startTrace(meta: { provider: string; model: string; historyMessages: number; mode?: "tools" | "snapshot" }, opts: { env?: Env; sink?: (r: TraceRecord) => void | Promise<void> } = {}): Tracer {
  const env = opts.env ?? process.env;
  const t0 = performance.now();
  const record: TraceRecord = {
    v: 1, id: crypto.randomUUID(), at: new Date().toISOString(), provider: meta.provider, model: meta.model,
    mode: meta.mode ?? "tools", historyMessages: meta.historyMessages, modelCalls: [], toolCalls: [],
    totals: { ms: 0, modelMs: 0, toolMs: 0, rounds: 0, promptTokens: null, completionTokens: null },
  };
  const since = () => performance.now() - t0;
  const observer: AgentObserver = {
    modelCall: (i) => record.modelCalls.push({
      round: i.round, final: i.final, startMs: r1(since() - i.ms), ms: r1(i.ms), firstTokenMs: i.firstTokenMs === null ? null : r1(i.firstTokenMs),
      ...(i.usage?.promptTokens !== undefined ? { promptTokens: i.usage.promptTokens } : {}),
      ...(i.usage?.completionTokens !== undefined ? { completionTokens: i.usage.completionTokens } : {}),
      toolCalls: i.toolCalls.map(cleanName), ...(i.error ? { error: cleanError(i.error) } : {}),
    }),
    toolCall: (i) => record.toolCalls.push({ round: i.round, name: cleanName(i.name), args: argShape(i.name, i.args), ok: i.ok, ...(i.errorCode ? { errorCode: i.errorCode } : {}), startMs: r1(since() - i.ms), ms: r1(i.ms) }),
  };
  return {
    record, observer,
    fallback: (reason) => { record.mode = "snapshot"; record.fallbackReason = cleanError(reason); },
    async end(outcome) {
      record.outcome = outcome;
      const sum = (xs: (number | undefined)[]) => (xs.some((x) => x !== undefined) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);
      record.totals = {
        ms: r1(since()), modelMs: r1(record.modelCalls.reduce((a, c) => a + c.ms, 0)), toolMs: r1(record.toolCalls.reduce((a, c) => a + c.ms, 0)),
        rounds: record.modelCalls.length,
        promptTokens: sum(record.modelCalls.map((c) => c.promptTokens)), completionTokens: sum(record.modelCalls.map((c) => c.completionTokens)),
      };
      try {
        if (opts.sink) await opts.sink(record);
        else await emit(record, env);
      } catch { /* tracing must never break a request */ }
      return record;
    },
  };
}

async function emit(record: TraceRecord, env: Env) {
  const mode = (env.COPILOT_TRACE ?? "console").toLowerCase();
  const line = JSON.stringify(record);
  if (mode === "console") console.info(`[copilot-trace] ${line}`);
  else if (mode === "file") {
    const path = env.COPILOT_TRACE_FILE || "logs/copilot-trace.jsonl";
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`);
  }
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) await exportLangfuse(record, env);
}

/** The record as a Langfuse ingestion batch: one trace, a generation per model call, a span per tool call. */
export function toLangfuseBatch(r: TraceRecord) {
  const start = Date.parse(r.at);
  const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
  const ev = (type: string, body: Record<string, unknown>) => ({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), type, body });
  return [
    ev("trace-create", {
      id: r.id, name: "copilot", timestamp: r.at, tags: [r.provider, r.mode],
      metadata: { provider: r.provider, model: r.model, mode: r.mode, outcome: r.outcome, historyMessages: r.historyMessages, totals: r.totals, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}) },
    }),
    ...r.modelCalls.map((c) => ev("generation-create", {
      id: crypto.randomUUID(), traceId: r.id, name: c.final ? "model (forced answer)" : `model round ${c.round}`, model: r.model,
      startTime: iso(c.startMs), endTime: iso(c.startMs + c.ms), ...(c.firstTokenMs !== null ? { completionStartTime: iso(c.startMs + c.firstTokenMs) } : {}),
      ...(c.promptTokens !== undefined || c.completionTokens !== undefined ? { usageDetails: { input: c.promptTokens ?? 0, output: c.completionTokens ?? 0 } } : {}),
      metadata: { toolCalls: c.toolCalls }, ...(c.error ? { level: "ERROR", statusMessage: c.error } : {}),
    })),
    ...r.toolCalls.map((t) => ev("span-create", {
      id: crypto.randomUUID(), traceId: r.id, name: `tool ${t.name}`, startTime: iso(t.startMs), endTime: iso(t.startMs + t.ms),
      metadata: { round: t.round, args: t.args }, ...(t.ok ? {} : { level: "WARNING", statusMessage: t.errorCode }),
    })),
  ];
}

async function exportLangfuse(r: TraceRecord, env: Env) {
  const base = (env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64");
  try {
    const res = await fetch(`${base}/api/public/ingestion`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch: toLangfuseBatch(r) }), signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) console.warn(`[copilot-trace] Langfuse export failed: ${res.status}`);
  } catch (e) { console.warn(`[copilot-trace] Langfuse export failed: ${e instanceof Error ? e.message : e}`); }
}
