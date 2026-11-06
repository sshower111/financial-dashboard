"use client";
import { useEffect, useRef, useState } from "react";
import { useLedger } from "@/store/ledger";

export const SYNC_KICK = "ledger:sync-kick";
const FAST = 4_000, SLOW = 30_000, KICK_WINDOW = 120_000;

/**
 * Background sync progress: the Plaid pull (no total is known up front, so it's a step, not a %)
 * and the categorization queue (% of the largest queue seen in this run). Hidden when idle.
 */
export function SyncProgress() {
  const demo = useLedger((s) => s.demo);
  const aiUp = useLedger((s) => s.ai.up);
  const [st, setSt] = useState<{ pulling: number; queued: number } | null>(null);
  const peak = useRef(0);

  useEffect(() => {
    if (demo) return;
    let timer: ReturnType<typeof setTimeout>, stopped = false, kickedAt = 0, active = false;
    const tick = async () => {
      clearTimeout(timer);
      try {
        const r = await fetch("/api/sync-status", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { pulling: number; queued: number };
          active = j.pulling > 0 || j.queued > 0;
          peak.current = active ? Math.max(peak.current, j.queued) : 0;
          setSt(j);
        }
      } catch { /* offline: try again later */ }
      if (!stopped) timer = setTimeout(tick, active || Date.now() - kickedAt < KICK_WINDOW ? FAST : SLOW);
    };
    const kick = () => { kickedAt = Date.now(); tick(); };
    window.addEventListener(SYNC_KICK, kick);
    tick();
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener(SYNC_KICK, kick); };
  }, [demo]);

  if (!st || (st.pulling === 0 && st.queued === 0)) return null;
  const total = Math.max(peak.current, st.queued);
  const done = total - st.queued;
  const pct = total ? Math.floor((done / total) * 100) : 100;
  const offline = st.queued > 0 && aiUp === false;
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted" role="status" aria-live="polite">
      {st.pulling > 0 && <span>Importing from bank…</span>}
      {st.queued > 0 && (offline
        ? <span className="text-accent" title="Ollama isn't reachable; the worker will resume when it is">AI offline · <span className="num">{st.queued}</span> waiting</span>
        : <>
            <span className="relative h-[3px] w-20 bg-line" aria-hidden><span className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${pct}%` }} /></span>
            <span>Categorizing <span className="num">{pct}% ({done}/{total})</span></span>
          </>)}
    </div>
  );
}
