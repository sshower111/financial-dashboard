"use client";
import { useLedger } from "@/store/ledger";
import { useDerived } from "@/store/derived";
import { Money } from "../Money";
import type { AccountType } from "@/lib/types";

const ORDER: AccountType[] = ["depository", "investment", "credit", "loan", "other"];
const LABEL: Record<AccountType, string> = { depository: "Cash", investment: "Investments", credit: "Credit", loan: "Loans", other: "Other" };

export function Accounts() {
  const data = useLedger((s) => s.data);
  const d = useDerived();
  if (!data || !d) return null;
  const inst = new Map(data.institutions.map((i) => [i.id, i]));
  return (
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
                  <td className="max-w-0"><div className="truncate">{a.name}</div>{util != null && <div className={`num text-[11px] ${util > 0.3 ? "text-accent" : "text-muted"}`}>{(util * 100).toFixed(0)}% utilized</div>}</td>
                  <td className="hidden truncate text-muted sm:table-cell">{inst.get(a.institution_id)?.name} <span className="num text-[11px]">{inst.get(a.institution_id)?.country}</span></td>
                  <td className="r"><Money value={bal} ccy={a.currency} /></td>
                  <td className="r">{rate ? <Money value={bal * rate} /> : <span className="text-accent">no rate</span>}</td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
  );
}
