/**
 * Conversation memory for the copilot: the prior turns of the open conversation, bounded so a long chat
 * can't blow the model's context or the request size. Pure and import-free, so the browser widget
 * (which trims what it sends) and the route (which enforces the bound on whatever arrives) share it.
 *
 * Memory lives only in the browser tab: nothing is stored on the server, and closing or clearing the
 * chat forgets it. Tools stay read-only either way; history is text for the model, not a new data path.
 */

export interface HistoryInput { role?: unknown; content?: unknown; tools?: unknown }
export interface HistoryMessage { role: "user" | "assistant"; content: string }

export interface MemoryLimits {
  /** most prior user→assistant turns kept (a turn = one question + its answer) */
  maxTurns: number;
  /** total characters across kept messages (~4 chars per token) */
  maxChars: number;
  /** longest single message; longer ones keep their start and end */
  maxMessageChars: number;
}

/** About 1,500 tokens of history: enough for follow-ups ("and last month?"), small next to num_ctx 16k. */
export const MEMORY_LIMITS: MemoryLimits = { maxTurns: 6, maxChars: 6000, maxMessageChars: 1500 };
/** What the browser sends at most: prior turns plus the new question. */
export const MEMORY_MAX_MESSAGES = MEMORY_LIMITS.maxTurns * 2 + 1;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // includes \x1e, the wire control marker

function clip(s: string, max: number) {
  if (s.length <= max) return s;
  const half = Math.floor((max - 5) / 2);
  return `${s.slice(0, half)} […] ${s.slice(-half)}`;
}

/**
 * Prior turns → bounded, sanitized history (oldest first), excluding the current question.
 *
 * - only `user` / `assistant` roles with text survive (a client can't inject `system` or `tool` turns)
 * - control characters are stripped, very long messages clipped
 * - an assistant answer notes which tools produced it, so a follow-up can reuse the same tool
 * - newest turns are kept first, up to `maxTurns` and `maxChars`; the result starts with a user turn
 */
export function boundHistory(prior: readonly HistoryInput[] | undefined, limits: MemoryLimits = MEMORY_LIMITS): HistoryMessage[] {
  if (!Array.isArray(prior)) return [];
  const clean: HistoryMessage[] = [];
  for (const m of prior) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    let content = m.content.replace(CONTROL, "").trim();
    if (!content) continue;
    content = clip(content, limits.maxMessageChars);
    if (m.role === "assistant" && Array.isArray(m.tools)) {
      const names = (m.tools as unknown[]).filter((t): t is string => typeof t === "string" && /^[a-z_]{1,40}$/.test(t)).slice(0, 7);
      if (names.length) content += `\n(Figures above came from: ${names.join(", ")}.)`;
    }
    // two user messages in a row (an answer that failed): keep the later one
    if (clean.length && clean.at(-1)!.role === m.role) clean.pop();
    clean.push({ role: m.role, content });
  }
  // newest first, whole turns where possible, within both budgets
  const out: HistoryMessage[] = [];
  let chars = 0, users = 0;
  for (let i = clean.length - 1; i >= 0; i--) {
    const m = clean[i];
    if (m.role === "user" && users >= limits.maxTurns) break;
    if (chars + m.content.length > limits.maxChars) break;
    chars += m.content.length;
    if (m.role === "user") users++;
    out.unshift(m);
  }
  while (out.length && out[0].role !== "user") out.shift(); // never open on an orphan answer
  while (out.length && out.at(-1)!.role !== "assistant") out.pop(); // nor end on an unanswered question
  return out;
}

/**
 * Splits a request's `messages` into history and the current question (the last user message).
 * Returns null when there is no question.
 */
export function splitConversation(messages: unknown, limits: MemoryLimits = MEMORY_LIMITS): { question: string; history: HistoryMessage[] } | null {
  if (!Array.isArray(messages) || !messages.length) return null;
  const last = messages.at(-1) as HistoryInput | undefined;
  if (!last || last.role !== "user" || typeof last.content !== "string") return null;
  const question = last.content.replace(CONTROL, "").trim().slice(0, 2000);
  if (!question) return null;
  return { question, history: boundHistory(messages.slice(0, -1) as HistoryInput[], limits) };
}
