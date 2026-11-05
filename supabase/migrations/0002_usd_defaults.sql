-- US-based defaults: USD is the default currency, FX rates are stored USD-based
-- (ECB reference rates via Frankfurter, refreshed by the worker).

alter table public.accounts      alter column currency          set default 'USD';
alter table public.transactions  alter column iso_currency_code set default 'USD';
alter table public.budgets       alter column currency          set default 'USD';
alter table public.user_settings alter column base_currency     set default 'USD';

-- replace the CAD-quoted seed rates with USD-based ones
delete from public.fx_rates where quote = 'CAD' and base in ('USD', 'EUR', 'GBP');
insert into public.fx_rates (base, quote, rate) values
  ('USD', 'EUR', 0.8876), ('USD', 'GBP', 0.7408), ('USD', 'CAD', 1.3935)
on conflict (base, quote) do update set rate = excluded.rate, as_of = current_date;
