"use client";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Plus } from "lucide-react";
import { useLedger } from "@/store/ledger";

/** Plaid Link (US + CA institutions, transactions + optional investments). */
export function ConnectBank() {
  const demo = useLedger((s) => s.demo);
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const onSuccess = useCallback(async (public_token: string | null) => {
    if (!public_token) return;
    setMsg("Linking…");
    const r = await fetch("/api/plaid/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_token }) });
    const j = await r.json();
    setMsg(r.ok ? `${j.institution}: ${j.accounts} accounts · syncing in background` : j.error);
    if (r.ok) useLedger.getState().pushEvent({ kind: "synced", text: `Linked ${j.institution} — worker is importing history` });
    setToken(null);
  }, []);
  const { open, ready } = usePlaidLink({ token, onSuccess, onExit: () => setToken(null) });
  useEffect(() => { if (token && ready) open(); }, [token, ready, open]);

  async function start() {
    setMsg(null);
    const r = await fetch("/api/plaid/link-token", { method: "POST" });
    const j = await r.json();
    if (r.ok) {
      try { sessionStorage.setItem("ledger.linkToken", j.link_token); } catch { /* */ }
      setToken(j.link_token);
    } else setMsg(j.error);
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="hidden text-[12px] text-muted lg:inline">{msg}</span>}
      <button onClick={start} disabled={demo} title={demo ? "Configure Supabase + Plaid to link real institutions" : "Link a bank, card or brokerage account"} aria-label="Link institution"
        className="flex h-7 items-center gap-1.5 border border-line px-2.5 text-[12px] hover:border-ink disabled:cursor-not-allowed disabled:opacity-50">
        <Plus size={12} /> <span className="hidden sm:inline">Link institution</span>
      </button>
    </div>
  );
}
