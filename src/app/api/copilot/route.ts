import { DEMO_MODE } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { demoLedger, loadLedger, toLedger } from "@/lib/ledger-load";
import { DEFAULT_DASHBOARD, dashboardCurrency, dashboardList, dashboardName, scopeLedger } from "@/lib/finance/scope";
import { markTransfers } from "@/lib/finance/transfers";
import { COPILOT_SYSTEM, buildLedgerContext } from "@/lib/ai/context";
import { OLLAMA_MODEL, OLLAMA_URL, chatStream, generateStream } from "@/lib/ai/ollama";
import { agentMessages, answerStream } from "@/lib/ai/agent";
import type { Currency } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Msg { role: "user" | "assistant"; content: string }

/**
 * Streams the local model's answer. The model first gets read-only tools over the finance engine
 * (src/lib/ai/tools.ts) and calls the ones the question needs; if it can't do tool calling, or the
 * loop fails, the answer comes from the server-built ledger snapshot instead, as it did before.
 * COPILOT_TOOLS=off forces the snapshot path.
 */
export async function POST(req: Request) {
  const { messages, base, dashboard } = (await req.json()) as { messages: Msg[]; base?: Currency; dashboard?: string };
  const question = messages?.at(-1)?.content?.trim();
  if (!question) return new Response("Ask a question about your ledger.", { status: 400 });

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
  // the browser sends the open dashboard's currency; without it, work it out the same way
  const ledger = toLedger(data, base === "USD" || base === "CAD" ? base : dashboardCurrency(dashboardList(data.dashboards, data.accounts), data.accounts, dash));
  const now = new Date();
  const context = `Dashboard: ${name}. The figures below cover only this dashboard's accounts.
` + buildLedgerContext(ledger, now, question);
  const history = messages.slice(-7, -1).map((m) => `${m.role === "user" ? "User" : "Copilot"}: ${m.content}`).join("\n");
  const prompt = `LEDGER SNAPSHOT (JSON):\n${context}\n\n${history ? `CONVERSATION SO FAR:\n${history}\n\n` : ""}User: ${question}\nCopilot:`;

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        const out = answerStream({
          tools: process.env.COPILOT_TOOLS !== "off",
          chat: ({ messages, tools, signal }) => chatStream({ messages, tools, signal, temperature: 0.3 }),
          messages: agentMessages({ question, history: messages.slice(-7, -1), now, base: ledger.base, dashboard: name }),
          // the tools see this in-memory ledger and nothing else: the user's own rows, open dashboard only
          ctx: { ledger, now },
          signal: req.signal,
          snapshot: () => generateStream({ system: COPILOT_SYSTEM, prompt, temperature: 0.3, signal: req.signal }),
          onFallback: (reason) => console.warn(`[copilot] tool calling unavailable, using the snapshot: ${reason.slice(0, 200)}`),
        });
        for await (const text of out) ctrl.enqueue(enc.encode(text));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (DEMO_MODE) ctrl.enqueue(enc.encode("The assistant runs on a local LLM (Ollama), so your financial data never leaves your machine. That means it isn't available in this hosted demo.\n\nTo try it: clone the repo, install Ollama, run `ollama pull qwen3.5:9b`, then `npm run dev`, and ask again."));
        else ctrl.enqueue(enc.encode(`\n\n[Local model unavailable at ${OLLAMA_URL} (${OLLAMA_MODEL}). Start it with \`ollama serve\` and \`ollama pull ${OLLAMA_MODEL}\`. ${msg.slice(0, 160)}]`));
      } finally { ctrl.close(); }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
