-- 0004: separate, nameable dashboards (e.g. "Personal", "Business").
--
-- Each dashboard has a stable id ('personal', 'business', or 'd-xxxxxxxx' for ones you add) and a
-- name you can change at any time:
--   * user_settings.dashboards  ordered [{ "id": ..., "name": ... }]  (renaming only touches this)
--   * accounts.owner_label      the dashboard id an account belongs to (column from 0003)
--   * budgets.dashboard, dashboard_layouts.dashboard   budgets and panel layout per dashboard
-- RLS is unchanged: the existing per-table policies already restrict every row to
-- auth.uid() = user_id, and clients can still only update (is_active, name, owner_label) on accounts.

alter table public.user_settings
  add column if not exists dashboards jsonb not null
  default '[{"id":"personal","name":"Personal"},{"id":"business","name":"Business"}]'::jsonb
  check (jsonb_typeof(dashboards) = 'array' and jsonb_array_length(dashboards) between 1 and 20);

-- budgets: one limit per (user, dashboard, category)
alter table public.budgets
  add column if not exists dashboard text not null default 'personal'
  check (char_length(dashboard) between 1 and 40);
alter table public.budgets drop constraint if exists budgets_user_id_category_key;
alter table public.budgets drop constraint if exists budgets_user_dashboard_category_key;
alter table public.budgets add constraint budgets_user_dashboard_category_key unique (user_id, dashboard, category);

-- layouts: one layout per (user, dashboard)
alter table public.dashboard_layouts
  add column if not exists dashboard text not null default 'personal'
  check (char_length(dashboard) between 1 and 40);
alter table public.dashboard_layouts drop constraint if exists dashboard_layouts_user_id_key;
alter table public.dashboard_layouts drop constraint if exists dashboard_layouts_user_dashboard_key;
alter table public.dashboard_layouts add constraint dashboard_layouts_user_dashboard_key unique (user_id, dashboard);

-- accounts: put every account on a dashboard id. Labels typed while testing 0003's person field are
-- replaced. Business if the bank's name for the account says so, else Personal.
-- (New accounts are assigned by the worker / link flow from Plaid's holder_category.)
update public.accounts
set owner_label = case when name ~* '\m(bus|business|biz|corp|inc|llc|ltd)\M' then 'business' else 'personal' end
where owner_label is null or owner_label not in ('personal', 'business');
