"use client";
import { useLedger } from "@/store/ledger";
import { useDerived, useScopedData } from "@/store/derived";
import { Money } from "../Money";
import type { Account, AccountType } from "@/lib/types";
import { dashboardList, dashboardOf, type Dashboard } from "@/lib/finance/scope";
import { moveAccount } from "@/lib/persist";
import { useState } from "react";
import { loadLedger } from "@/lib/ledger-load";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Move an account to another dashboard (shown in layout-edit mode). */
function MoveTo({ a, list }: { a: Account; list: Dashboard[] }) {
  const cur = dashboardOf(a);
  const move = async (to: string) => {
    if (to === cur) return;
    const s = useLedger.getState(), prev = a.owner_label ?? null;
    s.setOwnerLabel(a.id, to);
    try { await moveAccount(a.id, to); }
    catch (e) {
      s.setOwnerLabel(a.id, prev);
      s.pushEvent({ kind: "flagged", text: `Couldn't move ${a.name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  return (
    <label className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">Move to
      <select value={cur} onChange={(e) => move(e.target.value)} aria-label={`Dashboard for ${a.name}`}
        className="h-5 max-w-[10rem] border border-line bg-bg px-1 text-[11px] text-ink-2 focus:border-ink focus:outline-none">
        {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
  );
}

/** Every bank connection, oldest first, with a two-step Remove (disconnects at Plaid, deletes its data). */
function LinkedBanks() {
  const data = useLedger((s) => s.data);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return null;
  const count = (id: string) => data.accounts.filter((a) => a.institution_id === id).length;
  const sameName = (name: string) => data.institutions.filter((i) => i.name === name).length > 1;
  const remove = async (id: string) => {
    setBusy(id); setConfirm(null);
    const s = useLedger.getState();
    try {
      const r = await fetch("/api/plaid/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ institution_id: id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      s.setData(await loadLedger(supabaseBrowser()));
      s.pushEvent({ kind: "synced", text: `Removed ${j.institution}${j.plaidRemoved ? "" : " (was already disconnected at Plaid)"}` });
    } catch (e) {
      s.pushEvent({ kind: "flagged", text: `Couldn't remove bank: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(null); }
  };
  return (
    <div className="border-t border-line px-3 py-2 text-[12px]">
      <div className="label mb-1">Linked banks (all dashboards)</div>
      {data.institutions.map((i) => (
        <div key={i.id} className="flex flex-wrap items-baseline gap-x-2 py-1">
          <span className="text-ink">{i.name}</span>
          <span className="num text-[11px] text-muted">{count(i.id)} acct{count(i.id) === 1 ? "" : "s"}{i.created_at ? ` · linked ${i.created_at.slice(0, 16).replace("T", " ")}` : ""}</span>
          {sameName(i.name) && <span className="text-[11px] text-accent">possible duplicate</span>}
          <span className="ml-auto flex gap-2">
            {busy === i.id ? <span className="text-muted">Removing…</span> : confirm === i.id ? (
              <>
                <span className="text-muted">Remove {i.name} and its {count(i.id)} accounts + transactions?</span>
                <button onClick={() => remove(i.id)} className="text-accent hover:underline">Remove</button>
                <button onClick={() => setConfirm(null)} className="text-muted hover:text-ink">Cancel</button>
              </>
            ) : <button onClick={() => setConfirm(i.id)} className="text-muted hover:text-accent">Remove…</button>}
          </span>
        </div>
      ))}
    </div>
  );
}

const ORDER: AccountType[] = ["depository", "investment", "credit", "loan", "other"];
const LABEL: Record<AccountType, string> = { depository: "Cash", investment: "Investments", credit: "Credit", loan: "Loans", other: "Other" };

export function Accounts() {
  const data = useScopedData();
  const d = useDerived();
  const editing = useLedger((s) => s.editing);
  const demo = useLedger((s) => s.demo);
  const all = useLedger((s) => s.data);
  if (!data || !d || !all) return null;
  const dashboards = dashboardList(all.dashboards, all.accounts);
  const inst = new Map(data.institutions.map((i) => [i.id, i]));
  return (
    <>
    <table className="tbl tbl-fixed">
      <thead><tr><th>Account</th><th className="hidden w-[28%] sm:table-cell">Institution</th><th className="r w-32">Native</th><th className="r w-28">{d.base}</th></tr></thead>
      {ORDER.map((type) => {
        const list = data.accounts.filter((a) => a.type === type);
        if (!list.length) return null;
        const liab = type === "credit" || type === "loan";
        return (
          <tbody key={type}>
            <tr><td colSpan={3} className="label !pt-3">{LABEL[type]}</td><td className="r !pt-3"><Money value={(liab ? -1 : 1) * d.netWorth.byType[type]} className="text-ink-2" /></td></tr>
            {list.map((a) => {
              const bal = (a.current_balance ?? 0) * (liab ? -1 : 1);
              const rate = d.fx[a.currency];
              const util = liab && a.limit_amount ? (a.current_balance ?? 0) / a.limit_amount : null;
              return (
                <tr key={a.id}>
                  <td className="max-w-0"><div className="wrap">{a.name}</div>{util != null && <div className={`num text-[11px] ${util > 0.3 ? "text-accent" : "text-muted"}`}>{(util * 100).toFixed(0)}% utilized</div>}
                    {editing && dashboards.length > 1 && <MoveTo a={a} list={dashboards} />}</td>
                  <td className="hidden wrap text-muted sm:table-cell">{inst.get(a.institution_id)?.name} <span className="num text-[11px]">{inst.get(a.institution_id)?.country}</span></td>
                  <td className="r"><Money value={bal} ccy={a.currency} /></td>
                  <td className="r">{rate ? <Money value={bal * rate} /> : <span className="text-accent">no rate</span>}</td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
    {editing && !demo && <LinkedBanks />}
    </>
  );
}
