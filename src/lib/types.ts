export type Currency = "CAD" | "USD" | "EUR" | "GBP";
export type AccountType = "depository" | "credit" | "investment" | "loan" | "other";

export interface Institution {
  id: string;
  name: string;
  country: "US" | "CA";
}

export interface Account {
  id: string;
  institution_id: string;
  name: string;
  type: AccountType;
  subtype: string;
  currency: Currency;
  current_balance: number | null;
  available_balance: number | null;
  limit_amount: number | null;
  is_active: boolean;
}

/** Plaid sign convention: amount > 0 is money leaving the account. */
export interface Transaction {
  id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string;
  date: string; // YYYY-MM-DD
  raw_merchant_string: string;
  cleaned_merchant_name: string | null;
  category: string | null;
  subcategory: string | null;
  ai_confidence_score: number | null;
  ai_tags: string[];
  is_anomaly: boolean;
  is_pending: boolean;
  created_at: string;
}

export interface Holding {
  id: string;
  account_id: string;
  security_id: string;
  ticker: string;
  name: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  currency: string;
}

export interface Budget {
  id: string;
  category: string;
  monthly_limit: number;
  currency: Currency;
}

/** rates[X] = units of base currency per 1 X. rates[base] = 1. */
export type FxTable = Record<string, number>;

export const CATEGORIES = [
  "Income",
  "Transfer",
  "Housing",
  "Utilities",
  "Groceries",
  "Dining",
  "Transport",
  "Shopping",
  "Subscriptions",
  "Health",
  "Travel",
  "Entertainment",
  "Fees",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];
