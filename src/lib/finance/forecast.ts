import { isTransfer } from "./transfers.ts";
import type { Account, FxTable, Transaction } from "../types.ts";
import { convert } from "./fx.ts";
import { addDays, stepCadence, todayKey } from "./dates.ts";
import { detectRecurring, merchantKey, type RecurringStream } from "./recurring.ts";

export type Weather = "clear" | "overcast" | "storm";

export interface ForecastEvent { date: string; label: string; amount: number; kind: "income" | "bill" | "liability" }

export interface Forecast {
  start: number;
  end: number;
  min: number;
  minDate: string;
  /** first day the projected balance goes negative, or null within the horizon */
  shortfallDate: string | null;
  dailyBurn: number;
  /** min balance ÷ daily burn: how many days of discretionary spend the low point still covers */
  bufferDays: number;
  weather: Weather;
  series: { date: string; balance: number }[];
  events: ForecastEvent[];
  streams: RecurringStream[];
}

export interface ForecastOptions {
  horizon?: number;
  /** assume today's revolving card balances are paid from cash this many days out */
  cardDueInDays?: number;
  burnWindowDays?: number;
  now?: Date;
}

const LIQUID = new Set(["checking", "savings", "cash management", "prepaid", "money market", "paypal"]);

export function forecastCash(accounts: Account[], txns: Transaction[], fx: FxTable, opts: ForecastOptions = {}): Forecast {
  const horizon = opts.horizon ?? 30, cardDue = opts.cardDueInDays ?? 21, burnWindow = opts.burnWindowDays ?? 60;
  const today = todayKey(opts.now);
  const safe = (v: number, c: string) => { try { return convert(v, c, fx); } catch { return 0; } };

  const liquid = accounts.filter((a) => a.is_active && a.type === "depository" && (LIQUID.has(a.subtype) || !a.subtype));
  const start = liquid.reduce((s, a) => s + safe(a.available_balance ?? a.current_balance ?? 0, a.currency), 0);

  const streams = detectRecurring(txns, today);
  const recurringKeys = new Set(streams.map((s) => merchantKey(s.occurrences[0])));

  // discretionary burn: average daily outflow that is NOT a recurring bill, transfer or income
  const from = addDays(today, -burnWindow);
  let discretionary = 0;
  for (const t of txns) {
    if (t.date < from || t.date > today || t.amount <= 0 || isTransfer(t)) continue;
    if (recurringKeys.has(merchantKey(t))) continue;
    discretionary += safe(t.amount, t.iso_currency_code);
  }
  const dailyBurn = discretionary / burnWindow;

  const events: ForecastEvent[] = [];
  const end = addDays(today, horizon);
  for (const s of streams) {
    for (let d = s.nextDate; d <= end; d = stepCadence(d, s.cadenceDays, s.anchorDay)) {
      if (d <= today) continue;
      const amt = safe(s.direction === "in" ? s.amount : s.lastAmount, s.currency);
      events.push({ date: d, label: s.merchant, amount: s.direction === "in" ? amt : -amt, kind: s.direction === "in" ? "income" : "bill" });
    }
  }
  const cardBal = accounts.filter((a) => a.is_active && a.type === "credit")
    .reduce((s, a) => s + Math.max(0, safe(a.current_balance ?? 0, a.currency)), 0);
  if (cardBal > 0 && cardDue <= horizon) {
    events.push({ date: addDays(today, cardDue), label: "Card balances (assumed due)", amount: -cardBal, kind: "liability" });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));

  const byDate = new Map<string, number>();
  for (const e of events) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);

  const series: Forecast["series"] = [{ date: today, balance: start }];
  let bal = start, min = start, minDate = today, shortfallDate: string | null = null;
  for (let i = 1; i <= horizon; i++) {
    const d = addDays(today, i);
    bal += (byDate.get(d) ?? 0) - dailyBurn;
    series.push({ date: d, balance: bal });
    if (bal < min) { min = bal; minDate = d; }
    if (bal < 0 && !shortfallDate) shortfallDate = d;
  }
  const bufferDays = dailyBurn > 0 ? Math.max(0, min) / dailyBurn : Infinity;
  const weather: Weather = min < 0 ? "storm" : bufferDays < 14 ? "overcast" : "clear";
  return { start, end: bal, min, minDate, shortfallDate, dailyBurn, bufferDays, weather, series, events, streams };
}
