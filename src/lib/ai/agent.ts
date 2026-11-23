/**
 * Tool-calling loop for the copilot. The model call is injected (`ChatFn`), so the loop runs in unit
 * tests against a scripted fake model with no network; in production it is `chatStream` (Ollama /api/chat).
 *
 *   messages + tool schemas → model
 *     ├─ tool calls → validate + execute each (tools.ts) → append results → next round
 *     └─ text       → that is the answer; stream it
 *   after `maxRounds` tool rounds the model is called once more WITHOUT tools and told to answer.
 */
import type { ChatChunk, ChatMessage, ChatToolCall, ChatUsage } from "./ollama.ts";
import { TOOL_SCHEMAS, executeTool, type ToolContext, type ToolErrorCode, type ToolResult, type ToolSchema } from "./tools.ts";
import { WIRE_FALLBACK, WIRE_RESET, wireTool } from "./wire.ts";
import { CATEGORIES } from "../types.ts";
import { parseKey, todayKey } from "../finance/dates.ts";

export type ChatFn = (req: { messages: ChatMessage[]; tools?: ToolSchema[]; signal?: AbortSignal }) => AsyncIterable<ChatChunk>;

export type AgentEvent =
  | { type: "token"; text: string }
  /** a tool call was handled; `ok: false` means the model got a structured error back */
  | { type: "tool"; name: string; ok: boolean }
  /** text streamed so far was a preamble to a tool call, not the answer */
  | { type: "reset" };

export const MAX_ROUNDS = 4;
/** A runaway model can't fan out: calls past this in one turn get an error result instead of running. */
export const MAX_CALLS_PER_ROUND = 6;

const FORCE_ANSWER = "You have used all your tool calls. Answer the user's question now, using only the tool results above. If they are not enough, say what is missing.";

/**
 * Optional hooks for tracing and evals. They see timings, token counts, tool names and the raw
 * arguments the model sent; what to keep is the observer's decision (the tracer keeps only shapes).
 * A throwing observer never breaks the answer.
 */
export interface AgentObserver {
  modelCall?(i: { round: number; final: boolean; ms: number; firstTokenMs: number | null; usage?: ChatUsage; toolCalls: string[]; error?: string }): void;
  toolCall?(i: { round: number; name: string; args: unknown; ok: boolean; errorCode?: ToolErrorCode; ms: number }): void;
}
const safe = (f: () => void) => { try { f(); } catch { /* observers must not break the answer */ } };

export interface AgentOptions {
  chat: ChatFn;
  observer?: AgentObserver;
  /** system prompt + history + question (see `agentMessages`); not mutated */
  messages: ChatMessage[];
  ctx: ToolContext;
  maxRounds?: number;
  signal?: AbortSignal;
}

/** Runs the loop, yielding tool activity and answer tokens. Throws if the model call fails or it never answers. */
export async function* runAgent(o: AgentOptions): AsyncGenerator<AgentEvent> {
  const messages = [...o.messages];
  const maxRounds = o.maxRounds ?? MAX_ROUNDS;
  for (let round = 0; round <= maxRounds; round++) {
    const final = round === maxRounds; // out of tool rounds: no tools offered, the model must answer
    if (final) messages.push({ role: "user", content: FORCE_ANSWER });
    let content = "";
    let calls: ChatToolCall[] = [];
    let usage: ChatUsage | undefined;
    const t0 = performance.now();
    let firstTokenMs: number | null = null;
    const report = (error?: string) => safe(() => o.observer?.modelCall?.({ round, final, ms: performance.now() - t0, firstTokenMs, usage, toolCalls: calls.map((c) => String(c?.function?.name ?? "")), error }));
    try {
      for await (const chunk of o.chat({ messages, tools: final ? undefined : TOOL_SCHEMAS, signal: o.signal })) {
        if (firstTokenMs === null && (chunk.content || chunk.tool_calls)) firstTokenMs = performance.now() - t0;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.content) { content += chunk.content; yield { type: "token", text: chunk.content }; }
        if (chunk.tool_calls && !final) calls.push(...chunk.tool_calls);
      }
    } catch (e) { report(e instanceof Error ? e.message : String(e)); throw e; }
    report();
    if (!calls.length) {
      if (!content.trim()) throw new Error("The model returned an empty answer.");
      return;
    }
    if (content) yield { type: "reset" };
    // OpenAI-compatible hosts pair each result with its call by id; give id-less calls (Ollama) one
    calls = calls.map((c, i) => ({ ...c, id: c?.id ?? `call_${round}_${i}` }));
    messages.push({ role: "assistant", content, tool_calls: calls });
    for (const [i, call] of calls.entries()) {
      const name = String(call?.function?.name ?? "");
      const started = performance.now();
      const result: ToolResult = i < MAX_CALLS_PER_ROUND
        ? executeTool(name, call?.function?.arguments, o.ctx)
        : { ok: false, tool: name, error: { code: "too_many_calls", message: `At most ${MAX_CALLS_PER_ROUND} tool calls per turn; this one was not run.` } };
      safe(() => o.observer?.toolCall?.({ round, name, args: call?.function?.arguments, ok: result.ok, errorCode: result.ok ? undefined : result.error.code, ms: performance.now() - started }));
      yield { type: "tool", name, ok: result.ok };
      messages.push({ role: "tool", tool_name: name, tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}

export interface AnswerOptions extends AgentOptions {
  /** the pre-tool-calling behaviour: one prompt with the whole ledger snapshot */
  snapshot: () => AsyncIterable<string>;
  /** false skips the agent entirely (COPILOT_TOOLS=off) */
  tools?: boolean;
  onFallback?: (reason: string) => void;
}

/**
 * The copilot response as wire text (see wire.ts): the agent's answer with its tool trace, or, if the
 * model can't do tool calling or the loop fails at any point, the snapshot answer. Errors from the
 * snapshot path itself propagate, as they did before tool calling existed.
 */
export async function* answerStream(o: AnswerOptions): AsyncGenerator<string> {
  let sent = false;
  if (o.tools !== false) {
    try {
      for await (const ev of runAgent(o)) {
        sent = true;
        // only tools that exist and ran are shown; a hallucinated name is the model's mistake, not a step taken
        if (ev.type === "tool") { if (ev.ok) yield wireTool(ev.name); }
        else yield ev.type === "token" ? ev.text : WIRE_RESET;
      }
      return;
    } catch (e) {
      if (o.signal?.aborted) return; // the user pressed stop
      o.onFallback?.(e instanceof Error ? e.message : String(e));
    }
  }
  if (sent) yield WIRE_FALLBACK; // drop the partial answer and trace; start clean
  yield* o.snapshot();
}

export const AGENT_SYSTEM = `You are the assistant inside a personal finance dashboard. You answer questions about the user's own finances.
You cannot see the ledger directly. Call the provided tools to get figures, then answer from their results.
Rules:
- Always call a tool before stating any amount, date, merchant or balance. Never guess and never invent transactions.
- Tool results are already computed by the dashboard. Quote them as given; do not redo or "correct" the arithmetic.
- Call only the tools the question needs (usually one or two). For date ranges prefer the "period" argument over working out dates yourself.
- Some questions need two tools: call both, in the same turn when they don't depend on each other. "Can I afford a $1,200 purchase next month given my forecast and budget pace?" needs get_cash_forecast AND get_budget_pacing; "how does dining this month compare with last month?" needs get_spending_by_category once per period. Answer only after you have every result you need.
- The cash forecast covers the next 30 days and budgets cover the current month. If the question is about a later period, use them as the best available signal and say so.
- Earlier turns of this conversation are context for follow-ups ("and last month?" means the same question for another period). For a new figure, call the tools again; don't reuse numbers from earlier answers unless the user asks about them.
- Be direct and brief: lead with the answer in one sentence, then up to 4 short supporting bullets with specific merchants, dates and amounts.
- Amounts: in transaction rows positive = spent, negative = received. Quote money with currency codes, e.g. "USD 1,204.50".
- If the tools cannot answer the question, say exactly what data is missing.
- No investment, tax or legal advice beyond describing the user's own data.`;

/** System prompt (with the facts the model needs to pick arguments), recent turns, and the question. */
export function agentMessages(o: { question: string; history?: { role: "user" | "assistant"; content: string }[]; now: Date; base: string; dashboard: string }): ChatMessage[] {
  const today = todayKey(o.now);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][parseKey(today).getUTCDay()];
  const facts = `Today is ${weekday} ${today}. Base currency: ${o.base}. Open dashboard: ${o.dashboard} (the tools cover only this dashboard's accounts). Categories: ${CATEGORIES.join(", ")}.`;
  return [
    { role: "system", content: `${AGENT_SYSTEM}\n${facts}` },
    ...(o.history ?? []).filter((m) => m.content?.trim()).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: o.question },
  ];
}
