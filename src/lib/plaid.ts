import { Configuration, CountryCode, PlaidApi, PlaidEnvironments } from "plaid";
import { guessDashboard } from "./finance/scope.ts";

let api: PlaidApi | null = null;
export function plaid(): PlaidApi {
  if (api) return api;
  const env = process.env.PLAID_ENV ?? "sandbox";
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) throw new Error("PLAID_CLIENT_ID / PLAID_SECRET missing");
  api = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID, "PLAID-SECRET": process.env.PLAID_SECRET, "Plaid-Version": "2020-09-14" } },
  }));
  return api;
}

/** Plaid Link countries, from PLAID_COUNTRY_CODES (comma-separated). Defaults to US only. */
export function plaidCountries(): CountryCode[] {
  const valid = new Set<string>(Object.values(CountryCode));
  const list = (process.env.PLAID_COUNTRY_CODES ?? "US").split(",").map((c) => c.trim().toUpperCase()).filter((c) => valid.has(c));
  return (list.length ? list : ["US"]) as CountryCode[];
}

export const SUPPORTED_CCY = new Set(["USD", "EUR", "GBP", "CAD"]);
export const ACCOUNT_TYPES = new Set(["depository", "credit", "investment", "loan"]);

/**
 * Put newly linked accounts on a dashboard: Business when Plaid's holder_category (or the account
 * name) says business, else Personal. Only touches accounts without one, so manual moves stick.
 */
export async function assignDashboards(
  db: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any -- service-role SupabaseClient
  accounts: { account_id: string; name: string; official_name?: string | null; holder_category?: string | null }[],
) {
  const byDash = new Map<string, string[]>();
  for (const a of accounts) {
    const d = guessDashboard(a);
    (byDash.get(d) ?? byDash.set(d, []).get(d)!).push(a.account_id);
  }
  for (const [dashboard, ids] of byDash)
    await db.from("accounts").update({ owner_label: dashboard }).in("plaid_account_id", ids).is("owner_label", null).throwOnError();
}
