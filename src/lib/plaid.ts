import { Configuration, CountryCode, PlaidApi, PlaidEnvironments } from "plaid";

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

