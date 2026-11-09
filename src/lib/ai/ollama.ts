/**
 * Minimal client for a local Ollama instance. Everything stays on localhost:
 * no ledger data is ever sent to a cloud model.
 */
export const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
/** Assistant (chat) model: quality matters more than speed. */
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
/** Worker categorization model. Defaults to the assistant model: Plaid labels most rows, so the model only sees leftovers and quality beats speed (a 1.5B model filed Burger King as "Transfer"). */
export const OLLAMA_CATEGORIZE_MODEL = process.env.OLLAMA_CATEGORIZE_MODEL ?? OLLAMA_MODEL;
/** `think` is only understood by reasoning-capable models; others may reject the field. */
const THINKS = /qwen3|deepseek-r1|gpt-oss|magistral/i;

export interface GenerateOptions {
  prompt: string;
  system?: string;
  /** "json" or a JSON schema for structured output */
  format?: "json" | Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
  /** abort a non-streaming request after this long (first model load on CPU can take minutes) */
  timeoutMs?: number;
  /** defaults to OLLAMA_MODEL */
  model?: string;
}

function body(o: GenerateOptions, stream: boolean) {
  const model = o.model ?? OLLAMA_MODEL;
  return JSON.stringify({
    model, prompt: o.prompt, system: o.system, format: o.format, stream,
    ...(THINKS.test(model) ? { think: false } : {}), // skip the reasoning trace, we only want the answer
    keep_alive: "10m",
    options: { temperature: o.temperature ?? 0.2, num_ctx: 16384 },
  });
}

export async function generate(o: GenerateOptions): Promise<string> {
  const signals = [o.signal, o.timeoutMs ? AbortSignal.timeout(o.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
  const res = await fetch(`${OLLAMA_URL}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: body(o, false), signal: signals.length ? AbortSignal.any(signals) : undefined });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response: string };
  return json.response;
}

/** Yields response tokens as Ollama streams NDJSON chunks. */
export async function* generateStream(o: GenerateOptions): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: body(o, true), signal: o.signal });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${res.body ? await res.text() : "no body"}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const chunk = JSON.parse(line) as { response?: string; done?: boolean; error?: string };
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.response) yield chunk.response;
      if (chunk.done) return;
    }
  }
}

export async function ollamaHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

/** Installed model names (e.g. "qwen2.5:1.5b"), or null if Ollama is unreachable. */
export async function ollamaModels(timeoutMs = 1500): Promise<string[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch { return null; }
}

/** Ollama names untagged models ":latest". */
export const hasModel = (installed: string[], want: string) =>
  installed.some((n) => n === want || n === `${want}:latest` || (want.endsWith(":latest") && n === want.slice(0, -7)));
