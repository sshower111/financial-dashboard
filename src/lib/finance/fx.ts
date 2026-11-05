import type { Currency, FxTable } from "../types.ts";

export interface FxRow { base: string; quote: string; rate: number }

/**
 * Build a lookup of "units of `target` per 1 unit of X" from stored pairs.
 * Pairs are used directly, inverted, or bridged through one intermediate.
 */
export function buildFxTable(rows: FxRow[], target: Currency): FxTable {
  const direct = new Map<string, number>();
  for (const r of rows) {
    if (!(r.rate > 0)) continue;
    direct.set(`${r.base}>${r.quote}`, r.rate);
    direct.set(`${r.quote}>${r.base}`, 1 / r.rate);
  }
  const ccys = new Set<string>([target]);
  for (const r of rows) { ccys.add(r.base); ccys.add(r.quote); }
  const table: FxTable = { [target]: 1 };
  for (const c of ccys) {
    if (c === target) continue;
    const d = direct.get(`${c}>${target}`);
    if (d) { table[c] = d; continue; }
    for (const mid of ccys) {
      const a = direct.get(`${c}>${mid}`), b = direct.get(`${mid}>${target}`);
      if (a && b) { table[c] = a * b; break; }
    }
  }
  return table;
}

/** Convert; throws on a missing rate rather than silently treating it as 1:1. */
export function convert(amount: number, from: string, fx: FxTable): number {
  const r = fx[from];
  if (r === undefined) throw new Error(`No FX rate for ${from}`);
  return amount * r;
}
