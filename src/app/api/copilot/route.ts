import { DEMO_MODE } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { demoLedger, loadLedger, toLedger } from "@/lib/ledger-load";
import { DEFAULT_DASHBOARD, dashboardList, dashboardName, scopeLedger } from "@/lib/finance/scope";
import { markTransfers } from "@/lib/finance/transfers";
import { COPILOT_SYSTEM, buildLedgerContext } from "@/lib/ai/context";
import { OLLAMA_URL, generateStream } from "@/lib/ai/ollama";
import { agentMessages, answerStream } from "@/lib/ai/agent";
import { splitConversation } from "@/lib/ai/memory";
import { getProvider, type Provider } from "@/lib/ai/provider";
import { startTrace } from "@/lib/ai/trace";
import type { Currency } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Streams the local model's answer. The model first gets read-only tools over the finance engine
 * (src/lib/ai/tools.ts) and calls the ones the question needs; if it can't do tool calling, or the
 * loop fails, the answer comes from the server-built ledger snapshot instead, as it did before.
 * COPILOT_TOOLS=off forces the snapshot path.
 *
 * Memory: the browser sends the open conversation; `splitConversation` keeps a bounded, sanitized
 * window of prior turns (src/lib/ai/memory.ts). Nothing is stored server-side.
 * Provider: Ollama by default, or an OpenAI-compatible host (COPILOT_PROVIDER, see provider.ts).
 * Tracing: one PII-free record per request (src/lib/ai/trace.ts).
 */
export async function POST(req: Request) {
  const { messages, base, dashboard } = (await req.json().catch(() => ({}))) as { messages?: unknown; base?: Currency; dashboard?: string };
  const convo = splitConversation(messages);
  if (!convo) return new Response("Ask a question about your ledger.", { status: 400 });
  const { question, history } = convo;
  let provider: Provider;
  try { provider = getProvider(); }
  catch (e) { return new Response(`[Assistant misconfigured: ${e instanceof Error ? e.message : e}]`, { status: 500 }); }

  let data;
  if (DEMO_MODE) data = demoLedger();
  else {
    const { sb, user } = await requireUser();
    if (!user) return new Response("unauthorized", { status: 401 });
    data = await loadLedger(sb);
  }
  // only the open dashboard's data; it's already RLS-scoped to the user, this only narrows it
  const dash = typeof dashboard === "string" && dashboard ? dashboard : DEFAULT_DASHBOARD;
  const name = dashboardName(dashboardList(data.dashboards, data.accounts), dash);
  data = scopeLedger(markTransfers(data), dash);
  const ledger = toLedger(data, base ?? data.base);
  const now = new Date();
  const context = `Dashboard: ${name}. The figures below cover only this dashboard's accounts.
` + buildLedgerContext(ledger, now, question);
  const historyText = history.map((m) => `${m.role === "user" ? "User" : "Copilot"}: ${m.content}`).join("\n");
  const prompt = `LEDGER SNAPSHOT (JSON):\n${context}\n\n${historyText ? `CONVERSATION SO FAR:\n${historyText}\n\n` : ""}User: ${question}\nCopilot:`;
  const toolsOn = process.env.COPILOT_TOOLS !== "off";
  const trace = startTrace({ provider: provider.name, model: provider.model, historyMessages: history.length, mode: toolsOn ? "tools" : "snapshot" });
  // the snapshot path: Ollama /api/generate as before, or the hosted model without tools
  const snapshot = provider.name === "ollama"
    ? () => generateStream({ system: COPILOT_SYSTEM, prompt, temperature: 0.3, signal: req.signal, model: provider.model })
    : async function* () {
      for await (const c of provider.chat({ messages: [{ role: "system", content: COPILOT_SYSTEM }, { role: "user", content: prompt }], signal: req.signal })) if (c.content) yield c.content;
    };

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let outcome: "answered" | "fallback_answered" | "error" | "aborted" = "answered";
      try {
        const out = answerStream({
          tools: toolsOn,
          chat: provider.chat,
          observer: trace.observer,
          messages: agentMessages({ question, history, now, base: ledger.base, dashboard: name }),
          // the tools see this in-memory ledger and nothing else: the user's own rows, open dashboard only
          ctx: { ledger, now },
          signal: req.signal,
          snapshot,
          onFallback: (reason) => {
            outcome = "fallback_answered";
            trace.fallback(reason);
            console.warn(`[copilot] tool calling unavailable, using the snapshot: ${reason.slice(0, 200)}`);
          },
        });
        for await (const text of out) ctrl.enqueue(enc.encode(text));
        if (req.signal.aborted) outcome = "aborted";
      } catch (e) {
        outcome = req.signal.aborted ? "aborted" : "error";
        const msg = e instanceof Error ? e.message : String(e);
        if (DEMO_MODE && provider.name === "ollama") ctrl.enqueue(enc.encode("The assistant runs on a local LLM (Ollama), so your financial data never leaves your machine. That means it isn't available in this hosted demo.\n\nTo try it: clone the repo, install Ollama, run `ollama pull qwen3.5:9b`, then `npm run dev`, and ask again."));
        else if (provider.name === "ollama") ctrl.enqueue(enc.encode(`\n\n[Local model unavailable at ${OLLAMA_URL} (${provider.model}). Start it with \`ollama serve\` and \`ollama pull ${provider.model}\`. ${msg.slice(0, 160)}]`));
        else ctrl.enqueue(enc.encode(`\n\n[Hosted model unavailable (${provider.host}, ${provider.model}). ${msg.slice(0, 160)}]`));
      } finally {
        ctrl.close();
        void trace.end(outcome); // after the response is complete; never throws
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
