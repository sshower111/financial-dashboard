import type { Transaction } from "../types.ts";
import { daysBetween, median, parseKey, stepCadence } from "./dates.ts";

export interface RecurringStream {
  key: string;
  merchant: string;
  direction: "in" | "out";
  cadenceDays: number;
  /** typical amount (abs, native ccy) */
  amount: number;
  lastAmount: number;
  currency: string;
  lastDate: string;
  nextDate: string;
  /** day-of-month the stream usually lands on (monthly+ cadences) */
  anchorDay: number;
  occurrences: Transaction[];
}

export const merchantKey = (t: Pick<Transaction, "cleaned_merchant_name" | "raw_merchant_string">) =>
  (t.cleaned_merchant_name || t.raw_merchant_string)
    .toLowerCase()
    .replace(/[#*]\s*\d+/g, "")
    .replace(/\d{4,}/g, "")
    .replace(/[^a-z& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const CADENCES = [7, 14, 15, 30, 91, 365];

/** Find merchant streams that repeat on a regular cadence (weekly → yearly). */
export function detectRecurring(txns: Transaction[], today: string): RecurringStream[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.is_pending || t.category === "Transfer") continue;
    const k = `${merchantKey(t)}|${t.amount < 0 ? "in" : "out"}|${t.iso_currency_code}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: RecurringStream[] = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const gaps = list.slice(1).map((t, i) => daysBetween(list[i].date, t.date)).filter((g) => g > 0);
    if (gaps.length < 2) continue;
    const g = median(gaps);
    const cadence = CADENCES.find((c) => Math.abs(g - c) <= Math.max(2, c * 0.12));
    if (!cadence) continue;
    const regular = gaps.filter((x) => Math.abs(x - cadence) <= Math.max(3, cadence * 0.2)).length;
    if (regular / gaps.length < 0.7) continue;
    const amounts = list.map((t) => Math.abs(t.amount));
    const typical = median(amounts);
    // Short cadences need more evidence and tighter amounts, otherwise a favourite
    // restaurant looks like a weekly bill. Monthly bills may vary (utilities) and
    // tolerate a price change at the tail.
    const short = cadence <= 15;
    if (short && list.length < 4) continue;
    const tol = short ? 0.15 : 0.35, need = short ? 0.8 : 0.6;
    if (amounts.filter((a) => Math.abs(a - typical) <= typical * tol).length / amounts.length < need) continue;
    const last = list[list.length - 1];
    // stale streams (cancelled subscription, old employer) are dropped
    if (daysBetween(last.date, today) > cadence * 1.6 + 3) continue;
    const anchorDay = median(list.slice(-3).map((t) => parseKey(t.date).getUTCDate()));
    let next = stepCadence(last.date, cadence, anchorDay);
    while (next < today) next = stepCadence(next, cadence, anchorDay);
    out.push({
      key, merchant: last.cleaned_merchant_name || last.raw_merchant_string,
      direction: last.amount < 0 ? "in" : "out", cadenceDays: cadence,
      amount: typical, lastAmount: Math.abs(last.amount), currency: last.iso_currency_code,
      lastDate: last.date, nextDate: next, anchorDay, occurrences: list,
    });
  }
  return out.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
}
