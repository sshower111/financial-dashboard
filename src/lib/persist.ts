"use client";
import { DEMO_MODE } from "./env";
import { supabaseBrowser } from "./supabase/client";
import type { Budget, Currency } from "./types";
import type { LayoutItem } from "./layout";

const LS = { layout: "ledger.layout.v1", budgets: "ledger.budgets.v1" };
const lsGet = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export async function loadLayout(): Promise<unknown | null> {
  if (DEMO_MODE) return lsGet(LS.layout);
  const { data } = await supabaseBrowser().from("dashboard_layouts").select("layout_config").maybeSingle();
  return data?.layout_config ?? null;
}

export async function saveLayout(layout: LayoutItem[]) {
  if (DEMO_MODE) return lsSet(LS.layout, layout);
  const sb = supabaseBrowser();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.from("dashboard_layouts").upsert({ user_id: user.id, layout_config: layout }, { onConflict: "user_id" });
}

export function loadDemoBudgets(): Budget[] | null { return lsGet<Budget[]>(LS.budgets); }

export async function saveBudget(b: Budget) {
  if (DEMO_MODE) return lsSet(LS.budgets, [...(lsGet<Budget[]>(LS.budgets) ?? []).filter((x) => x.id !== b.id), b]);
  const { error } = await supabaseBrowser().from("budgets").upsert({ id: b.id, category: b.category, monthly_limit: b.monthly_limit, currency: b.currency }, { onConflict: "user_id,category" });
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
