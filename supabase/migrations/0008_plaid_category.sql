-- Plaid's own category for each transaction (personal_finance_category), stored so the worker can
-- label most rows without the local model: detailed code, e.g. FOOD_AND_DRINK_FAST_FOOD, plus
-- Plaid's confidence (VERY_HIGH / HIGH / MEDIUM / LOW / UNKNOWN). Written by the service role only
-- (clients have no insert/update grant on these columns).
alter table public.transactions
  add column if not exists plaid_category text,
  add column if not exists plaid_category_confidence text;
