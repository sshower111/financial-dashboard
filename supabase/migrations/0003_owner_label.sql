-- 0003: person labels on accounts (e.g. "Keith", "Alex") for the dashboard's person switcher.
--
-- Security:
--  * RLS is unchanged: the existing "User Accounts" policy already restricts every
--    operation to rows where auth.uid() = user_id.
--  * Clients still cannot insert accounts or write bank-sourced columns. 0001 revoked
--    insert/update and granted update on (is_active, name) only; this adds owner_label
--    to that column allow-list and nothing else.
--  * The worker / Plaid exchange upserts don't send owner_label, so a re-sync never
--    overwrites a label.

alter table public.accounts
  add column if not exists owner_label text
  check (owner_label is null or char_length(owner_label) between 1 and 40);

grant update (owner_label) on public.accounts to authenticated;
