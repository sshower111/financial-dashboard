"use client";
import { useLedger } from "@/store/ledger";
import { useDerived, useScopedData } from "@/store/derived";
import { Money } from "../Money";
import type { Account, AccountType } from "@/lib/types";
import { ownerLabels } from "@/lib/finance/scope";
import { saveOwnerLabel } from "@/lib/persist";

/** Person label editor, shown in layout-edit mode. Saves on blur / Enter. */
function OwnerField({ a, labels }: { a: Account; labels: string[] }) {
  const commit = async (raw: string) => {
    const next = raw.trim().slice(0, 40) || null, prev = a.owner_label ?? null;
    if (next === prev) return;
    const s = useLedger.getState();
    s.setOwnerLabel(a.id, next);
    try { await saveOwnerLabel(a.id, next); }
    catch (e) {
      s.setOwnerLabel(a.id, prev);
      s.pushEvent({ kind: "flagged", text: `Couldn't save person label (is migration 0003 applied?): ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  return (
    <input defaultValue={a.owner_label ?? ""} list="owner-labels" placeholder="person" aria-label={`Person for ${a.name}`}
      onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className="mt-0.5 h-5 w-28 border border-line bg-bg px-1 text-[11px] focus:border-ink focus:outline-none" />
  );
}

const ORDER: AccountType[] = ["depository", "investment", "credit", "loan", "other"];
const LABEL: Record<AccountType, string> = { depository: "Cash", investment: "Investments", credit: "Credit", loan: "Loans", other: "Other" };

export function Accounts() {
  const data = useScopedData();
  const d = useDerived();
  const editing = useLedger((s) => s.editing);
  const all = useLedger((s) => s.data?.accounts);
  if (!data || !d) return null;
  const labels = ownerLabels(all ?? data.accounts);
  const inst = new Map(data.institutions.map((i) => [i.id, i]));
  return (
    <table className="tbl tbl-fixed">
      {editing && <caption className="sr-only">Type a person per account to enable the person switcher</caption>}
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
                  <td className="max-w-0"><div className="truncate">{a.name}</div>{util != null && <div className={`num text-[11px] ${util > 0.3 ? "text-accent" : "text-muted"}`}>{(util * 100).toFixed(0)}% utilized</div>}
                    {editing ? <OwnerField key={a.owner_label ?? ""} a={a} labels={labels} /> : a.owner_label && labels.length > 1 && <div className="text-[11px] text-muted">{a.owner_label}</div>}</td>
                  <td className="hidden truncate text-muted sm:table-cell">{inst.get(a.institution_id)?.name} <span className="num text-[11px]">{inst.get(a.institution_id)?.country}</span></td>
                  <td className="r"><Money value={bal} ccy={a.currency} /></td>
                  <td className="r">{rate ? <Money value={bal * rate} /> : <span className="text-accent">no rate</span>}</td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
      {editing && <tfoot><tr><td colSpan={4}><datalist id="owner-labels">{labels.map((l) => <option key={l} value={l} />)}</datalist></td></tr></tfoot>}
    </table>
  );
}
