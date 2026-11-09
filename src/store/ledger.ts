"use client";
import { create } from "zustand";
import type { Budget, Currency, Transaction } from "@/lib/types";
import type { LedgerData } from "@/lib/ledger-load";
import type { Dashboard } from "@/lib/finance/scope";
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutItem, type WidgetId } from "@/lib/layout";

export type FeedEventKind = "ingested" | "categorized" | "flagged" | "synced";
export interface FeedEvent { id: string; kind: FeedEventKind; at: string; txnId?: string; text: string }

interface State {
  status: "loading" | "ready" | "error";
  error?: string;
  demo: boolean;
  data: LedgerData | null;
  base: Currency;
  layout: LayoutItem[];
  editing: boolean;
  events: FeedEvent[];
  ai: { up: boolean | null; model: string };
  /** ids whose row should animate in */
  fresh: Set<string>;
  /** id of the open dashboard: see lib/finance/scope.ts (remembered per browser) */
  dashboard: string;

  setData: (d: LedgerData) => void;
  setError: (e: string) => void;
  setBase: (c: Currency) => void;
  setAi: (up: boolean, model: string) => void;
  upsertTxn: (t: Transaction) => void;
  removeTxn: (id: string) => void;
  patchAccountBalance: (accountId: string, delta: number) => void;
  setBudgets: (b: Budget[]) => void;
  setDashboard: (id: string) => void;
  /** replace the dashboard list (names / order); caller persists it */
  setDashboards: (list: Dashboard[]) => void;
  setOwnerLabel: (accountId: string, label: string | null) => void;
  setNickname: (accountId: string, nickname: string | null) => void;
  pushEvent: (e: Omit<FeedEvent, "id" | "at"> & { at?: string }) => void;

  setLayout: (l: LayoutItem[]) => void;
  setEditing: (v: boolean) => void;
  moveWidget: (from: WidgetId, to: WidgetId) => void;
  resizeWidget: (id: WidgetId, patch: Partial<Pick<LayoutItem, "w" | "h">>) => void;
  removeWidget: (id: WidgetId) => void;
  addWidget: (id: WidgetId) => void;
  resetLayout: () => void;
}

let evSeq = 0;
export const DASHBOARD_KEY = "ledger.dashboard.v2";

export const useLedger = create<State>((set) => ({
  status: "loading",
  demo: true,
  data: null,
  base: "USD",
  layout: DEFAULT_LAYOUT,
  editing: false,
  events: [],
  ai: { up: null, model: "" },
  fresh: new Set(),
  dashboard: "personal",

  setData: (data) => set({ data, status: "ready", base: data.base }),
  setError: (error) => set({ status: "error", error }),
  setBase: (base) => set({ base }),
  setAi: (up, model) => set({ ai: { up, model } }),
  upsertTxn: (t) => set((s) => {
    if (!s.data) return s;
    const i = s.data.transactions.findIndex((x) => x.id === t.id);
    const transactions = [...s.data.transactions];
    const fresh = new Set(s.fresh);
    if (i >= 0) transactions[i] = t;
    else {
      // keep newest-first by date, then arrival time (historical backfills land in place)
      const at = transactions.findIndex((x) => x.date < t.date || (x.date === t.date && x.created_at <= t.created_at));
      transactions.splice(at < 0 ? transactions.length : at, 0, t);
      fresh.add(t.id);
    }
    return { data: { ...s.data, transactions }, fresh };
  }),
  removeTxn: (id) => set((s) => (s.data ? { data: { ...s.data, transactions: s.data.transactions.filter((t) => t.id !== id) } } : s)),
  patchAccountBalance: (accountId, delta) => set((s) => {
    if (!s.data) return s;
    return { data: { ...s.data, accounts: s.data.accounts.map((a) => {
      if (a.id !== accountId || a.current_balance == null) return a;
      // Plaid sign: +amount on a credit card raises the balance owed; on cash it lowers it
      const d = a.type === "credit" || a.type === "loan" ? delta : -delta;
      return { ...a, current_balance: Math.round((a.current_balance + d) * 100) / 100, available_balance: a.available_balance == null ? null : Math.round((a.available_balance - delta) * 100) / 100 };
    }) } };
  }),
  setDashboard: (dashboard) => { try { localStorage.setItem(DASHBOARD_KEY, dashboard); } catch { /* private mode */ } set({ dashboard }); },
  setDashboards: (dashboards) => set((s) => (s.data ? { data: { ...s.data, dashboards } } : s)),
  setOwnerLabel: (accountId, label) => set((s) => (s.data ? { data: { ...s.data, accounts: s.data.accounts.map((a) => (a.id === accountId ? { ...a, owner_label: label } : a)) } } : s)),
  setNickname: (accountId, nickname) => set((s) => (s.data ? { data: { ...s.data, accounts: s.data.accounts.map((a) => (a.id === accountId ? { ...a, nickname } : a)) } } : s)),
  setBudgets: (budgets) => set((s) => (s.data ? { data: { ...s.data, budgets } } : s)),
  pushEvent: (e) => set((s) => ({ events: [{ ...e, id: `ev-${++evSeq}`, at: e.at ?? new Date().toISOString() }, ...s.events].slice(0, 60) })),

  setLayout: (layout) => set({ layout: sanitizeLayout(layout) }),
  setEditing: (editing) => set({ editing }),
  moveWidget: (from, to) => set((s) => {
    const l = [...s.layout];
    const a = l.findIndex((x) => x.i === from), b = l.findIndex((x) => x.i === to);
    if (a < 0 || b < 0 || a === b) return s;
    const [it] = l.splice(a, 1);
    l.splice(b, 0, it);
    return { layout: l };
  }),
  resizeWidget: (id, patch) => set((s) => ({ layout: s.layout.map((x) => (x.i === id ? { ...x, ...patch } : x)) })),
  removeWidget: (id) => set((s) => ({ layout: s.layout.filter((x) => x.i !== id) })),
  addWidget: (id) => set((s) => (s.layout.some((x) => x.i === id) ? s : { layout: [...s.layout, DEFAULT_LAYOUT.find((d) => d.i === id) ?? { i: id, w: 6, h: 2 }] })),
  resetLayout: () => set({ layout: DEFAULT_LAYOUT }),
}));
