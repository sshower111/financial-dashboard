"use client";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useDerived } from "@/store/derived";
import { useLedger } from "@/store/ledger";
import { DEFAULT_DASHBOARD } from "@/lib/finance/scope";
import { CATEGORIES, type Budget } from "@/lib/types";
import { money, pct } from "@/lib/format";
import { saveBudget, deleteBudget } from "@/lib/persist";

function Bar({ used, progress, over }: { used: number; progress: number; over: boolean }) {
  return (
    <div className="relative h-1.5 w-full bg-sunk" role="presentation">
      <div className={`absolute inset-y-0 left-0 ${over ? "bg-accent" : "bg-ink"}`} style={{ width: `${Math.min(100, used * 100)}%` }} />
      <div className="absolute -top-1 -bottom-1 w-px bg-ink-2" style={{ left: `${progress * 100}%` }} title="Today" />
    </div>
  );
}

export function Pacing() {
  const d = useDerived();
  const data = useLedger((s) => s.data);
  const dashboard = useLedger((s) => s.dashboard);
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState<string>("Dining");
  const [limit, setLimit] = useState("");
  if (!d || !data) return null;
  const p = d.pacing;
  const mine = data.budgets.filter((b) => (b.dashboard ?? DEFAULT_DASHBOARD) === dashboard);
  const unused = CATEGORIES.filter((c) => c !== "Income" && c !== "Transfer" && !mine.some((b) => b.category === c));

  async function add() {
    const v = Number(limit);
    if (!(v > 0)) return;
    const b: Budget = { id: crypto.randomUUID(), category: cat, monthly_limit: v, currency: d!.base, dashboard };
    await saveBudget(b);
    useLedger.getState().setBudgets([...data!.budgets, b]);
    setAdding(false); setLimit("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-2 border-b border-line px-3 py-2.5">
        <span className="label">Day <span className="num">{p.day}/{p.daysInMonth}</span> · {pct(p.monthProgress)} of month elapsed</span>
        <span className={`num text-[12px] ${p.total.status === "over" ? "text-accent" : ""}`}>{p.total.velocity.toFixed(2)}× pace</span>
        <div className="col-span-2"><Bar used={p.total.used} progress={p.monthProgress} over={p.total.status === "over"} /></div>
      </div>
      <table className="tbl text-[12px]">
        <thead><tr><th>Category</th><th className="hidden w-[30%] @md:table-cell" /><th className="r">Spent / limit</th><th className="r">Pace</th><th className="w-6" /></tr></thead>
        <tbody>
          {p.rows.map((r) => {
            const b = mine.find((x) => x.category === r.category)!;
            return (
              <tr key={r.category} className="group">
                <td>{r.category}</td>
                <td className="hidden @md:table-cell"><Bar used={r.used} progress={p.monthProgress} over={r.status === "over"} /></td>
                <td className="r num"><span className="whitespace-nowrap">{money(r.spent, { dp: 0 })}</span> <span className="whitespace-nowrap text-muted">/ {money(r.limit, { dp: 0 })}</span></td>
                <td className={`r num ${r.status === "over" ? "text-accent" : r.status === "under" ? "text-muted" : ""}`}>{r.velocity.toFixed(2)}×</td>
                <td className="r"><button className="text-muted opacity-0 group-hover:opacity-100 hover:text-accent" title="Remove budget" onClick={async () => { await deleteBudget(b.id); useLedger.getState().setBudgets(data.budgets.filter((x) => x.id !== b.id)); }}><X size={12} /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-auto border-t border-line px-3 py-2">
        {adding ? (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <select className="h-7 border border-line bg-bg px-1.5" value={cat} onChange={(e) => setCat(e.target.value)}>
              {unused.map((c) => <option key={c}>{c}</option>)}
            </select>
            <input className="num h-7 w-24 border border-line bg-bg px-2 text-right" inputMode="decimal" placeholder="Limit" value={limit} onChange={(e) => setLimit(e.target.value)} autoFocus />
            <span className="label">{d.base}/mo</span>
            <button className="ml-auto h-7 bg-accent px-3 text-accent-ink" type="submit">Add</button>
            <button className="h-7 px-2 text-muted hover:text-ink" type="button" onClick={() => setAdding(false)}>Cancel</button>
          </form>
        ) : unused.length > 0 && (
          <button className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink" onClick={() => { setCat(unused[0]); setAdding(true); }}><Plus size={12} /> Add budget</button>
        )}
      </div>
    </div>
  );
}
