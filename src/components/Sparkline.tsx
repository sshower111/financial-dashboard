"use client";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

/** Inline, axis-free trend line. Monochrome. */
export function Sparkline({ data, height = 28 }: { data: { value: number }[]; height?: number }) {
  if (data.length < 2) return null;
  return (
    <div style={{ height }} className="w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        {/* margins leave room for the hover dot (r=3 + stroke) so it is never clipped at the edges */}
        <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line type="monotone" dataKey="value" stroke="var(--ink)" strokeWidth={1.25} dot={false} activeDot={{ r: 3, strokeWidth: 1 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
