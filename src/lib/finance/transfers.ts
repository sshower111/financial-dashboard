import type { Account, Transaction } from "../types.ts";
import { daysBetween } from "./dates.ts";

/**
 * Money moving between the user's own accounts (card payments, chequing → savings) is not
 * spending or income. Both legs must be excluded, or a $500 card payment shows up as $500 out
 * of chequing *and* $500 "income" on the card.
 */
export const isTransfer = (t: Transaction) => t.category === "Transfer";

/** Bank wording for card payments / own-account moves (card side and bank side). Interac e-Transfers
 *  are deliberately absent: those usually go to other people and are real spending. */
export const TRANSFER_RE = /payment\s*[-–]?\s*thank|thank you for (your )?payment|payment received|autopay|auto pay|automatic payment|ach pmt|bill pymt|epayment|online (banking )?payment|cr(edi)?t ?(card|crd) (pmt|pymt|payment)|crd (epay|autopay)|online transfer|transfer (to|from)|xfer|\btfr\b|loan pmt|pre-?authorized payment.*(visa|mastercard|amex)/i;

const LIABILITY = new Set(["credit", "loan"]);
const WINDOW_DAYS = 4;

/**
 * Returns the ledger with internal-transfer legs labelled "Transfer" (copies; input untouched):
 *  1. card / loan payments: a credit (amount < 0) on a credit or loan account paired with an equal
 *     outflow from a depository account within 4 days, whatever the AI called either leg;
 *  2. depository ↔ depository moves with equal and opposite amounts within 4 days, when at least
 *     one leg already looks like a transfer (label or bank wording), to avoid pairing e.g. a
 *     paycheque with an unrelated equal-sized payment;
 *  3. card-side payment credits matched by wording even if the paying account isn't linked.
 * Pairing runs over all accounts, so it must happen *before* any scope filter.
 */
export function markTransfers<T extends { accounts: Account[]; transactions: Transaction[] }>(d: T): T {
  const type = new Map(d.accounts.map((a) => [a.id, a.type]));
  const looksTransfer = (t: Transaction) => isTransfer(t) || TRANSFER_RE.test(t.raw_merchant_string);
  const ids = new Map<string, string>(); // id → subcategory

  // index outflows by |amount| (cents, currency) for pairing
  const outs = new Map<string, Transaction[]>();
  for (const t of d.transactions) {
    if (t.amount <= 0) continue;
    const k = `${t.iso_currency_code}|${Math.round(t.amount * 100)}`;
    (outs.get(k) ?? outs.set(k, []).get(k)!).push(t);
  }
  const used = new Set<string>();

  for (const inc of d.transactions) {
    if (inc.amount >= 0) continue;
    const incType = type.get(inc.account_id);
    if (!incType) continue;
    const liab = LIABILITY.has(incType);
    const cands = outs.get(`${inc.iso_currency_code}|${Math.round(-inc.amount * 100)}`) ?? [];
    const match = cands.find((o) => {
      if (used.has(o.id) || o.account_id === inc.account_id || Math.abs(daysBetween(o.date, inc.date)) > WINDOW_DAYS) return false;
      const oType = type.get(o.account_id);
      if (liab) return oType === "depository";
      return oType === "depository" && incType === "depository" && (looksTransfer(o) || looksTransfer(inc));
    });
    if (match) {
      used.add(match.id);
      const sub = liab ? (incType === "credit" ? "Credit card payment" : "Loan payment") : "Between accounts";
      ids.set(inc.id, sub); ids.set(match.id, sub);
    } else if (liab && looksTransfer(inc)) {
      ids.set(inc.id, incType === "credit" ? "Credit card payment" : "Loan payment");
    }
  }

  if (!ids.size) return d;
  return {
    ...d,
    transactions: d.transactions.map((t) => {
      const sub = ids.get(t.id);
      return sub && !isTransfer(t) ? { ...t, category: "Transfer", subcategory: sub } : t;
    }),
  };
}
