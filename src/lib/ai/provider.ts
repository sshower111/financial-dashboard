/**
 * Which model host the copilot talks to. Server-side only (reads non-public env; never import from a
 * client component).
 *
 *   COPILOT_PROVIDER=ollama (default)   local Ollama: OLLAMA_URL, OLLAMA_MODEL. Data stays on the machine.
 *   COPILOT_PROVIDER=openai-compatible  any /chat/completions host with tool calling: Azure AI Foundry /
 *                                       Azure OpenAI (v1 API), OpenAI, vLLM, LM Studio, ...
 *     COPILOT_BASE_URL      e.g. https://YOUR-RESOURCE.openai.azure.com/openai/v1
 *     COPILOT_API_KEY       server-side secret; never a NEXT_PUBLIC_* variable
 *     COPILOT_MODEL         model name (Azure: the deployment name)
 *     COPILOT_API_KEY_HEADER=api-key   optional, for older Azure endpoints (default: Authorization: Bearer)
 *     COPILOT_API_VERSION   optional, for older Azure deployment URLs (the v1 API needs none)
 *
 * With a hosted provider, tool results (figures from the user's ledger) are sent to that host.
 */
import type { ChatFn } from "./agent.ts";
import { OLLAMA_MODEL, OLLAMA_URL, chatStream } from "./ollama.ts";
import { openaiChatStream } from "./openai-compat.ts";

export type ProviderName = "ollama" | "openai-compatible";

export interface Provider {
  name: ProviderName;
  model: string;
  /** host only (no path, no key), safe to log */
  host: string;
  chat: ChatFn;
  /** true when ledger figures stay on this machine */
  local: boolean;
}

type Env = Record<string, string | undefined>;

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "invalid-url"; } };

/** Builds the provider from env. Overrides (eval CLI flags) win over env. Throws on an incomplete hosted config. */
export function getProvider(env: Env = process.env, over: { provider?: string; model?: string; baseUrl?: string; temperature?: number } = {}): Provider {
  const name = (over.provider ?? env.COPILOT_PROVIDER ?? "ollama").trim().toLowerCase();
  const temperature = over.temperature ?? 0.3;
  if (name === "openai-compatible" || name === "openai") {
    const baseUrl = over.baseUrl ?? env.COPILOT_BASE_URL ?? "";
    const apiKey = env.COPILOT_API_KEY ?? "";
    const model = over.model ?? env.COPILOT_MODEL ?? "";
    const missing = [!baseUrl && "COPILOT_BASE_URL", !apiKey && "COPILOT_API_KEY", !model && "COPILOT_MODEL"].filter(Boolean);
    if (missing.length) throw new Error(`COPILOT_PROVIDER=openai-compatible needs ${missing.join(", ")}.`);
    const cfg = { baseUrl, apiKey, model, keyHeader: env.COPILOT_API_KEY_HEADER === "api-key" ? "api-key" as const : "authorization" as const, apiVersion: env.COPILOT_API_VERSION || undefined };
    return { name: "openai-compatible", model, host: hostOf(baseUrl), local: false, chat: ({ messages, tools, signal }) => openaiChatStream(cfg, { messages, tools, signal, temperature }) };
  }
  if (name !== "ollama") throw new Error(`Unknown COPILOT_PROVIDER "${name}" (use ollama or openai-compatible).`);
  const model = over.model ?? env.OLLAMA_MODEL ?? OLLAMA_MODEL;
  const baseUrl = (over.baseUrl ?? env.OLLAMA_URL ?? OLLAMA_URL).replace(/\/$/, "");
  return { name: "ollama", model, host: hostOf(baseUrl), local: true, chat: ({ messages, tools, signal }) => chatStream({ messages, tools, signal, temperature, model, baseUrl }) };
}
