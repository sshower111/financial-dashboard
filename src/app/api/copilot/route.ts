import { DEMO_MODE } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { demoLedger, loadLedger, toLedger } from "@/lib/ledger-load";
import { scopeLedger, scopeName } from "@/lib/finance/scope";
import { COPILOT_SYSTEM, buildLedgerContext } from "@/lib/ai/context";
import { OLLAMA_MODEL, OLLAMA_URL, generateStream } from "@/lib/ai/ollama";
import type { Currency } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Msg { role: "user" | "assistant"; content: string }

/** Streams a plain-text answer from the local model, grounded in a server-built ledger snapshot. */
export async function POST(req: Request) {
  const { messages, base, scope } = (await req.json()) as { messages: Msg[]; base?: Currency; scope?: string };
  const question = messages?.at(-1)?.content?.trim();
  if (!question) return new Response("Ask a question about your ledger.", { status: 400 });

  let data;
  if (DEMO_MODE) data = demoLedger();
  else {
    const { sb, user } = await requireUser();
    if (!user) return new Response("unauthorized", { status: 401 });
    data = await loadLedger(sb);
  }
  // same filter the dashboard uses; data is already RLS-scoped to the user, this only narrows it
  const sc = typeof scope === "string" ? scope : "all";
  const label = scopeName(sc, data.accounts, data.institutions);
  data = scopeLedger(data, sc);
  const context = (label === "All accounts" ? "" : `Scope: ${label} only. Figures below cover just these accounts.
`) + buildLedgerContext(toLedger(data, base ?? data.base));
  const history = messages.slice(-7, -1).map((m) => `${m.role === "user" ? "User" : "Copilot"}: ${m.content}`).join("\n");
  const prompt = `LEDGER SNAPSHOT (JSON):\n${context}\n\n${history ? `CONVERSATION SO FAR:\n${history}\n\n` : ""}User: ${question}\nCopilot:`;

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (const tok of generateStream({ system: COPILOT_SYSTEM, prompt, temperature: 0.3, signal: req.signal })) ctrl.enqueue(enc.encode(tok));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (DEMO_MODE) ctrl.enqueue(enc.encode("The copilot runs on a local LLM (Ollama), so your financial data never leaves your machine. That means it isn't available in this hosted demo.\n\nTo try it: clone the repo, install Ollama, run `ollama pull qwen3.5:9b`, then `npm run dev`, and ask again."));
        else ctrl.enqueue(enc.encode(`\n\n[Local model unavailable at ${OLLAMA_URL} (${OLLAMA_MODEL}). Start it with \`ollama serve\` and \`ollama pull ${OLLAMA_MODEL}\`. ${msg.slice(0, 160)}]`));
      } finally { ctrl.close(); }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
