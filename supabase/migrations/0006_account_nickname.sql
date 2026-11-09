-- 0006: user-chosen account nickname. `name` comes from Plaid and is rewritten on every sync
-- (Chase, for example, names every card "Ultimate Rewards®"), so a rename needs its own column.
-- null = show the bank's name plus the last 4 digits.
--
-- Security: the signed-in user may update only this column (plus the existing is_active, name,
-- owner_label grants). RLS is unchanged.

alter table public.accounts
  add column if not exists nickname text
  check (nickname is null or char_length(nickname) between 1 and 60);

grant update (nickname) on public.accounts to authenticated;
