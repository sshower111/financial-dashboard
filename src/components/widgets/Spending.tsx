"use client";
import { useMemo } from "react";
import { useLedger } from "@/store/ledger";
import { useDerived } from "@/store/derived";
import { spendByCategory } from "@/lib/finance/cashflow";
import { addDays, todayKey } from "@/lib/finance/dates";
import { money } from "@/lib/format";

export function Spending() {
  const data = useLedger((s) => s.data);
  const d = useDerived();
  const rows = useMemo(() => {
    if (!data || !d) return [];
    const t = todayKey();
    const cur = spendByCategory(data.transactions, d.fx, addDays(t, -29), t);
    const prev = new Map(spendByCategory(data.transactions, d.fx, addDays(t, -59), addDays(t, -30)).map((r) => [r.category, r.amount]));
    return cur.map((r) => ({ ...r, prev: prev.get(r.category) ?? 0 }));
  }, [data, d]);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.amount, r.prev)));
  return (
    <table className="tbl text-[12px]">
      <thead><tr><th>30 days</th><th className="r">{d?.base}</th><th className="r">Δ</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const delta = r.amount - r.prev;
          return (
            <tr key={r.category}>
              <td className="max-w-0">
                <div className="truncate">{r.category}</div>
                <div className="relative mt-1 h-1 bg-sunk">
                  <div className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${(r.amount / max) * 100}%` }} />
                  <div className="absolute -top-0.5 -bottom-0.5 w-px bg-muted" style={{ left: `${(r.prev / max) * 100}%` }} title="Prior 30 days" />
                </div>
              </td>
              <td className="r num">{money(r.amount, { dp: 0 })}</td>
              <td className={`r num ${r.prev > 0 && delta / r.prev > 0.25 ? "text-accent" : "text-muted"}`}>{money(delta, { dp: 0, sign: true })}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
