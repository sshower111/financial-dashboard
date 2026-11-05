/**
 * Minimal client for a local Ollama instance. Everything stays on localhost:
 * no ledger data is ever sent to a cloud model.
 */
export const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

export interface GenerateOptions {
  prompt: string;
  system?: string;
  /** "json" or a JSON schema for structured output */
  format?: "json" | Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
  /** abort a non-streaming request after this long (first model load on CPU can take minutes) */
  timeoutMs?: number;
}

function body(o: GenerateOptions, stream: boolean) {
  return JSON.stringify({
    model: OLLAMA_MODEL, prompt: o.prompt, system: o.system, format: o.format, stream,
    think: false, // qwen3.x: skip the reasoning trace, we only want the answer
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
