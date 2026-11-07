"use client";
import { useDerived, useScopedData } from "@/store/derived";
import { Money } from "../Money";
import { Empty } from "../Panel";

export function Holdings() {
  const data = useScopedData();
  const d = useDerived();
  if (!data || !d) return null;
  if (!data.holdings.length) return <Empty>No brokerage holdings linked.</Empty>;
  const rows = data.holdings.map((h) => ({ ...h, base: h.institution_value * (d.fx[h.currency] ?? 0) })).sort((a, b) => b.base - a.base);
  const total = rows.reduce((s, r) => s + r.base, 0);
  return (
    <table className="tbl">
      <thead><tr><th>Ticker</th><th className="r hidden @md:table-cell">Qty</th><th className="r hidden @lg:table-cell">Price</th><th className="r">Value</th><th className="r">Weight</th></tr></thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.id}>
            <td className="max-w-0"><div className="num">{h.ticker}</div><div className="wrap text-[11px] text-muted">{h.name}</div></td>
            <td className="r num hidden @md:table-cell">{h.quantity.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
            <td className="r hidden @lg:table-cell"><Money value={h.institution_price} ccy={h.currency} /></td>
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
