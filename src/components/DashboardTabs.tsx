"use client";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useLedger } from "@/store/ledger";
import { DEFAULT_DASHBOARD, dashboardList, dashboardOf, newDashboardId, type Dashboard } from "@/lib/finance/scope";
import { saveDashboards } from "@/lib/persist";

/**
 * Separate dashboards as tabs (Personal | Business | …). Click a tab to open it; click the open tab
 * to rename it; + adds one. An empty dashboard (no accounts) can be deleted while renaming.
 */
export function DashboardTabs() {
  const data = useLedger((s) => s.data);
  const current = useLedger((s) => s.dashboard);
  const [renaming, setRenaming] = useState<string | null>(null);
  const list = data ? dashboardList(data.dashboards, data.accounts) : [];
  const active = list.some((d) => d.id === current) ? current : list[0]?.id ?? DEFAULT_DASHBOARD;
  const activeName = list.find((d) => d.id === active)?.name;

  // a stale id (dashboard deleted elsewhere) falls back to the first tab
  useEffect(() => { if (data && active !== current) useLedger.getState().setDashboard(active); }, [data, active, current]);
  useEffect(() => { if (activeName) document.title = `${activeName} · Financial Dashboard`; }, [activeName]);
  if (!data) return null;

  const s = useLedger.getState();
  const save = (next: Dashboard[]) => {
    const prev = data.dashboards;
    s.setDashboards(next);
    saveDashboards(next).catch((e) => {
      s.setDashboards(prev);
      s.pushEvent({ kind: "flagged", text: `Couldn't save dashboards (is migration 0004 applied?): ${e instanceof Error ? e.message : String(e)}` });
    });
  };
  const rename = (id: string, raw: string) => {
    setRenaming(null);
    const name = raw.trim().slice(0, 40);
    if (name && name !== list.find((d) => d.id === id)?.name) save(list.map((d) => (d.id === id ? { ...d, name } : d)));
  };
  const add = () => {
    const d = { id: newDashboardId(), name: "New dashboard" };
    save([...list, d]);
    s.setDashboard(d.id);
    setRenaming(d.id);
  };
  const remove = (id: string) => {
    setRenaming(null);
    const next = list.filter((d) => d.id !== id);
    save(next);
    s.setDashboard(next[0].id);
  };
  const empty = (id: string) => !data.accounts.some((a) => dashboardOf(a) === id);

  return (
    <nav role="tablist" aria-label="Dashboards" className="flex h-7 items-stretch border border-line text-[12px]">
      {list.map((d) => d.id === renaming ? (
        <span key={d.id} className="flex items-center border-r border-line">
          <input autoFocus defaultValue={d.name} maxLength={40} aria-label="Dashboard name"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => rename(d.id, e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }}
            className="h-full w-36 bg-bg px-2 focus:outline-none" />
          {d.id !== DEFAULT_DASHBOARD && list.length > 1 && empty(d.id) && (
            <button onMouseDown={(e) => { e.preventDefault(); remove(d.id); }} title="Delete this empty dashboard" aria-label="Delete dashboard"
              className="grid h-full w-6 place-items-center text-muted hover:text-accent"><X size={12} /></button>
          )}
        </span>
      ) : (
        <button key={d.id} role="tab" aria-selected={d.id === active}
          onClick={() => (d.id === active ? setRenaming(d.id) : s.setDashboard(d.id))}
          title={d.id === active ? "Click to rename" : `Open ${d.name}`}
          className={`max-w-[12rem] truncate border-r border-line px-2.5 ${d.id === active ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"}`}>
          {d.name}
        </button>
      ))}
      <button onClick={add} title="Add a dashboard" aria-label="Add a dashboard" className="grid w-7 place-items-center text-muted hover:text-ink"><Plus size={12} /></button>
    </nav>
  );
}
