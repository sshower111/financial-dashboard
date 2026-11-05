-- Financial Dashboard — initial schema
-- Based on the spec schema, with these corrections:
--   * `references auth.users(not null)` is invalid SQL → `not null references auth.users(id) on delete cascade`
--   * institutions.plaid_item_id added (Plaid webhooks identify items by item_id, not institution)
--   * access_token is hidden from client roles (column privileges) — only the service-role worker reads it
--   * webhook_logs gets RLS with no policies (service role only)
--   * added: budgets, fx_rates, user_settings (needed for pacing + multi-currency)
--   * policies use (select auth.uid()) and `to authenticated`; indexes on hot paths

create extension if not exists "uuid-ossp";

-- shared updated_at trigger
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- INSTITUTIONS -------------------------------------------------------------
create table public.institutions (
    id uuid primary key default uuid_generate_v4(),
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    plaid_item_id text unique not null,
    plaid_institution_id text not null,
    name text not null,
    country text not null check (country in ('US', 'CA')),
    access_token text not null,
    cursor text,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- ACCOUNTS -----------------------------------------------------------------
create table public.accounts (
    id uuid primary key default uuid_generate_v4(),
    institution_id uuid references public.institutions(id) on delete cascade not null,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    plaid_account_id text unique not null,
    name text not null,
    type text not null check (type in ('depository', 'credit', 'investment', 'loan', 'other')),
    subtype text not null,
    currency text not null default 'CAD' check (currency in ('CAD', 'USD', 'EUR', 'GBP')),
    current_balance numeric(12, 2),
    available_balance numeric(12, 2),
    limit_amount numeric(12, 2),
    is_active boolean default true not null,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- TRANSACTIONS -------------------------------------------------------------
-- amount follows Plaid's convention: positive = money out, negative = money in.
create table public.transactions (
    id uuid primary key default uuid_generate_v4(),
    account_id uuid references public.accounts(id) on delete cascade not null,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    plaid_transaction_id text unique,
    amount numeric(12, 2) not null,
    iso_currency_code text not null default 'CAD',
    date date not null,
    raw_merchant_string text not null,
    cleaned_merchant_name text,
    category text,
    subcategory text,
    ai_confidence_score numeric(3, 2),
    ai_tags jsonb default '[]'::jsonb not null,
    is_anomaly boolean default false not null,
    is_pending boolean default false not null,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- INVESTMENT HOLDINGS ------------------------------------------------------
create table public.investment_holdings (
    id uuid primary key default uuid_generate_v4(),
    account_id uuid references public.accounts(id) on delete cascade not null,
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    security_id text not null,
    ticker text not null,
    name text not null,
    quantity numeric(14, 4) not null,
    institution_price numeric(12, 4) not null,
    institution_value numeric(12, 2) not null,
    currency text not null,
    updated_at timestamptz default now() not null,
    unique (account_id, security_id)
);

-- WEBHOOK LOGS (doubles as the worker's job queue) -------------------------
create table public.webhook_logs (
    id uuid primary key default uuid_generate_v4(),
    webhook_type text not null,
    webhook_code text not null,
    payload jsonb not null,
    processed boolean default false not null,
    error text,
    attempts int default 0 not null,
    created_at timestamptz default now() not null
);

-- DASHBOARD LAYOUTS --------------------------------------------------------
create table public.dashboard_layouts (
    id uuid primary key default uuid_generate_v4(),
    user_id uuid unique not null default auth.uid() references auth.users(id) on delete cascade,
    layout_config jsonb not null default '[]'::jsonb,
    updated_at timestamptz default now() not null
);

-- ADDITIONS ----------------------------------------------------------------
create table public.budgets (
    id uuid primary key default uuid_generate_v4(),
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    category text not null,
    monthly_limit numeric(12, 2) not null check (monthly_limit > 0),
    currency text not null default 'CAD',
    created_at timestamptz default now() not null,
    unique (user_id, category)
);

create table public.user_settings (
    user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
    base_currency text not null default 'CAD' check (base_currency in ('CAD', 'USD', 'EUR', 'GBP')),
    updated_at timestamptz default now() not null
);

-- rate = units of `quote` per 1 `base`. Global, read-only for clients; worker refreshes.
create table public.fx_rates (
    base text not null,
    quote text not null,
    rate numeric(14, 6) not null check (rate > 0),
    as_of date not null default current_date,
    primary key (base, quote)
);
insert into public.fx_rates (base, quote, rate) values
  ('USD','CAD',1.37), ('EUR','CAD',1.49), ('GBP','CAD',1.74)
on conflict do nothing;

-- INDEXES ------------------------------------------------------------------
create index on public.institutions (user_id);
create index on public.accounts (user_id);
create index on public.accounts (institution_id);
create index on public.transactions (user_id, date desc);
create index on public.transactions (account_id);
create index transactions_uncategorized_idx on public.transactions (created_at) where category is null;
create index on public.investment_holdings (user_id);
create index on public.investment_holdings (account_id);
create index webhook_logs_pending_idx on public.webhook_logs (created_at) where processed = false;

-- TRIGGERS -----------------------------------------------------------------
create trigger touch before update on public.institutions        for each row execute function public.touch_updated_at();
create trigger touch before update on public.accounts            for each row execute function public.touch_updated_at();
create trigger touch before update on public.transactions        for each row execute function public.touch_updated_at();
create trigger touch before update on public.investment_holdings for each row execute function public.touch_updated_at();
create trigger touch before update on public.dashboard_layouts   for each row execute function public.touch_updated_at();
create trigger touch before update on public.user_settings       for each row execute function public.touch_updated_at();

-- RLS ----------------------------------------------------------------------
alter table public.institutions        enable row level security;
alter table public.accounts            enable row level security;
alter table public.transactions        enable row level security;
alter table public.investment_holdings enable row level security;
alter table public.dashboard_layouts   enable row level security;
alter table public.webhook_logs        enable row level security;  -- no policies: service role only
alter table public.budgets             enable row level security;
alter table public.user_settings       enable row level security;
alter table public.fx_rates            enable row level security;

create policy "User Institutions" on public.institutions        for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "User Accounts"     on public.accounts            for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "User Transactions" on public.transactions        for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "User Holdings"     on public.investment_holdings for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "User Layouts"      on public.dashboard_layouts   for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "User Budgets"      on public.budgets             for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "User Settings"     on public.user_settings       for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "FX read"           on public.fx_rates            for select to authenticated using (true);

-- Plaid access tokens never reach the browser: clients may read only non-secret
-- columns, and only the service role (worker / API routes) may write institutions.
revoke all on public.institutions from anon, authenticated;
grant select (id, user_id, plaid_item_id, plaid_institution_id, name, country, created_at, updated_at)
  on public.institutions to authenticated;
grant delete on public.institutions to authenticated;
revoke all on public.webhook_logs from anon, authenticated;

-- Bank-sourced rows are written only by the service role (Plaid sync). Clients may
-- read them, recategorize transactions, and deactivate/remove accounts — but cannot
-- insert rows (an FK alone would let a user attach rows to someone else's institution id).
revoke insert, update on public.accounts, public.transactions, public.investment_holdings from anon, authenticated;
grant update (is_active, name) on public.accounts to authenticated;
grant update (cleaned_merchant_name, category, subcategory, ai_tags) on public.transactions to authenticated;
revoke insert, update, delete on public.fx_rates from anon, authenticated;

-- REALTIME (live activity feed) --------------------------------------------
alter publication supabase_realtime add table public.transactions;
