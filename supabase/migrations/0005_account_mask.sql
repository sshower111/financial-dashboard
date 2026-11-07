-- 0005: last 4 digits of each account (Plaid `mask`), used to detect re-linking the same bank login
-- so it isn't imported twice.
--
-- Security: written only by the service role (worker / Plaid exchange route). Clients keep their
-- existing read access to accounts and gain no new write access: their column-level update grant
-- is still (is_active, name, owner_label). RLS is unchanged.
-- Existing accounts get their mask on the worker's next sync of each bank.

alter table public.accounts
  add column if not exists mask text
  check (mask is null or char_length(mask) <= 8);
