import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

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

export const SUPPORTED_CCY = new Set(["CAD", "USD", "EUR", "GBP"]);
export const ACCOUNT_TYPES = new Set(["depository", "credit", "investment", "loan"]);
