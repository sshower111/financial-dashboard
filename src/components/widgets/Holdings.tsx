"use client";
import { useLedger } from "@/store/ledger";
import { useDerived } from "@/store/derived";
import { Money } from "../Money";
import { Empty } from "../Panel";

export function Holdings() {
  const data = useLedger((s) => s.data);
  const d = useDerived();
  if (!data || !d) return null;
  if (!data.holdings.length) return <Empty>No brokerage holdings linked.</Empty>;
  const rows = data.holdings.map((h) => ({ ...h, base: h.institution_value * (d.fx[h.currency] ?? 0) })).sort((a, b) => b.base - a.base);
  const total = rows.reduce((s, r) => s + r.base, 0);
  return (
    <table className="tbl">
      <thead><tr><th>Ticker</th><th className="r">Qty</th><th className="r hidden sm:table-cell">Price</th><th className="r">Value</th><th className="r">Weight</th></tr></thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.id}>
            <td className="max-w-0"><div className="num">{h.ticker}</div><div className="truncate text-[11px] text-muted">{h.name}</div></td>
            <td className="r num">{h.quantity.toLocaleString("en-CA", { maximumFractionDigits: 4 })}</td>
            <td className="r hidden sm:table-cell"><Money value={h.institution_price} ccy={h.currency} /></td>
            <td className="r"><Money value={h.institution_value} ccy={h.currency} /></td>
            <td className="r">
              <div className="flex items-center justify-end gap-2">
                <div className="h-1 w-12 bg-sunk"><div className="h-full bg-ink" style={{ width: `${(h.base / total) * 100}%` }} /></div>
                <span className="num w-10 text-right">{((h.base / total) * 100).toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
