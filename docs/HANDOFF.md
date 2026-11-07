# Handoff: Financial Dashboard

The state of the project as of **2026-11-07**, written for whoever takes it over. The README covers features and architecture, and `CLAUDE.md` holds the conventions for AI coding agents. This file covers how to run it, what's done, what's verified and what's open.

> This repo is public. Never commit `.env.local`, Plaid or Supabase keys, the tunnel domain, or real account data, including screenshots.

## 1. What it is

A personal finance dashboard. Plaid pulls bank, card and brokerage data into Supabase (Postgres with RLS). A local Node **worker** syncs it, categorizes transactions with a **local Ollama model** and flags anomalies. A **Next.js** UI shows everything live over Supabase Realtime. Money data never goes to a cloud LLM.

## 2. Running it (Windows PowerShell 5.1)

The owner runs a production build behind an HTTPS tunnel (ngrok static domain). Plaid OAuth and webhooks need HTTPS, and sign-in cookies are tied to that domain, so always open the app through the tunnel URL.

Three processes run at the same time, each in its own terminal:

```
npm start
```
```
npm run worker
```
```
ngrok http --url=<your-static-domain> 3000
```

After pulling new code, stop `npm start` and the worker, then:

```
npm install
```
```
npm run build
```
```
npm start
```
```
npm run worker
```

Run only **one** worker at a time: job claiming isn't safe across concurrent workers.

Ollama must be running with two models (both pulled once):

```
ollama pull qwen3.5:9b
```
```
ollama pull qwen2.5:1.5b
```

`qwen3.5:9b` answers the Assistant chat. `qwen2.5:1.5b` categorizes transactions in the worker. The code picks the right one per task, and no env change is needed. If the small model is missing, the worker falls back to the big one and logs a hint.

Demo mode (no real data): leave the Supabase variables empty. The public Vercel deployment runs this way. **Never add env vars to the Vercel project**: that would put a login to the real database on the public internet.

## 3. Configuration

All settings live in `.env.local` (never committed). `.env.example` lists every variable with comments:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser client. Inlined at **build** time, so rebuild after changing them. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server and worker only. Never put it in a `NEXT_PUBLIC_*` variable. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | `production` is in use. |
| `PLAID_COUNTRY_CODES` | `US,CA` is in use. |
| `PLAID_REDIRECT_URI`, `PLAID_WEBHOOK_URL` | `https://<tunnel>/oauth` and `https://<tunnel>/api/plaid/webhook`. The redirect URI must also be registered in the Plaid dashboard. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Ollama endpoint and the Assistant model. |
| `OLLAMA_CATEGORIZE_MODEL`, `CATEGORIZE_BATCH`, `OLLAMA_TIMEOUT_MS` | Optional overrides for worker categorization (defaults: `qwen2.5:1.5b`, 50, 10 min). |

In Supabase → Authentication → URL Configuration, the redirect URLs must include `https://<tunnel>/auth/callback`.

## 4. Database

Supabase project `financial-dashboard` (free plan; it pauses after about a week idle, so restore it from the dashboard). Migrations in `supabase/migrations/`, applied by hand in the SQL editor:

| Migration | What | Status |
|---|---|---|
| 0001 init, 0002 USD defaults | Schema, RLS, column grants | Applied |
| 0003 `accounts.owner_label` | Which dashboard an account is on | Applied |
| 0004 dashboards | Dashboard names; per-dashboard budgets and layouts | Applied |
| 0005 `accounts.mask` | Last 4 digits, for re-link detection | **Confirm it's applied** (query below) |

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'accounts' and column_name in ('owner_label', 'mask');
-- expect 2 rows
```

Security model, which every change must keep: RLS on every table. Clients can't read `institutions.access_token`, and they can't insert bank-sourced rows. Clients may update only `accounts.(is_active, name, owner_label)` and the transaction category fields. Plaid data is written only by the service role (the worker and API routes).

## 5. Features added in this round (Nov 2026)

| Feature | Where | Notes |
|---|---|---|
| **Separate dashboards** (Personal / Business / custom), shown as tabs | `src/lib/finance/scope.ts`, `src/components/DashboardTabs.tsx`, `useScopedData()` in `src/store/derived.ts` | Click a tab to open it, click the open tab to rename it, **+** adds one. Each dashboard has its own accounts, budgets and layout. No combined view, by the owner's choice. Ids are stable, so renaming only changes the name. |
| **Link into the open tab** | `src/app/api/plaid/exchange/route.ts` | New accounts land on the dashboard that was open. Accounts the worker discovers later go to the dashboard of that bank's other accounts. |
| **Re-link dedupe and Remove bank** | `src/lib/link-dedupe.ts`, `/api/plaid/remove`, Edit layout → Accounts → *Linked banks* | Accounts are matched by type, subtype and last 4. If nothing is new, the new Plaid item is removed and the user sees "already linked". Only the later copy of a duplicate is flagged. Remove calls Plaid item/remove (which stops billing for it) and cascade-deletes the bank's data. |
| **Transfers counted once** | `src/lib/finance/transfers.ts`, worker | Both legs of card payments and own-account moves are excluded from spending, cash flow, forecast and anomalies. New Plaid rows marked TRANSFER_IN/OUT or LOAN_PAYMENTS are saved as `Transfer` directly. |
| **Faster categorization** | `worker/index.ts`, `src/lib/ai/merchant.ts`, `src/lib/ai/categorize.ts` | Merchant cache, then de-duplication by merchant, then batches of up to 50 per LLM call. Failing batches split in half; after 3 failures a merchant gets the keyword rules; exponential backoff when Ollama is down. Logs show cache hits versus LLM calls and speed. |
| **Sync progress** | `/api/sync-status`, `src/components/SyncProgress.tsx` | "Importing from bank…" while the pull runs, then "Categorizing N% (a/b)". Hidden when idle. |
| **Live feed** | `src/components/widgets/Feed.tsx` | Sort newest/oldest, from/to date filter. |
| UI fixes | Panels, `globals.css` | Text wraps instead of truncating. Panels adapt to their own width (container queries). Chart hover dots are no longer clipped. "Copilot" is now "Assistant" in the UI (internal names unchanged). The Assistant only auto-scrolls while you're at the bottom. |

## 6. Verification status

**Verified:**
- `npm run typecheck` and `npm test` (13 tests) pass.
- Every UI change was driven in demo mode in headless Chrome: dashboard switching, renaming, adding and moving accounts, feed sort and filter, Assistant scrolling with a long stubbed stream, and a scan for clipped text at 1440, 820 and 390px.
- The owner confirmed dashboards and linking against real data.

**Not yet verified against real data:**
- The live sync-progress indicator.
- The new worker categorization path (cache and batches) on the real queue. Watch the worker log on first run.
- The duplicate flag and Remove after the latest fix (b2be63f).
- Detecting a re-link of a bank whose accounts don't have last-4 digits yet (filled on that bank's next worker sync).

## 7. Open items

1. Confirm "Allow new users to sign up" is **disabled** in Supabase Auth, since the app is reachable over the tunnel.
2. Confirm migration 0005 is applied (query above).
3. Plaid Link **update mode** for `ITEM_LOGIN_REQUIRED` isn't built. A bank that needs re-login currently has to be removed and linked again.
4. Encrypt Plaid access tokens at rest (Supabase Vault).
5. Make the worker safe to run as multiple instances (`FOR UPDATE SKIP LOCKED` via an RPC).
6. CSV import for brokers Plaid doesn't cover.
7. Open question from the owner: a "session" label seen in Live activity. It isn't in the code, so it probably comes from a bank's raw description or an AI subcategory. Find the row and check `raw_merchant_string` / `subcategory`.
8. `AGENTS.md` at the repo root is generated by Next.js 16 and untracked. Leave it out of commits, or set `agentRules: false` in `next.config.ts`.

## 8. Working on the code

- Read `CLAUDE.md` first. It has the layout, conventions and the design system rules (1px borders, terracotta only for active or alert states, no shadows, numbers through `<Money>` / `.num`).
- Pure logic goes in `src/lib/finance/*` with tests in `engine.test.ts`. The UI, the worker and the Assistant share it.
- Panels must read data through `useScopedData()` / `useDerived()`, never `s.data` directly, so they respect the open dashboard.
- Commit with the GitHub noreply identity in `CLAUDE.md`, or pushes are rejected (GH007).
- The owner uses Windows PowerShell 5.1: give commands one per line, never joined with `&&`.
