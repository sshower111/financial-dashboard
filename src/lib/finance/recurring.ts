import { isTransfer, leavesCash } from "./transfers.ts";
import type { Transaction } from "../types.ts";
import { daysBetween, median, parseKey, stepCadence } from "./dates.ts";
import { merchantKey as rawKey } from "../ai/merchant.ts";

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
  /** a transfer out of cash (investment contribution, loan payment), not spending */
  transfer?: boolean;
}

const norm = (s: string) => s
  .toLowerCase()
  .replace(/[#*]\s*\d+/g, "")
  .replace(/\d{4,}/g, "")
  .replace(/[^a-z& ]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/**
 * Grouping key for "same merchant". Built from the bank's own text (stable across every charge),
 * not the AI-cleaned name, which can vary per row ("Long View Syste" / blank, "Costco" / "Costco
 * Wholesale") and split one paycheque stream into groups too small to detect. The cleaned name is
 * only the fallback when the bank text has nothing stable left (all digits / reference codes).
 */
export const merchantKey = (t: Pick<Transaction, "cleaned_merchant_name" | "raw_merchant_string">) =>
  rawKey(t.raw_merchant_string) || norm(t.cleaned_merchant_name || t.raw_merchant_string);

const CADENCES = [7, 14, 15, 30, 91, 365];

/** Find merchant streams that repeat on a regular cadence (weekly → yearly). */
export function detectRecurring(txns: Transaction[], today: string): RecurringStream[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txns) {
    // transfers are skipped, except ones that take money out of cash (investment contributions)
    if (t.is_pending || (isTransfer(t) && !leavesCash(t))) continue;
    const k = `${merchantKey(t)}|${t.amount < 0 ? "in" : "out"}|${t.iso_currency_code}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: RecurringStream[] = [];
  for (const [key, all] of groups) {
    // a fixed amount on a schedule (CAD 750 every 14 days) also counts when one-off payments to the
    // same place sit in between: retry with only the most common exact amount
    const s = evaluate(key, all, today) ?? evaluate(key, modalAmount(all), today);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
}

/** The occurrences that share the most common exact amount (empty unless at least 4 do). */
function modalAmount(list: Transaction[]): Transaction[] {
  const by = new Map<number, Transaction[]>();
  for (const t of list) { const c = Math.round(Math.abs(t.amount) * 100); (by.get(c) ?? by.set(c, []).get(c)!).push(t); }
  const best = [...by.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  return best.length >= 4 && best.length < list.length ? best : [];
}

function evaluate(key: string, input: Transaction[], today: string): RecurringStream | null {
  if (input.length < 3) return null;
  const list = [...input].sort((a, b) => (a.date < b.date ? -1 : 1));
  const gaps = list.slice(1).map((t, i) => daysBetween(list[i].date, t.date)).filter((g) => g > 0);
  if (gaps.length < 2) return null;
  const g = median(gaps);
  const cadence = CADENCES.find((c) => Math.abs(g - c) <= Math.max(2, c * 0.12));
  if (!cadence) return null;
  const regular = gaps.filter((x) => Math.abs(x - cadence) <= Math.max(3, cadence * 0.2)).length;
  if (regular / gaps.length < 0.7) return null;
  // amount stability is judged on the latest 8: a raise or old overtime shouldn't hide a paycheque
  const amounts = list.slice(-8).map((t) => Math.abs(t.amount));
  const typical = median(amounts);
  // Short cadences need more evidence and tighter amounts, otherwise a favourite
  // restaurant looks like a weekly bill. Monthly bills may vary (utilities) and
  // tolerate a price change at the tail.
  const short = cadence <= 15;
  if (short && list.length < 4) return null;
  const tol = short ? 0.15 : 0.35, need = short ? 0.8 : 0.6;
  if (amounts.filter((a) => Math.abs(a - typical) <= typical * tol).length / amounts.length < need) return null;
  const last = list[list.length - 1];
  // stale streams (cancelled subscription, old employer) are dropped
  if (daysBetween(last.date, today) > cadence * 1.6 + 3) return null;
  const anchorDay = median(list.slice(-3).map((t) => parseKey(t.date).getUTCDate()));
  let next = stepCadence(last.date, cadence, anchorDay);
  while (next < today) next = stepCadence(next, cadence, anchorDay);
  return {
    key, merchant: last.cleaned_merchant_name || last.raw_merchant_string,
    direction: last.amount < 0 ? "in" : "out", cadenceDays: cadence,
    amount: typical, lastAmount: Math.abs(last.amount), currency: last.iso_currency_code,
    lastDate: last.date, nextDate: next, anchorDay, occurrences: list,
    ...(isTransfer(last) ? { transfer: true } : {}),
  };
}
