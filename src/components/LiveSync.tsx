"use client";
/**
 * Headless: loads the ledger, keeps it live, and persists layout.
 *  - live mode: Supabase Realtime on `transactions` (inserts from the worker's Plaid sync,
 *    updates from its Ollama categorization + anomaly passes)
 *  - demo mode: a simulator that streams raw bank strings through /api/categorize
 */
import { useEffect, useRef } from "react";
import { DASHBOARD_KEY, useLedger } from "@/store/ledger";
import { DEMO_MODE } from "@/lib/env";
import { supabaseBrowser } from "@/lib/supabase/client";
import { demoLedger, loadLedger } from "@/lib/ledger-load";
import { LIVE_SAMPLES, demoBudgets } from "@/lib/demo";
import { loadDemoBudgets, loadDemoDashboards, loadDemoOwners, loadLayout, saveLayout } from "@/lib/persist";
import { DEFAULT_LAYOUT, sanitizeLayout } from "@/lib/layout";
import { detectAnomalies } from "@/lib/finance/anomaly";
import { todayKey } from "@/lib/finance/dates";
import type { Transaction } from "@/lib/types";
import type { AuthChangeEvent, RealtimePostgresChangesPayload, Session } from "@supabase/supabase-js";
import type { CategorizeResult } from "@/lib/ai/categorize";

const norm = (t: Record<string, unknown>): Transaction => ({ ...(t as unknown as Transaction), amount: Number(t.amount), ai_confidence_score: t.ai_confidence_score == null ? null : Number(t.ai_confidence_score), ai_tags: (t.ai_tags as string[]) ?? [] });
const label = (t: Transaction) => t.cleaned_merchant_name ?? t.raw_merchant_string;

export function LiveSync() {
  const layoutLoaded = useRef(false);

  // initial load + layout
  useEffect(() => {
    const s = useLedger.getState();
    useLedger.setState({ demo: DEMO_MODE });
    (async () => {
      try {
        if (DEMO_MODE) {
          const d = demoLedger();
          const owners = loadDemoOwners() ?? {};
          s.setData({ ...d, budgets: loadDemoBudgets() ?? demoBudgets, dashboards: loadDemoDashboards() ?? d.dashboards, accounts: d.accounts.map((a) => (a.id in owners ? { ...a, owner_label: owners[a.id] } : a)) });
        } else {
          s.setData(await loadLedger(supabaseBrowser()));
        }
        // reopen the dashboard this browser had open last
        try { const dash = localStorage.getItem(DASHBOARD_KEY); if (dash) useLedger.setState({ dashboard: dash }); } catch { /* private mode */ }
        const stored = await loadLayout(useLedger.getState().dashboard).catch(() => null);
        s.setLayout(stored == null ? DEFAULT_LAYOUT : sanitizeLayout(stored));
      } catch (e) {
        s.setError(e instanceof Error ? e.message : String(e));
      } finally {
        layoutLoaded.current = true;
      }
    })();
    fetch("/api/health").then((r) => r.json()).then((h) => s.setAi(Boolean(h.ollama), h.model)).catch(() => s.setAi(false, ""));
  }, []);

  // each dashboard has its own layout: load it on switch, persist edits (debounced) under that dashboard
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    return useLedger.subscribe((st, prev) => {
      if (st.dashboard !== prev.dashboard && layoutLoaded.current) {
        layoutLoaded.current = false;
        const dash = st.dashboard;
        loadLayout(dash).catch(() => null).then((stored) => {
          if (useLedger.getState().dashboard === dash) st.setLayout(stored == null ? DEFAULT_LAYOUT : sanitizeLayout(stored));
          layoutLoaded.current = true;
        });
        return;
      }
      if (!layoutLoaded.current || st.layout === prev.layout) return;
      clearTimeout(t);
      const dash = st.dashboard, layout = st.layout;
      t = setTimeout(() => saveLayout(dash, layout).catch(() => {}), 400);
    });
  }, []);

  // live mode: realtime
  useEffect(() => {
    if (DEMO_MODE) return;
    const sb = supabaseBrowser();
    let refetch: ReturnType<typeof setTimeout>;
    let ch: ReturnType<typeof sb.channel> | null = null;
    let cancelled = false;
    // Realtime enforces RLS, so the socket must carry the user's JWT. Subscribing before
    // the session is attached joins as anon and silently receives nothing.
    const { data: authSub } = sb.auth.onAuthStateChange((_e: AuthChangeEvent, session: Session | null) => { sb.realtime.setAuth(session?.access_token ?? null); });
    (async () => {
    const { data: { session } } = await sb.auth.getSession();
    await sb.realtime.setAuth(session?.access_token ?? null);
    if (cancelled) return;
    ch = sb.channel("ledger-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        const s = useLedger.getState();
        if (p.eventType === "DELETE") { s.removeTxn((p.old as { id: string }).id); return; }
        const t = norm(p.new as Record<string, unknown>);
        const prev = s.data?.transactions.find((x) => x.id === t.id);
        s.upsertTxn(t);
        if (p.eventType === "INSERT") s.pushEvent({ kind: "ingested", txnId: t.id, text: `${t.raw_merchant_string} · ${t.iso_currency_code} ${t.amount.toFixed(2)}` });
        else if (prev && !prev.category && t.category) s.pushEvent({ kind: "categorized", txnId: t.id, text: `${label(t)} → ${t.category}${t.subcategory ? ` · ${t.subcategory}` : ""} (${t.ai_confidence_score?.toFixed(2) ?? "–"})` });
        else if (prev && !prev.is_anomaly && t.is_anomaly) s.pushEvent({ kind: "flagged", txnId: t.id, text: `${label(t)} · ${(t.ai_tags.find((x) => x.startsWith("anomaly:")) ?? "anomaly").replace("anomaly:", "")}` });
        // balances move with new transactions — refresh them shortly after a burst
        clearTimeout(refetch);
        refetch = setTimeout(async () => {
          const d = await loadLedger(sb).catch(() => null);
          const cur = useLedger.getState().data;
          if (d && cur) useLedger.setState({ data: { ...cur, accounts: d.accounts, holdings: d.holdings } });
        }, 3000);
      })
      .subscribe((status: string) => { if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") console.warn("realtime:", status); });
    })();
    return () => { cancelled = true; clearTimeout(refetch); authSub.subscription.unsubscribe(); if (ch) sb.removeChannel(ch); };
  }, []);

  // demo mode: simulator
  useEffect(() => {
    if (!DEMO_MODE) return;
    let n = 0, stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(() => !stopped && fn(), ms));

    const tick = () => {
      const s = useLedger.getState();
      if (!s.data) return later(1000, tick);
      n++;
      // every 5th event re-charges the previous transaction to exercise duplicate detection
      const last = s.data.transactions[0];
      const dup = n % 5 === 0 && last?.id.startsWith("live-");
      const sample = LIVE_SAMPLES[Math.floor(Math.random() * LIVE_SAMPLES.length)];
      const amount = dup ? last.amount : Math.round((sample.min + Math.random() * (sample.max - sample.min)) * 100) / 100;
      const t: Transaction = {
        id: `live-${Date.now()}`, account_id: dup ? last.account_id : sample.acct, amount, iso_currency_code: dup ? last.iso_currency_code : sample.ccy ?? "USD",
        date: todayKey(), raw_merchant_string: dup ? last.raw_merchant_string : sample.raw, cleaned_merchant_name: null, category: null, subcategory: null,
        ai_confidence_score: null, ai_tags: [], is_anomaly: false, is_pending: false, created_at: new Date().toISOString(),
      };
      s.upsertTxn(t);
      s.patchAccountBalance(t.account_id, t.amount);
      s.pushEvent({ kind: "ingested", txnId: t.id, text: `${t.raw_merchant_string} · ${t.iso_currency_code} ${t.amount.toFixed(2)}` });

      later(600, async () => {
        let r: CategorizeResult | undefined;
        try {
          const res = await fetch("/api/categorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id: t.id, raw: t.raw_merchant_string, amount: t.amount, currency: t.iso_currency_code }] }) });
          r = (await res.json()).results?.[0];
        } catch { /* offline */ }
        if (!r || stopped) return;
        const st = useLedger.getState();
        const done: Transaction = { ...t, cleaned_merchant_name: r.merchant, category: r.category, subcategory: r.subcategory, ai_confidence_score: r.confidence, ai_tags: r.tags };
        st.upsertTxn(done);
        st.pushEvent({ kind: "categorized", txnId: t.id, text: `${r.merchant} → ${r.category}${r.subcategory ? ` · ${r.subcategory}` : ""} (${r.source} ${r.confidence.toFixed(2)})` });
        const hit = detectAnomalies(st.data!.transactions).find((a) => a.transactionId === t.id);
        if (hit) {
          st.upsertTxn({ ...done, is_anomaly: true, ai_tags: [...done.ai_tags, `anomaly:${hit.kind}`] });
          st.pushEvent({ kind: "flagged", txnId: t.id, text: hit.title });
        }
      });
      later(9000 + Math.random() * 6000, tick);
    };
    later(2500, tick);
    return () => { stopped = true; timers.forEach(clearTimeout); };
  }, []);

  return null;
}
