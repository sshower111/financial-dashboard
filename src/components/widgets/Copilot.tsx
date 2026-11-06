"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useLedger } from "@/store/ledger";

interface Msg { role: "user" | "assistant"; content: string }
const SUGGESTIONS = ["Why was my burn rate higher this week?", "What subscriptions went up?", "Can I afford a $1,200 trip this month?", "Where is most of my dining money going?"];

export function Copilot() {
  const base = useLedger((s) => s.base);
  const ai = useLedger((s) => s.ai);
  const demo = useLedger((s) => s.demo);
  const scope = useLedger((s) => s.scope);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q.trim() }];
    setMsgs([...next, { role: "assistant", content: "" }]);
    setInput(""); setBusy(true);
    abort.current = new AbortController();
    try {
      const res = await fetch("/api/copilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: next, base, scope }), signal: abort.current.signal });
      if (!res.body) throw new Error(await res.text());
      const reader = res.body.getReader(), dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setMsgs([...next, { role: "assistant", content: acc }]);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setMsgs([...next, { role: "assistant", content: `[${(e as Error).message}]` }]);
    } finally { setBusy(false); abort.current = null; }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-3 py-3">
        {!msgs.length ? (
          <div className="flex h-full flex-col justify-end gap-2">
            <p className="text-[12px] text-muted">
              {demo && ai.up === false
                ? <>Ask about your ledger. The copilot runs on a local LLM via Ollama, so it isn&apos;t available in this hosted demo. Run the project locally to try it.</>
                : <>Ask about your ledger. Answers come from <span className="num">{ai.model || "the local model"}</span> on this machine. Nothing leaves localhost.</>}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="border border-line px-2 py-1 text-left text-[12px] text-ink-2 hover:border-ink hover:text-ink">{s}</button>)}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "self-end max-w-[85%] border border-line bg-sunk px-3 py-2" : "max-w-full"}>
                {m.role === "assistant" && <div className="label mb-1">Copilot</div>}
                <div className="text-[13px] leading-relaxed whitespace-pre-wrap">
                  {m.content || <span className="num text-muted">thinking…</span>}
                  {busy && i === msgs.length - 1 && m.content && <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-accent" />}
                </div>
              </div>
            ))}
            <div ref={end} />
          </div>
        )}
      </div>
      <form className="flex shrink-0 items-center gap-2 border-t border-line p-2" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Why was my burn rate higher this week?" className="h-8 min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-muted" aria-label="Ask the copilot" />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} className="grid h-8 w-8 place-items-center border border-line hover:border-ink" title="Stop"><Square size={12} /></button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="grid h-8 w-8 place-items-center bg-accent text-accent-ink disabled:bg-sunk disabled:text-muted" title="Send"><ArrowUp size={14} /></button>
        )}
      </form>
    </div>
  );
}
