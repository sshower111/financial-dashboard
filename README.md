# Ledger

A minimal, local-AI personal finance dashboard. Next.js 16 (App Router) · Supabase (Postgres + RLS + Realtime) · Plaid (US + CA, Transactions + Investments) · Ollama on localhost for categorization and the copilot. **No ledger data goes to a cloud LLM.**

![Dashboard, light](docs/screenshots/dashboard-light.png)

<table>
<tr>
<td width="62%"><img src="docs/screenshots/dashboard-dark.png" alt="Dashboard, dark"></td>
<td width="38%"><img src="docs/screenshots/mobile.png" alt="Mobile"></td>
</tr>
</table>

![Edit layout](docs/screenshots/edit-layout.png)

<sub>All screenshots use the built-in synthetic demo ledger. No real accounts.</sub>

## Features

- **Unified net worth** across cash, credit, loans and brokerage. Each account keeps its native currency (CAD/USD/EUR/GBP) and is converted to a switchable base currency using Bank of Canada rates.
- **Plaid ingestion** for US and Canadian institutions, with investment holdings, signed webhooks, cursor-based sync and OAuth bank support.
- **Async AI categorization**: a background worker cleans merchant strings and assigns category, subcategory, tags and confidence using a local Ollama model. The UI never waits on it.
- **Budget pacing**: month-to-date spend against how far through the month you are (`1.00×` is on pace).
- **Leakage detection**: duplicate charges, subscription price hikes, bank fees and unusual amounts.
- **Wallet weather**: a 30-day cash projection from detected income, bills, card balances and discretionary burn → Clear / Overcast / Storm.
- **Copilot**: streaming natural-language Q&A over your ledger, answered by the local model.
- **Live activity feed** over Supabase Realtime: ingested → categorized → flagged.
- **Customizable layout**: drag to reorder, resize, add or remove widgets. Persisted as JSON per user.

## Demo

The app runs with **no configuration** on a deterministic synthetic ledger:

```bash
git clone <this repo> && cd ledger
npm install
npm run dev        # http://localhost:3000 with no .env.local → demo mode
```

Demo mode streams a new raw bank transaction every 10–15 s through the same categorizer the worker uses: your local Ollama model if it's running, otherwise a rules fallback (shown as `rules` in the feed). The seeded data includes a duplicate Uber Eats charge, a Netflix price hike and two bank fees for the anomaly scanner to find.

## Run it

```bash
npm install
cp .env.example .env.local     # leave Supabase blank to run on demo data
npm run dev                    # http://localhost:3000
npm run worker                 # background queue (needs Supabase + Plaid)
npm test                       # finance engine tests
```

With no Supabase env vars set, the app runs in **demo mode**: a deterministic synthetic ledger (CAD + USD accounts, a TFSA and a USD brokerage, seeded leakage) plus a simulator that streams raw bank strings through the same categorizer the worker uses (Ollama if it's running, regex rules otherwise).

Local model:

```bash
ollama serve
ollama pull qwen3.5:9b         # or set OLLAMA_MODEL to any model you have
```

## Live setup

1. Apply `supabase/migrations/0001_init.sql` (SQL editor, or `supabase db push`).
2. Fill `.env.local`: Supabase URL, anon key, service-role key, plus Plaid keys. Set `PLAID_WEBHOOK_URL` and `PLAID_REDIRECT_URI` (`…/oauth`) to a public HTTPS URL, for example an ngrok static domain. Register the redirect URI in the Plaid dashboard, then use the app through that URL.
3. Enable email (magic link) auth in Supabase and add `http://localhost:3000/auth/callback` to the redirect URLs.
4. Run `npm run dev` and `npm run worker` side by side, then use **Link institution**.

## How data flows

```
Plaid ──webhook──▶ /api/plaid/webhook ──(verify JWT, insert)──▶ webhook_logs
                                                                     │
                              worker (npm run worker) ◀── polls ─────┘
                                │  /transactions/sync → transactions (category = null)
                                │  balances, holdings, BoC FX rates
                                │  Ollama /api/generate (JSON schema) → category, merchant, tags
                                └  anomaly scan → is_anomaly, ai_tags "anomaly:*"
                                                                     │
browser ◀── Supabase Realtime (transactions) ── live feed, hero, widgets recompute
```

The webhook route only verifies and records; all slow work happens in the worker, so neither Plaid nor the UI ever waits on the LLM. If Ollama is down, transactions stay `queued` and are categorized when it comes back.

## Finance engine (`src/lib/finance`)

Pure functions shared by the UI, the worker and the copilot context builder, with tests in `engine.test.ts`.

| Module | What it does |
|---|---|
| `fx.ts` | Builds a rate table for the chosen base currency (direct, inverse or bridged). A missing rate throws instead of silently using 1:1. |
| `networth.ts` | Assets − liabilities with native per-currency subtotals, plus a 90-day history rolled back from transactions. Investments are held flat, so the UI labels it "est." |
| `cashflow.ts` | Trailing-30-day in/out/net vs the prior 30 days, excluding transfers. |
| `pacing.ts` | Month-to-date spend ÷ limit ÷ elapsed share of the month = velocity (1.00× is on pace). |
| `recurring.ts` | Finds weekly, biweekly, monthly, quarterly and yearly streams. Short cadences need more evidence, so a favourite restaurant doesn't count as a bill. |
| `forecast.ts` | 30-day projection: liquid cash, plus recurring income and bills, minus average discretionary burn, minus card balances (assumed due in 21 days). Wallet weather is **storm** if the projection goes below 0, **overcast** if the low point covers under 14 days of burn, otherwise **clear**. |
| `anomaly.ts` | Duplicate charges (same account, merchant and amount within 1 day), price hikes on fixed-price streams, fees, and spikes over 3.5× the merchant median. |

## Copilot

`/api/copilot` builds a compact JSON snapshot on the server (weekly burn by category, pacing, forecast, recurring streams, anomalies and the last 45 days of transactions). It sends that snapshot to Ollama and streams the answer back as text. Figures are precomputed so the model explains them rather than doing arithmetic.

## Schema notes

`0001_init.sql` follows the spec with these fixes:

- `references auth.users(not null)` is invalid SQL. It is now `not null default auth.uid() references auth.users(id) on delete cascade`.
- Added `institutions.plaid_item_id`, because Plaid webhooks identify items, not institutions.
- **Plaid access tokens never reach the browser**: column-level grants hide `access_token`, and only the service role can write institutions, accounts, holdings or new transactions. Clients can recategorize transactions and rename or deactivate accounts.
- `webhook_logs` has RLS with no policies, so only the service role can use it. It also gained `error` and `attempts` columns to work as the job queue.
- New tables: `budgets`, `user_settings` (base currency) and `fx_rates` (refreshed from the Bank of Canada Valet API).
- Policies are `to authenticated` with `(select auth.uid())`. Added indexes on the hot paths and enabled Realtime on `transactions`.

Consider encrypting `access_token` at rest (Supabase Vault) before production.

## Layout

The dashboard is a 12-column CSS grid driven by a JSON `layout_config` of `[{ i, w, h }]`. In **Edit layout** you can drag panels to reorder, change width (3/4/6/8/12) and height (1–4 rows), and remove or add widgets. The layout is saved to `dashboard_layouts`, or to localStorage in demo mode, and is validated on load.

## Known limits

- Run a single worker: job claiming isn't safe across concurrent workers.
- Item errors (`ITEM_LOGIN_REQUIRED`) are logged, but Plaid Link update mode isn't wired up yet.
- The first sync after linking retries with backoff (about 15 min) until Plaid finishes its initial pull. After that, new data arrives only through webhooks.
- Net-worth history doesn't include investment price changes.
