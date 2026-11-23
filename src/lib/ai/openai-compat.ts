/**
 * Streaming client for an OpenAI-compatible `/chat/completions` endpoint with tool calling: Azure AI
 * Foundry / Azure OpenAI (v1 API), OpenAI, and other hosts that speak the same protocol (vLLM,
 * LM Studio, OpenRouter, ...). Server-side only: the API key is read from the server's env and never
 * reaches the browser. It yields the same `ChatChunk`s as Ollama's `chatStream`, so the agent loop
 * does not know which host it is talking to.
 */
import type { ChatChunk, ChatMessage, ChatToolCall } from "./ollama.ts";

export interface OpenAICompatConfig {
  /** e.g. https://YOUR-RESOURCE.openai.azure.com/openai/v1 or https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** model name; on Azure the deployment name */
  model: string;
  /** "authorization" sends `Authorization: Bearer <key>` (default); "api-key" sends `api-key: <key>` (older Azure endpoints) */
  keyHeader?: "authorization" | "api-key";
  /** appended as `?api-version=` (only for older Azure deployment URLs; the v1 API needs none) */
  apiVersion?: string;
}

export interface OpenAIChatRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  signal?: AbortSignal;
}

/** Our message shape (Ollama's) to the OpenAI wire shape: tool calls need ids and string arguments. */
export function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool" as const, tool_call_id: m.tool_call_id ?? "", content: m.content };
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant" as const, content: m.content || null,
        tool_calls: m.tool_calls.map((c, i) => ({
          id: c.id ?? `call_${i}`, type: "function" as const,
          function: { name: String(c?.function?.name ?? ""), arguments: typeof c?.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function chatCompletionsUrl(cfg: Pick<OpenAICompatConfig, "baseUrl" | "apiVersion">) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return cfg.apiVersion ? `${url}?api-version=${encodeURIComponent(cfg.apiVersion)}` : url;
}

interface Delta {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

/** Parses `data:` lines of a server-sent-events body. */
async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
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
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.trim().startsWith("data:")) yield buf.trim().slice(5).trim();
}

/**
 * Streams one chat-completions turn. Text deltas are yielded as they arrive; tool-call fragments
 * (streamed piecewise by index) are assembled and yielded once, at the end of the stream.
 */
export async function* openaiChatStream(cfg: OpenAICompatConfig, o: OpenAIChatRequest): AsyncGenerator<ChatChunk> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.keyHeader === "api-key") headers["api-key"] = cfg.apiKey;
  else headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(chatCompletionsUrl(cfg), {
    method: "POST", headers, signal: o.signal,
    body: JSON.stringify({
      model: cfg.model, messages: toOpenAIMessages(o.messages), stream: true, stream_options: { include_usage: true },
      ...(o.tools?.length ? { tools: o.tools, tool_choice: "auto" } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Chat completions ${res.status}: ${res.body ? (await res.text()).slice(0, 300) : "no body"}`);
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  for await (const data of sse(res)) {
    if (!data || data === "[DONE]") continue;
    const d = JSON.parse(data) as Delta;
    if (d.error) throw new Error(typeof d.error === "string" ? d.error : d.error.message ?? "chat completions error");
    const delta = d.choices?.[0]?.delta;
    if (delta?.content) yield { content: delta.content };
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? calls.size;
      const cur = calls.get(idx) ?? { name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (d.usage) yield { usage: { promptTokens: d.usage.prompt_tokens, completionTokens: d.usage.completion_tokens } };
  }
  if (calls.size) {
    const tool_calls: ChatToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ ...(c.id ? { id: c.id } : {}), function: { name: c.name, arguments: c.args } }));
    yield { tool_calls };
  }
}
