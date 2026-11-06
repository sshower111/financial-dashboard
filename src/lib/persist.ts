"use client";
import { DEMO_MODE } from "./env";
import { supabaseBrowser } from "./supabase/client";
import type { Budget, Currency } from "./types";
import type { LayoutItem } from "./layout";
import type { Dashboard } from "./finance/scope";

const LS = { layout: "ledger.layout.v1", budgets: "ledger.budgets.v1", owners: "ledger.owners.v2", dashboards: "ledger.dashboards.v2" };
const lsGet = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const layoutKey = (dashboard: string) => (dashboard === "personal" ? LS.layout : `${LS.layout}.${dashboard}`);

/** Layout of one dashboard (falls back to the caller's default when none is saved). */
export async function loadLayout(dashboard: string): Promise<unknown | null> {
  if (DEMO_MODE) return lsGet(layoutKey(dashboard));
  const { data } = await supabaseBrowser().from("dashboard_layouts").select("layout_config").eq("dashboard", dashboard).maybeSingle();
  return data?.layout_config ?? null;
}

export async function saveLayout(dashboard: string, layout: LayoutItem[]) {
  if (DEMO_MODE) return lsSet(layoutKey(dashboard), layout);
  const sb = supabaseBrowser();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.from("dashboard_layouts").upsert({ user_id: user.id, dashboard, layout_config: layout }, { onConflict: "user_id,dashboard" });
}

export function loadDemoBudgets(): Budget[] | null { return lsGet<Budget[]>(LS.budgets); }

export async function saveBudget(b: Budget) {
  if (DEMO_MODE) return lsSet(LS.budgets, [...(lsGet<Budget[]>(LS.budgets) ?? []).filter((x) => x.id !== b.id), b]);
  const { error } = await supabaseBrowser().from("budgets").upsert({ id: b.id, dashboard: b.dashboard ?? "personal", category: b.category, monthly_limit: b.monthly_limit, currency: b.currency }, { onConflict: "user_id,dashboard,category" });
  if (error) throw error;
}

export async function deleteBudget(id: string) {
  if (DEMO_MODE) return lsSet(LS.budgets, (lsGet<Budget[]>(LS.budgets) ?? []).filter((x) => x.id !== id));
  await supabaseBrowser().from("budgets").delete().eq("id", id);
}

export async function saveBaseCurrency(base: Currency) {
  if (DEMO_MODE) return;
  const sb = supabaseBrowser();
  const { data: { user } } = await sb.auth.getUser();
  if (user) await sb.from("user_settings").upsert({ user_id: user.id, base_currency: base });
}

export function loadDemoDashboards(): Dashboard[] | null { return lsGet<Dashboard[]>(LS.dashboards); }

/** Dashboard names / order (user_settings.dashboards, migration 0004). */
export async function saveDashboards(list: Dashboard[]) {
  if (DEMO_MODE) return lsSet(LS.dashboards, list);
  const sb = supabaseBrowser();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const { error } = await sb.from("user_settings").upsert({ user_id: user.id, dashboards: list });
  if (error) throw error;
}

/** Demo mode keeps account → dashboard moves in localStorage: { accountId: dashboard }. */
export function loadDemoOwners(): Record<string, string | null> | null { return lsGet(LS.owners); }

/** Move an account to another dashboard. Live: column-granted update on accounts.owner_label (0003). */
export async function moveAccount(accountId: string, dashboard: string) {
  if (DEMO_MODE) { lsSet(LS.owners, { ...(loadDemoOwners() ?? {}), [accountId]: dashboard }); return; }
  const { error } = await supabaseBrowser().from("accounts").update({ owner_label: dashboard }).eq("id", accountId);
  if (error) throw error;
}
