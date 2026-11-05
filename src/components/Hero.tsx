"use client";
import { Sun, Cloud, CloudLightning } from "lucide-react";
import { useDerived } from "@/store/derived";
import { Money } from "./Money";
import { Sparkline } from "./Sparkline";
import { money, shortDate } from "@/lib/format";
import type { Weather } from "@/lib/finance/forecast";

const WEATHER: Record<Weather, { label: string; Icon: typeof Sun; note: string }> = {
  clear: { label: "Clear", Icon: Sun, note: "Projected cash stays comfortably above zero." },
  overcast: { label: "Overcast", Icon: Cloud, note: "Low point covers under two weeks of spending." },
  storm: { label: "Storm", Icon: CloudLightning, note: "Projected cash dips below zero." },
};

export function Hero() {
  const d = useDerived();
  if (!d) return null;
  const { netWorth: nw, cash, forecast: f, base, history } = d;
  const w = WEATHER[f.weather];
  const nwChange = history.length ? nw.total - history[0].value : 0;
  const ccys = Object.entries(nw.byCurrency);

  return (
    <section className="grid grid-cols-1 border border-line md:grid-cols-[1.4fr_1fr_1fr]" aria-label="Summary">
      {/* Net worth */}
      <div className="flex flex-col gap-3 border-b border-line p-5 md:border-b-0 md:border-r">
        <div className="label">Net worth · {base}</div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="num text-[40px] leading-none font-medium tracking-tight">{money(nw.total)}</div>
          <div className="num pb-1 text-[12px] text-ink-2">{money(nwChange, { sign: true })} <span className="text-muted">90d est.</span></div>
        </div>
        <Sparkline data={history} height={30} />
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
          <span><span className="label mr-1.5">Assets</span><Money value={nw.assets} /></span>
          <span><span className="label mr-1.5">Liabilities</span><Money value={-nw.liabilities} /></span>
          {ccys.map(([c, v]) => (
            <span key={c} title={`Native ${c} before conversion`}><span className="label mr-1.5">{c} native</span><Money value={v.assets - v.liabilities} /></span>
          ))}
        </div>
        {nw.missingFx.length > 0 && <div className="text-[12px] text-accent">Excluded — no FX rate for {nw.missingFx.join(", ")}</div>}
      </div>

      {/* Cash flow */}
      <div className="flex flex-col gap-3 border-b border-line p-5 md:border-b-0 md:border-r">
        <div className="label">Net cash flow · last 30 days</div>
        <div className="num text-[28px] leading-none font-medium">{money(cash.current.net, { sign: true })}</div>
        <div className="num text-[12px] text-ink-2">{money(cash.change, { sign: true })} <span className="text-muted">vs prior 30d</span></div>
        <dl className="mt-auto grid grid-cols-2 gap-y-1 text-[12px]">
          <dt className="label">In</dt><dd className="text-right"><Money value={cash.current.inflow} /></dd>
          <dt className="label">Out</dt><dd className="text-right"><Money value={-cash.current.outflow} /></dd>
        </dl>
      </div>

      {/* Wallet weather */}
      <div className="flex flex-col gap-3 p-5">
        <div className="label">Wallet weather · next 30 days</div>
        <div className={`flex items-center gap-2.5 ${f.weather === "storm" ? "text-accent" : ""}`}>
          <w.Icon size={24} strokeWidth={1.5} />
          <span className="text-[28px] leading-none font-medium">{w.label}</span>
        </div>
        <div className="text-[12px] text-ink-2">{w.note}</div>
        <dl className="mt-auto grid grid-cols-2 gap-y-1 text-[12px]">
          <dt className="label">Low point</dt>
          <dd className="text-right"><Money value={f.min} accent={f.min < 0} /> <span className="num text-muted">{shortDate(f.minDate)}</span></dd>
          <dt className="label">{f.shortfallDate ? "Shortfall" : "Buffer"}</dt>
          <dd className={`num text-right ${f.shortfallDate ? "text-accent" : ""}`}>
            {f.shortfallDate ? shortDate(f.shortfallDate) : Number.isFinite(f.bufferDays) ? `${Math.round(f.bufferDays)} days` : "—"}
          </dd>
        </dl>
      </div>
    </section>
  );
}
