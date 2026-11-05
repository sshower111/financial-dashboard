"use client";
/**
 * Plaid OAuth return page. After the user approves access on their bank's site,
 * the bank redirects here (PLAID_REDIRECT_URI); we re-open Link with the same
 * link token and the received URI so Link can finish the connection.
 */
import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

export default function OAuthReturn() {
  const [token, setToken] = useState<string | null>(null);
  const [msg, setMsg] = useState("Finishing connection…");

  useEffect(() => {
    let t: string | null = null;
    try { t = sessionStorage.getItem("ledger.linkToken"); } catch { /* */ }
    if (t) setToken(t);
    else setMsg("This link session expired. Go back to the dashboard and click Link institution again.");
  }, []);

  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri: typeof window === "undefined" ? undefined : window.location.href,
    onSuccess: async (public_token) => {
      setMsg("Linking…");
      const r = await fetch("/api/plaid/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_token }) });
      const j = await r.json();
      try { sessionStorage.removeItem("ledger.linkToken"); } catch { /* */ }
      if (r.ok) location.replace("/"); else setMsg(j.error ?? "Could not link this institution.");
    },
    onExit: (err) => { setMsg(err ? `Link closed: ${err.display_message ?? err.error_message}` : "Cancelled."); },
  });
  useEffect(() => { if (token && ready) open(); }, [token, ready, open]);

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="max-w-sm border border-line px-5 py-4">
        <div className="text-[15px] font-semibold tracking-tight">Ledger</div>
        <p className="mt-2 text-ink-2">{msg}</p>
        <a href="/" className="mt-3 inline-block text-[12px] text-muted underline underline-offset-2">Back to dashboard</a>
      </div>
    </main>
  );
}
