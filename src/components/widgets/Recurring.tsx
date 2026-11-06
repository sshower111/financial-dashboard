"use client";
import { useDerived } from "@/store/derived";
import { Money } from "../Money";
import { shortDate } from "@/lib/format";

const cadence = (d: number) => (d === 7 ? "weekly" : d <= 15 ? "biweekly" : d === 30 ? "monthly" : d === 91 ? "quarterly" : "yearly");

export function Recurring() {
  const d = useDerived();
  if (!d) return null;
  const streams = d.forecast.streams;
  return (
    <table className="tbl tbl-fixed text-[12px]">
      <thead><tr><th className="w-16">Next</th><th>Stream</th><th className="r w-28">Amount</th></tr></thead>
      <tbody>
        {streams.map((s) => (
          <tr key={s.key}>
            <td className="num w-14 text-muted">{shortDate(s.nextDate)}</td>
            <td className="max-w-0"><div className="wrap">{s.merchant}</div><div className="text-[11px] text-muted">{cadence(s.cadenceDays)}</div></td>
            <td className="r"><Money value={s.direction === "in" ? s.amount : -s.lastAmount} ccy={s.currency} sign /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
