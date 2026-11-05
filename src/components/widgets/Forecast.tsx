"use client";
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDerived } from "@/store/derived";
import { money, shortDate } from "@/lib/format";
import { Money } from "../Money";

export function Forecast() {
  const d = useDerived();
  if (!d) return null;
  const f = d.forecast;
  const upcoming = f.events.slice(0, 8);
  const hi = Math.max(...f.series.map((p) => p.balance));
  const pad = Math.max(1, (hi - f.min) * 0.15);
  const domain: [number, number] = [f.min < 0 ? f.min - pad : Math.max(0, f.min - pad), hi + pad];
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[1fr_260px]">
      <div className="min-h-40 p-3 pb-1">
        <div className="mb-1 flex gap-5 text-[12px]">
          <span><span className="label mr-1.5">Today</span><Money value={f.start} /></span>
          <span><span className="label mr-1.5">Day 30</span><Money value={f.end} /></span>
          <span><span className="label mr-1.5">Burn/day</span><Money value={f.dailyBurn} /></span>
        </div>
        <ResponsiveContainer width="100%" height="88%">
          <AreaChart data={f.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={{ stroke: "var(--line)" }} tickLine={false} interval={6} />
            <YAxis domain={domain} allowDataOverflow tickFormatter={(v: number) => money(v, { compact: true })} tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--font-mono)" }} axisLine={false} tickLine={false} width={44} />
            <Tooltip
              cursor={{ stroke: "var(--line-strong)" }}
              contentStyle={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 0, fontFamily: "var(--font-mono)", fontSize: 11 }}
              labelFormatter={(l) => shortDate(String(l))}
              formatter={(v) => [money(Number(v)), d.base]}
            />
            {f.min < 0 && <ReferenceLine y={0} stroke="var(--accent)" strokeDasharray="3 3" />}
            <Area type="stepAfter" dataKey="balance" stroke="var(--ink)" strokeWidth={1.25} fill="var(--ink)" fillOpacity={0.04} baseValue={domain[0]} isAnimationActive={false} />
            <ReferenceDot x={f.minDate} y={f.min} r={3} fill={f.min < 0 ? "var(--accent)" : "var(--ink)"} stroke="none" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="border-t border-line md:border-t-0 md:border-l">
        <div className="label border-b border-line px-3 py-2">Scheduled</div>
        <table className="tbl tbl-fixed text-[12px]">
          <tbody>
            {upcoming.map((e, i) => (
              <tr key={i}>
                <td className="num w-16 whitespace-nowrap text-muted">{shortDate(e.date)}</td>
                <td className="truncate" title={e.label}>{e.label}</td>
                <td className="r w-24"><Money value={e.amount} sign accent={e.kind === "liability"} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
