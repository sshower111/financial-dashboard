"use client";
import { useDerived } from "@/store/derived";
import { Money } from "../Money";
import { Empty } from "../Panel";
import { shortDate } from "@/lib/format";

const KIND: Record<string, string> = { duplicate: "Duplicate", price_hike: "Price hike", fee: "Fee", unusual_amount: "Spike" };

export function Anomalies() {
  const d = useDerived();
  if (!d) return null;
  if (!d.anomalies.length) return <Empty>No leakage detected in the last 45 days.</Empty>;
  const total = d.anomalies.reduce((s, a) => { try { return s + a.amount * (d.fx[a.currency] ?? 0); } catch { return s; } }, 0);
  return (
    <div>
      <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <span className="label">{d.anomalies.length} open · at stake</span>
        <Money value={total} ccy={d.base} accent />
      </div>
      <ul>
        {d.anomalies.map((a) => (
          <li key={`${a.transactionId}-${a.kind}`} className="grid grid-cols-[auto_1fr_auto] gap-x-3 border-b border-line px-3 py-2.5 last:border-0">
            <span className={`num mt-0.5 text-[11px] ${a.severity === 3 ? "text-accent" : "text-muted"}`}>{"■".repeat(a.severity)}<span className="opacity-25">{"■".repeat(3 - a.severity)}</span></span>
            <div className="min-w-0">
              <div className="truncate">{a.title.split(" · ")[1] ?? a.title}</div>
              <div className="truncate text-[12px] text-muted"><span className="text-ink-2">{KIND[a.kind]}</span> · {a.detail}</div>
            </div>
            <div className="text-right">
              <Money value={a.amount} ccy={a.currency} />
              <div className="num text-[11px] text-muted">{shortDate(a.date)}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
