import { isTransfer } from "./transfers.ts";
import type { Transaction } from "../types.ts";
import { addDays, daysBetween, median, todayKey } from "./dates.ts";
import { detectRecurring, merchantKey } from "./recurring.ts";

export type AnomalyKind = "duplicate" | "price_hike" | "fee" | "unusual_amount";

export interface Anomaly {
  transactionId: string;
  kind: AnomalyKind;
  title: string;
  detail: string;
  date: string;
  amount: number;
  currency: string;
  severity: 1 | 2 | 3;
}

const FEE_RE = /\b(fee|nsf|overdraft|od charge|interest charge|service charge|foreign (txn|transaction)|fx fee|late payment|atm withdrawal fee|monthly plan)\b/i;
const fmt = (n: number, c: string) => `${c} ${n.toFixed(2)}`;

/** Scan a ledger for leakage: duplicate charges, subscription hikes, fees and spikes. */
export function detectAnomalies(txns: Transaction[], opts: { lookbackDays?: number; now?: Date } = {}): Anomaly[] {
  const today = todayKey(opts.now);
  const since = addDays(today, -(opts.lookbackDays ?? 45));
  const out: Anomaly[] = [];
  const flagged = new Set<string>();
  const push = (a: Anomaly) => { const k = `${a.transactionId}|${a.kind}`; if (!flagged.has(k)) { flagged.add(k); out.push(a); } };
  // card payments / own-account moves are never "leakage" (and repeat on purpose)
  const settled = txns.filter((t) => !t.is_pending && !isTransfer(t));

  // 1. duplicates: same account + merchant + amount within 1 day
  const byKey = new Map<string, Transaction[]>();
  for (const t of settled) {
    if (t.amount <= 0) continue;
    const k = `${t.account_id}|${merchantKey(t)}|${t.amount.toFixed(2)}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const t = list[i];
      if (t.date < since || daysBetween(list[i - 1].date, t.date) > 1) continue;
      push({ transactionId: t.id, kind: "duplicate", title: `Possible duplicate · ${t.cleaned_merchant_name ?? t.raw_merchant_string}`,
        detail: `Same amount charged on ${list[i - 1].date} and ${t.date}`, date: t.date, amount: t.amount, currency: t.iso_currency_code, severity: 3 });
    }
  }

  // 2. subscription / bill hikes on recurring streams
  for (const s of detectRecurring(settled, today)) {
    if (s.direction !== "out" || s.lastDate < since) continue;
    const prior = s.occurrences.slice(0, -1).map((t) => t.amount);
    const base = median(prior);
    // only fixed-price streams (subscriptions, plans) — variable bills like hydro are expected to move
    if (Math.max(...prior) > Math.min(...prior) * 1.03) continue;
    const last = s.occurrences[s.occurrences.length - 1];
    if (last.amount > base * 1.08 && last.amount - base >= 1) {
      const pct = ((last.amount / base - 1) * 100).toFixed(0);
      push({ transactionId: last.id, kind: "price_hike", title: `Price increase · ${s.merchant}`,
        detail: `${fmt(base, s.currency)} → ${fmt(last.amount, s.currency)} (+${pct}%)`, date: last.date, amount: last.amount, currency: s.currency, severity: 2 });
    }
  }

  // 3. fees
  for (const t of settled) {
    if (t.date < since || t.amount <= 0) continue;
    if (t.category === "Fees" || FEE_RE.test(t.raw_merchant_string)) {
      push({ transactionId: t.id, kind: "fee", title: `Fee charged · ${t.cleaned_merchant_name ?? t.raw_merchant_string}`,
        detail: "Bank or service fee — often avoidable or refundable on request", date: t.date, amount: t.amount, currency: t.iso_currency_code, severity: 2 });
    }
  }

  // 4. unusual amount vs merchant history
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of settled) if (t.amount > 0) (byMerchant.get(merchantKey(t)) ?? byMerchant.set(merchantKey(t), []).get(merchantKey(t))!).push(t);
  for (const list of byMerchant.values()) {
    if (list.length < 5) continue;
    for (const t of list) {
      if (t.date < since) continue;
      const m = median(list.filter((x) => x.id !== t.id).map((x) => x.amount));
      if (t.amount > m * 3.5 && t.amount > 50) {
        push({ transactionId: t.id, kind: "unusual_amount", title: `Unusual amount · ${t.cleaned_merchant_name ?? t.raw_merchant_string}`,
          detail: `${(t.amount / m).toFixed(1)}× the usual ${fmt(m, t.iso_currency_code)}`, date: t.date, amount: t.amount, currency: t.iso_currency_code, severity: 1 });
      }
    }
  }
  return out.sort((a, b) => b.severity - a.severity || (a.date < b.date ? 1 : -1));
}
