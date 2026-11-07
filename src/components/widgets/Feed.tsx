"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { useLedger } from "@/store/ledger";
import { useDerived, useScopedData } from "@/store/derived";
import { Money } from "../Money";
import { clock, shortDate } from "@/lib/format";
import { Empty } from "../Panel";

export function Feed() {
  const data = useScopedData();
  const allEvents = useLedger((s) => s.events);
  // pipeline events tied to a transaction show on that transaction's dashboard; general events everywhere
  const events = useMemo(() => {
    if (!data) return allEvents;
    const ids = new Set(data.transactions.map((t) => t.id));
    return allEvents.filter((e) => !e.txnId || ids.has(e.txnId));
  }, [allEvents, data]);
  const d = useDerived();
  const flagged = useMemo(() => new Set(d?.anomalies.map((a) => a.transactionId)), [d]);
  const acct = useMemo(() => new Map(data?.accounts.map((a) => [a.id, a.name])), [data]);
  const [order, setOrder] = useState<"new" | "old">("new");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filtered = useMemo(() => {
    const list = (data?.transactions ?? []).filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
    // the store keeps newest-first (date, then arrival); oldest-first is the exact reverse
    return order === "new" ? list : [...list].reverse();
  }, [data, from, to, order]);
  if (!data) return null;
  if (!data.transactions.length) return <Empty>No transactions yet. Link an institution to start the feed.</Empty>;
  const LIMIT = 200;
  const rows = filtered.slice(0, LIMIT);
  const ctl = "h-6 border border-line bg-bg px-1 text-[11px] text-ink-2 focus:border-ink focus:outline-none";

  return (
    <div className="flex h-full flex-col">
      <ol className="num shrink-0 border-b border-line bg-sunk px-3 py-1.5 text-[11px] text-ink-2" aria-live="polite" aria-label="Pipeline events">
        <AnimatePresence initial={false}>
          {events.slice(0, 3).map((e) => (
            <motion.li key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="flex gap-3 wrap">
              <span className="text-muted">{clock(e.at)}</span>
              <span className={`w-20 shrink-0 ${e.kind === "flagged" ? "text-accent" : ""}`}>{e.kind}</span>
              <span className="wrap font-sans">{e.text}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {!events.length && <li className="text-muted">Listening for new transactions…</li>}
      </ol>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-muted">
        <select value={order} onChange={(e) => setOrder(e.target.value as "new" | "old")} className={ctl} aria-label="Sort by date">
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
        </select>
        <label className="flex items-center gap-1">From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={`num ${ctl} ${from ? "!border-accent" : ""}`} /></label>
        <label className="flex items-center gap-1">To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`num ${ctl} ${to ? "!border-accent" : ""}`} /></label>
        {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} className="hover:text-ink">Clear</button>}
        <span className="num ml-auto">{filtered.length > LIMIT ? `${LIMIT} of ${filtered.length}` : filtered.length} txns</span>
      </div>
      {!rows.length && <Empty>No transactions in this date range.</Empty>}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        <table className="tbl tbl-fixed">
          <thead><tr><th className="w-16">Date</th><th>Merchant</th><th className="hidden w-[30%] @2xl:table-cell">Category</th><th className="hidden w-[20%] @4xl:table-cell">Account</th><th className="r w-32">Amount</th></tr></thead>
          <tbody>
            <AnimatePresence initial={false}>
              {rows.map((t) => {
                const queued = !t.category;
                const anomaly = t.is_anomaly || flagged.has(t.id);
                return (
                  <motion.tr key={t.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                    <td className="num text-muted">{shortDate(t.date)}</td>
                    <td className="max-w-0">
                      <div className="flex items-center gap-2">
                        {anomaly && <span className="h-1.5 w-1.5 shrink-0 bg-accent" title="Flagged by anomaly scan" />}
                        <span className="wrap">{t.cleaned_merchant_name ?? t.raw_merchant_string}</span>
                        {t.is_pending && <span className="label shrink-0">pending</span>}
                      </div>
                      {(queued || t.cleaned_merchant_name !== t.raw_merchant_string) && (
                        <div className="num wrap text-[11px] text-muted">{t.raw_merchant_string}</div>
                      )}
                    </td>
                    <td className="hidden wrap text-ink-2 @2xl:table-cell">
                      {queued ? <span className="num text-[11px] text-muted">queued for AI…</span> : (
                        <span>{t.category}{t.subcategory ? <span className="text-muted"> · {t.subcategory}</span> : null}
                          {t.ai_confidence_score != null && <span className="num ml-2 text-[11px] text-muted">{t.ai_confidence_score.toFixed(2)}</span>}
                        </span>
                      )}
                    </td>
                    <td className="hidden wrap text-muted @4xl:table-cell">{acct.get(t.account_id)}</td>
                    <td className="r"><Money value={-t.amount} ccy={t.iso_currency_code} sign /></td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
    </div>
  );
}
