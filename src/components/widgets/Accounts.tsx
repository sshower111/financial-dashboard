"use client";
import { useLedger } from "@/store/ledger";
import { useDerived, useScopedData } from "@/store/derived";
import { Money } from "../Money";
import type { Account, AccountType, Institution } from "@/lib/types";
import { matchExisting } from "@/lib/link-dedupe";
import { dashboardList, dashboardOf, type Dashboard } from "@/lib/finance/scope";
import { moveAccount, renameAccount } from "@/lib/persist";
import { accountLabel } from "@/lib/format";
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
      s.pushEvent({ kind: "flagged", text: `Couldn't move ${accountLabel(a)}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  return (
    <label className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">Move to
      <select value={cur} onChange={(e) => move(e.target.value)} aria-label={`Dashboard for ${accountLabel(a)}`}
        className="h-5 w-full min-w-0 max-w-[10rem] border border-line bg-bg px-1 text-[11px] text-ink-2 focus:border-ink focus:outline-none">
        {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
  );
}

/** Rename an account (shown in layout-edit mode). Saves on Enter / leaving the field; empty = bank's name. */
function Rename({ a }: { a: Account }) {
  const [v, setV] = useState(a.nickname ?? "");
  const save = async () => {
    const next = v.trim().slice(0, 60) || null, prev = a.nickname ?? null;
    if (next === prev) return;
    const s = useLedger.getState();
    s.setNickname(a.id, next);
    try { await renameAccount(a.id, next); }
    catch (e) {
      s.setNickname(a.id, prev); setV(prev ?? "");
      s.pushEvent({ kind: "flagged", text: `Couldn't rename ${accountLabel(a)}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(a.nickname ?? ""); } }}
      placeholder={accountLabel({ ...a, nickname: null })} maxLength={60} aria-label={`Name for ${accountLabel(a)}`}
      className="h-6 w-full min-w-0 border border-line bg-bg px-1 text-[12px] text-ink focus:border-ink focus:outline-none" />
  );
}

/**
 * Every bank connection, oldest first, with a two-step Remove (disconnects at Plaid, deletes its data).
 * A connection is flagged only when its accounts overlap an EARLIER connection to the same bank, so the
 * original is never flagged, and two different logins at the same bank aren't either.
 */
function LinkedBanks() {
  const data = useLedger((s) => s.data);
  const demo = useLedger((s) => s.demo);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return null;
  const accts = (id: string) => data.accounts.filter((a) => a.institution_id === id);
  const bank = (i: Institution) => i.plaid_institution_id ?? i.name;
  const when = (i?: Institution) => (i?.created_at ? i.created_at.slice(0, 16).replace("T", " ") : "");
  /** earlier connection this one duplicates, and how many of its accounts overlap */
  const dupeOf = (i: Institution, idx: number) => {
    const mine = accts(i.id).map((a) => ({ ...a, account_id: a.id, mask: a.mask ?? null, subtype: a.subtype ?? null }));
    for (const prev of data.institutions.slice(0, idx)) {
      if (bank(prev) !== bank(i)) continue;
      const n = matchExisting(mine, accts(prev.id).map((a) => ({ ...a, mask: a.mask ?? null, subtype: a.subtype ?? null }))).size;
      if (n > 0) return { prev, n };
    }
    return null;
  };
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
      {data.institutions.map((i, idx) => {
        const n = accts(i.id).length, dup = dupeOf(i, idx);
        const only = !data.institutions.some((o) => o.id !== i.id && bank(o) === bank(i));
        return (
          <div key={i.id} className="border-b border-line py-1.5 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="wrap text-ink">{i.name}</span>
              <span className="num text-[11px] text-muted">{n} acct{n === 1 ? "" : "s"}{i.created_at ? ` · linked ${when(i)}` : ""}</span>
              <span className="ml-auto">
                {demo ? <span className="text-muted" title="Not available with demo data">Remove…</span>
                  : busy === i.id ? <span className="text-muted">Removing…</span>
                  : confirm !== i.id && <button onClick={() => setConfirm(i.id)} className="text-muted hover:text-accent">Remove…</button>}
              </span>
            </div>
            {dup && (
              <div className="wrap text-[11px] text-accent">
                Duplicate: {dup.n} of {n} accounts are already in the connection linked {when(dup.prev)}. Safe to remove this one.
              </div>
            )}
            {confirm === i.id && (
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
                <span className="wrap text-ink-2">
                  {only
                    ? `This is your only ${i.name} connection. Removing it deletes its ${n} accounts and their transaction history from this app.`
                    : `Remove this ${i.name} connection and its ${n} accounts + transactions?`}
                </span>
                <button onClick={() => remove(i.id)} className="text-accent hover:underline">Remove</button>
                <button onClick={() => setConfirm(null)} className="text-muted hover:text-ink">Cancel</button>
              </div>
            )}
          </div>
        );
      })}
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
    {/* auto layout with a greedy first column: the account name takes every pixel the other columns
        don't need, so the table always fills the panel (a fixed layout left a gap on the right) */}
    <table className="tbl">
      <thead><tr><th className="w-full">Account</th><th className="hidden min-w-52 @xl:table-cell">Institution</th><th className="r hidden min-w-28 @md:table-cell">Native</th><th className="r min-w-24">{d.base}</th></tr></thead>
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
                  <td>{editing ? <Rename a={a} /> : <div className="wrap" title={a.nickname ? accountLabel({ ...a, nickname: null }) : undefined}>{accountLabel(a)}</div>}{util != null && <div className={`num text-[11px] ${util > 0.3 ? "text-accent" : "text-muted"}`}>{(util * 100).toFixed(0)}% utilized</div>}
                    {editing && dashboards.length > 1 && <MoveTo a={a} list={dashboards} />}</td>
                  <td className="hidden wrap text-muted @xl:table-cell">{inst.get(a.institution_id)?.name} <span className="num text-[11px]">{inst.get(a.institution_id)?.country}</span></td>
                  <td className="r hidden @md:table-cell"><Money value={bal} ccy={a.currency} /></td>
                  <td className="r">{rate ? <Money value={bal * rate} /> : <span className="text-accent">no rate</span>}</td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
    {editing && <LinkedBanks />}
    </>
  );
}
