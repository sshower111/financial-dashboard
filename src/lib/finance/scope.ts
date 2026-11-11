import type { Account, Budget, Currency, Holding, Transaction } from "../types.ts";

/**
 * Separate dashboards (e.g. "Personal", "Business", "Rental property"). Each has a stable id and a
 * user-editable name (user_settings.dashboards). Every account belongs to exactly one dashboard via
 * accounts.owner_label = dashboard id; unassigned accounts are on "personal". Budgets and the panel
 * layout are per dashboard too. There is no combined view.
 */
export interface Dashboard {
  id: string; name: string;
  /** base currency for this dashboard's totals; unset = the currency most of its accounts use */
  currency?: Currency;
}

export const DEFAULT_DASHBOARD = "personal";
export const BUSINESS_DASHBOARD = "business";
export const DEFAULT_DASHBOARDS: Dashboard[] = [
  { id: DEFAULT_DASHBOARD, name: "Personal" },
  { id: BUSINESS_DASHBOARD, name: "Business" },
];

export const dashboardOf = (a: Pick<Account, "owner_label">) => a.owner_label?.trim() || DEFAULT_DASHBOARD;

/** Saved dashboards (or the defaults), plus any id found on an account but missing from the list. */
export function dashboardList(saved: Dashboard[] | null | undefined, accounts: Account[]): Dashboard[] {
  const out = (saved?.length ? saved : DEFAULT_DASHBOARDS).filter((d) => d && typeof d.id === "string" && d.id);
  for (const id of accounts.map(dashboardOf)) if (!out.some((d) => d.id === id)) out.push({ id, name: id });
  return out;
}

export const dashboardName = (list: Dashboard[], id: string) => list.find((d) => d.id === id)?.name ?? id;

/**
 * Base currency of a dashboard: the one the user picked for it, else the currency most of its bank
 * and card accounts use (investment accounts are ignored: a CAD brokerage account holding US
 * stocks doesn't make the dashboard USD). USD or CAD only; ties and empty dashboards are USD.
 */
export function dashboardCurrency(list: Dashboard[], accounts: Account[], id: string): "USD" | "CAD" {
  const set = list.find((d) => d.id === id)?.currency;
  if (set === "USD" || set === "CAD") return set;
  const n = { USD: 0, CAD: 0 } as Record<string, number>;
  for (const a of accounts) if (dashboardOf(a) === id && a.is_active !== false && a.type !== "investment" && a.currency in n) n[a.currency]++;
  return n.CAD > n.USD ? "CAD" : "USD";
}

export const newDashboardId = () => `d-${Math.random().toString(36).slice(2, 10)}`;

/** Guess for a newly linked account: Plaid's holder_category, else the bank's account name. */
export function guessDashboard(a: { name: string; official_name?: string | null; holder_category?: string | null }): string {
  if (a.holder_category === "business") return BUSINESS_DASHBOARD;
  if (a.holder_category === "personal") return DEFAULT_DASHBOARD;
  return /\b(bus|business|biz|corp|inc|llc|ltd)\b/i.test(`${a.name} ${a.official_name ?? ""}`) ? BUSINESS_DASHBOARD : DEFAULT_DASHBOARD;
}

interface Scopable { accounts: Account[]; transactions: Transaction[]; holdings: Holding[]; budgets: Budget[] }

/** The ledger as seen from one dashboard. */
export function scopeLedger<T extends Scopable>(d: T, dashboard: string): T {
  const ids = new Set(d.accounts.filter((a) => dashboardOf(a) === dashboard).map((a) => a.id));
  return {
    ...d,
    accounts: d.accounts.filter((a) => ids.has(a.id)),
    transactions: d.transactions.filter((t) => ids.has(t.account_id)),
    holdings: d.holdings.filter((h) => ids.has(h.account_id)),
    budgets: d.budgets.filter((b) => (b.dashboard ?? DEFAULT_DASHBOARD) === dashboard),
  };
}
