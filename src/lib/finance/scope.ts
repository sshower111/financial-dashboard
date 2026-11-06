import type { Account, Holding, Institution, Transaction } from "../types.ts";

/**
 * Dashboard scope, encoded as a string so it fits a <select> value and localStorage:
 *   "all" | "inst:<institution id>" | "acct:<account id>" | "person:<owner label>"
 */
export type Scope = string;
export const ALL: Scope = "all";

/** Account ids in scope, or null for "everything" (also when the scope no longer matches anything). */
export function scopeAccountIds(accounts: Account[], scope: Scope): Set<string> | null {
  const i = scope.indexOf(":");
  if (scope === ALL || i < 0) return null;
  const kind = scope.slice(0, i), key = scope.slice(i + 1);
  const pick = accounts.filter((a) =>
    kind === "inst" ? a.institution_id === key :
    kind === "acct" ? a.id === key :
    kind === "person" ? (a.owner_label ?? null) === key : false);
  return pick.length ? new Set(pick.map((a) => a.id)) : null;
}

interface Scopable { accounts: Account[]; transactions: Transaction[]; holdings: Holding[] }

/** Keep only accounts / transactions / holdings belonging to `ids` (null = unchanged). */
export function filterByAccounts<T extends Scopable>(d: T, ids: Set<string> | null): T {
  if (!ids) return d;
  return {
    ...d,
    accounts: d.accounts.filter((a) => ids.has(a.id)),
    transactions: d.transactions.filter((t) => ids.has(t.account_id)),
    holdings: d.holdings.filter((h) => ids.has(h.account_id)),
  };
}

export const scopeLedger = <T extends Scopable>(d: T, scope: Scope): T => filterByAccounts(d, scopeAccountIds(d.accounts, scope));

/** Distinct person labels, sorted. */
export const ownerLabels = (accounts: Account[]) =>
  [...new Set(accounts.map((a) => a.owner_label).filter((x): x is string => !!x))].sort();

/** Human label for the current scope (used in the assistant context). */
export function scopeName(scope: Scope, accounts: Account[], institutions: Institution[]): string {
  if (!scopeAccountIds(accounts, scope)) return "All accounts";
  const [kind, key] = [scope.slice(0, scope.indexOf(":")), scope.slice(scope.indexOf(":") + 1)];
  if (kind === "inst") return institutions.find((i) => i.id === key)?.name ?? key;
  if (kind === "acct") return accounts.find((a) => a.id === key)?.name ?? key;
  return key;
}
