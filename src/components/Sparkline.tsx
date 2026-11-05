"use client";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

/** Inline, axis-free trend line. Monochrome. */
export function Sparkline({ data, height = 28 }: { data: { value: number }[]; height?: number }) {
  if (data.length < 2) return null;
  return (
    <div style={{ height }} className="w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line type="monotone" dataKey="value" stroke="var(--ink)" strokeWidth={1.25} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
