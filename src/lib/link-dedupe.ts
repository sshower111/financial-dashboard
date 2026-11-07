/**
 * Re-linking the same bank login in Plaid creates a new item with new account ids, so matching on
 * plaid_account_id can't catch it. Match on what stays the same instead: institution (caller filters),
 * account type + subtype, and the last 4 digits (mask). When either side has no mask yet (accounts
 * linked before migration 0005), fall back to the account name. Each existing account matches at most
 * once, so three cards called "Ultimate Rewards" pair up one to one.
 */
export interface LinkedAccount { name: string; type: string; subtype: string | null; mask: string | null }
export interface IncomingAccount extends LinkedAccount { account_id: string }

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function matchExisting<E extends LinkedAccount>(incoming: IncomingAccount[], existing: E[]): Map<string, E> {
  const used = new Set<E>();
  const out = new Map<string, E>();
  const same = (a: IncomingAccount, e: E) =>
    norm(a.type) === norm(e.type) && norm(a.subtype) === norm(e.subtype) &&
    (a.mask && e.mask ? a.mask === e.mask : norm(a.name) === norm(e.name));
  // mask matches first, so a name-only fallback can't steal an account another one matches exactly
  for (const pass of [true, false])
    for (const a of incoming) {
      if (out.has(a.account_id)) continue;
      const e = existing.find((x) => !used.has(x) && (pass ? !!(a.mask && x.mask) : true) && same(a, x));
      if (e) { used.add(e); out.set(a.account_id, e); }
    }
  return out;
}
