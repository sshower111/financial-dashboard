"use client";
import { useEffect, useState } from "react";
import { LayoutGrid, Moon, Sun, Check, RotateCcw, LogOut } from "lucide-react";
import { useLedger } from "@/store/ledger";
import { WIDGETS, type WidgetId } from "@/lib/layout";
import { saveBaseCurrency } from "@/lib/persist";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Currency } from "@/lib/types";
import { ConnectBank } from "./ConnectBank";
import { SyncProgress } from "./SyncProgress";
import { ALL, ownerLabels, scopeAccountIds } from "@/lib/finance/scope";

const BASES: Currency[] = ["USD", "EUR", "GBP"];

function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    let t: string | null = null; try { t = localStorage.getItem("ledger.theme"); } catch { /* */ }
    const d = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(d);
  }, []);
  const flip = () => {
    const d = !dark; setDark(d);
    document.documentElement.dataset.theme = d ? "dark" : "light";
    try { localStorage.setItem("ledger.theme", d ? "dark" : "light"); } catch { /* */ }
  };
  return <button onClick={flip} className="grid h-7 w-7 place-items-center border border-line text-ink-2 hover:text-ink" title="Toggle theme" aria-label="Toggle theme">{dark ? <Sun size={13} /> : <Moon size={13} />}</button>;
}

/** Scope switcher: filters every panel (and the assistant) to a person, institution or account. */
function ScopeSelect() {
  const data = useLedger((s) => s.data);
  const scope = useLedger((s) => s.scope);
  if (!data || data.accounts.length < 2) return null;
  const value = scopeAccountIds(data.accounts, scope) ? scope : ALL;
  const people = ownerLabels(data.accounts);
  const insts = data.institutions.filter((i) => data.accounts.some((a) => a.institution_id === i.id));
  const active = value !== ALL;
  return (
    <select value={value} onChange={(e) => useLedger.getState().setScope(e.target.value)} aria-label="Show accounts"
      title="Filter the whole dashboard"
      className={`h-7 max-w-[14rem] border bg-bg px-1.5 text-[12px] ${active ? "border-accent text-accent" : "border-line hover:border-ink"}`}>
      <option value={ALL}>All accounts</option>
      {people.length > 0 && <optgroup label="People">{people.map((p) => <option key={p} value={`person:${p}`}>{p}</option>)}</optgroup>}
      {insts.length > 1 && <optgroup label="Institutions">{insts.map((i) => <option key={i.id} value={`inst:${i.id}`}>{i.name}</option>)}</optgroup>}
      {insts.map((i) => (
        <optgroup key={i.id} label={i.name}>
          {data.accounts.filter((a) => a.institution_id === i.id).map((a) => <option key={a.id} value={`acct:${a.id}`}>{a.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function TopBar() {
  const { base, demo, ai, editing, layout } = useLedger();
  const s = useLedger.getState();
  const hidden = (Object.keys(WIDGETS) as WidgetId[]).filter((w) => !layout.some((l) => l.i === w));

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3">
      <div className="flex items-baseline gap-3">
        <span className="text-[15px] font-semibold tracking-tight">Financial Dashboard</span>
        {demo && <span className="border border-line px-1.5 text-[11px] text-muted">demo data</span>}
      </div>
      {demo && ai.up === false ? (
        // hosted demo: no local model, so the simulator uses the rules categorizer — not an error
        <div className="flex items-center gap-1.5 text-[11px] text-muted" title="No local model here, so transactions are categorized by keyword rules. Run locally with Ollama for LLM categorization and the assistant.">
          <span className="h-1.5 w-1.5 bg-line-strong" />
          <span>AI: rules fallback</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-muted" title={ai.up ? "Local model reachable" : "Ollama not reachable: categorization queues, assistant unavailable"}>
          <span className={`h-1.5 w-1.5 ${ai.up ? "bg-ink" : ai.up === false ? "bg-accent" : "bg-line-strong"}`} />
          <span className="num">{ai.model || "ollama"}</span>
          <span>{ai.up ? "local" : ai.up === false ? "offline" : "…"}</span>
        </div>
      )}

      <SyncProgress />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <ScopeSelect />
        {editing && (
          <>
            {hidden.length > 0 && (
              <select className="h-7 border border-line bg-bg px-1.5 text-[12px]" value="" onChange={(e) => e.target.value && s.addWidget(e.target.value as WidgetId)} aria-label="Add widget">
                <option value="">Add widget…</option>
                {hidden.map((w) => <option key={w} value={w}>{WIDGETS[w].title}</option>)}
              </select>
            )}
            <button onClick={s.resetLayout} className="flex h-7 items-center gap-1.5 border border-line px-2 text-[12px] text-ink-2 hover:text-ink"><RotateCcw size={12} /> Reset</button>
          </>
        )}
        <button onClick={() => s.setEditing(!editing)} className={`flex h-7 items-center gap-1.5 border px-2.5 text-[12px] ${editing ? "border-accent bg-accent text-accent-ink" : "border-line hover:border-ink"}`}>
          {editing ? <><Check size={12} /> Done</> : <><LayoutGrid size={12} /> Edit layout</>}
        </button>
        <div className="flex h-7 border border-line" role="radiogroup" aria-label="Base currency">
          {BASES.map((c) => (
            <button key={c} role="radio" aria-checked={base === c} onClick={() => { s.setBase(c); saveBaseCurrency(c).catch(() => {}); }}
              className={`num px-2 text-[11px] ${base === c ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>{c}</button>
          ))}
        </div>
        <ConnectBank />
        <ThemeToggle />
        {!demo && <button onClick={async () => { await supabaseBrowser().auth.signOut(); location.href = "/login"; }} className="grid h-7 w-7 place-items-center border border-line text-ink-2 hover:text-ink" title="Sign out"><LogOut size={13} /></button>}
      </div>
    </header>
  );
}
