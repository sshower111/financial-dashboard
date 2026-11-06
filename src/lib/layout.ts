export type WidgetId = "accounts" | "forecast" | "pacing" | "feed" | "anomalies" | "holdings" | "spending" | "copilot" | "recurring";

export interface LayoutItem { i: WidgetId; w: 3 | 4 | 6 | 8 | 12; h: 1 | 2 | 3 | 4 }

export const WIDGETS: Record<WidgetId, { title: string; minW: LayoutItem["w"] }> = {
  feed: { title: "Live activity", minW: 4 },
  forecast: { title: "30-day cash forecast", minW: 4 },
  pacing: { title: "Budget pacing", minW: 4 },
  copilot: { title: "Assistant", minW: 4 },
  anomalies: { title: "Leakage & anomalies", minW: 3 },
  accounts: { title: "Accounts", minW: 4 },
  holdings: { title: "Holdings", minW: 4 },
  spending: { title: "Spending by category", minW: 3 },
  recurring: { title: "Recurring", minW: 3 },
};

export const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "feed", w: 8, h: 3 },
  { i: "anomalies", w: 4, h: 3 },
  { i: "forecast", w: 8, h: 2 },
  { i: "pacing", w: 4, h: 2 },
  { i: "copilot", w: 6, h: 3 },
  { i: "accounts", w: 6, h: 3 },
  { i: "holdings", w: 6, h: 2 },
  { i: "spending", w: 3, h: 2 },
  { i: "recurring", w: 3, h: 2 },
];

export const WIDTHS: LayoutItem["w"][] = [3, 4, 6, 8, 12];

/** Validate a stored layout: drop unknown widgets/duplicates, clamp sizes. */
export function sanitizeLayout(raw: unknown): LayoutItem[] {
  if (!Array.isArray(raw)) return DEFAULT_LAYOUT;
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const { i, w, h } = it as Partial<LayoutItem>;
    if (!i || !(i in WIDGETS) || seen.has(i)) continue;
    seen.add(i);
    out.push({ i, w: WIDTHS.includes(w as LayoutItem["w"]) ? (w as LayoutItem["w"]) : 6, h: ([1, 2, 3, 4] as const).includes(h as 1) ? (h as LayoutItem["h"]) : 2 });
  }
  return out.length || (raw as unknown[]).length === 0 ? out : DEFAULT_LAYOUT;
}
