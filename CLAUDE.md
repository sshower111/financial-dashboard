# Financial Dashboard — notes for Claude

Real-time personal finance dashboard: Plaid → Supabase → background worker (local Ollama LLM) → Next.js UI over Supabase Realtime. The README covers features and architecture; this file covers working on the code.

## Commands

```bash
npm run dev        # Next.js on :3000 (demo mode if .env.local has no Supabase vars)
npm run worker     # background worker: Plaid sync, LLM categorization, anomaly scan, FX refresh
npm test           # finance engine unit tests (node:test via tsx)
npm run typecheck
npm run build
```

The owner works on **Windows PowerShell 5.1**: `&&` doesn't work there. Give commands one per line or one per code block.

## Layout

- `src/lib/finance/*`: pure, tested functions (fx, networth, cashflow, pacing, recurring, forecast, anomaly). The UI, the worker and the copilot context all share them. Change these with tests in `engine.test.ts`.
- `src/lib/ai/*`: Ollama client (`/api/generate`, `think:false`, JSON-schema output), categorizer (LLM + regex fallback), copilot context builder.
- `src/app/api/*`: plaid link-token / exchange / webhook (ES256 JWT verification), copilot (streaming), categorize (demo only), health.
- `worker/index.ts`: queue = `webhook_logs` (processed=false, backoff by `attempts`). Run **one** instance only.
- `src/components/LiveSync.tsx`: initial load, Realtime subscription (sets the JWT with `realtime.setAuth` **before** subscribing; otherwise RLS silently drops events), the demo simulator, and layout persistence.
- `src/lib/demo.ts`: deterministic US demo ledger (seeded per calendar day). `engine.test.ts` asserts on its merchant names.
- `supabase/migrations/`: 0001 init, 0002 USD defaults, 0003 `accounts.owner_label` (applied to the live project), 0004 dashboards (check whether applied).
- **Dashboards** (`src/lib/finance/scope.ts`, `DashboardTabs.tsx`): separate dashboards (Personal / Business / user-added), no combined view. Stable id in `accounts.owner_label`, `budgets.dashboard`, `dashboard_layouts.dashboard`; names in `user_settings.dashboards` (rename = settings only). `useScopedData()` in `src/store/derived.ts` is the only filter: panels never read `s.data` for accounts/transactions; `/api/copilot` applies the same `scopeLedger`. New Plaid accounts are placed by `assignDashboards()` (holder_category, then name).

## Conventions

- **Design system**: tokens in `src/app/globals.css` (cream `#F9F8F6` / charcoal `#121212`, 1px sand/charcoal borders, terracotta accent `#C85A32`/`#D97757` only for active, alert and over-budget states). No shadows, glows or gradients. Every number goes through the `.num` class (mono, tabular) and the `<Money>` component. Recharts stays monochrome. Framer Motion is opacity-only.
- **Amount sign**: Plaid convention, `amount > 0` = money out.
- **Currency**: base currency is USD. Never convert implicitly: `convert()` throws on a missing rate. FX rows are `(base, quote, rate)`, refreshed from Frankfurter (ECB) by the worker.
- **Security**: RLS on every table. Clients can't read `institutions.access_token` (column grants) and can't insert bank-sourced rows. Only the service role (worker and API routes) writes Plaid data. Never expose `SUPABASE_SERVICE_ROLE_KEY` or put it in a `NEXT_PUBLIC_*` variable.
- `NEXT_PUBLIC_*` values are inlined at **build** time. Rebuild after changing them.
- **Commits**: the author email must be the GitHub noreply address, or GitHub rejects the push (GH007):
  `git config user.email "28240293+sshower111@users.noreply.github.com"` and `git config user.name "sshower111"`.

## Current state (as of 2026-11-05)

- **GitHub**: https://github.com/sshower111/financial-dashboard (public, `main`).
- **Live demo**: https://financial-dashboard-sshower.vercel.app, a Vercel project `financial-dashboard` that auto-deploys from `main`. It has **no env vars**, so it runs in demo mode. Keep it that way: adding Supabase keys there would expose a login to the real database.
- **Supabase**: project `financial-dashboard` (renamed from `ledger`), ref `vvsxskhbtrgrucnqszzf`, region ca-central-1, free plan. Free projects pause after about a week idle; restore from the dashboard. Migrations 0001 and 0002 are applied; 0003 is written, apply it in the SQL editor. Sandbox test data was deleted. One user, the owner.
- **Plaid**: sandbox tested end to end (link → sync of 217 transactions and 13 holdings → categorization → live feed).
- **Verified**: Realtime delivers inserts and updates to the browser in about 1 second (Playwright against the live project, with a throwaway user that was deleted afterwards).

## Open items

1. Disable "Allow new users to sign up" in Supabase Auth before exposing the app over ngrok (confirm with the owner whether it's done).
2. Plaid production access: `PLAID_ENV=production`, an ngrok static domain, `PLAID_REDIRECT_URI=https://<domain>/oauth` registered in the Plaid dashboard, `PLAID_WEBHOOK_URL=https://<domain>/api/plaid/webhook`. The owner must use the app through that HTTPS domain, since auth cookies are per-domain, and add `https://<domain>/auth/callback` to Supabase redirect URLs.
3. Production OAuth and the webhook path haven't been run against real Plaid yet. Watch the worker logs on the first real link.
4. Roadmap: Plaid Link update mode (`ITEM_LOGIN_REQUIRED`), encrypting access tokens (Supabase Vault), safe concurrent workers (`FOR UPDATE SKIP LOCKED` via an RPC), CSV import for brokers Plaid doesn't cover.
5. Categorization: merchant cache first (in-memory, built from categorized rows, keyed by `merchantKey()` in `src/lib/ai/merchant.ts`), then up to `CATEGORIZE_BATCH`=50 deduped merchants per call to `OLLAMA_CATEGORIZE_MODEL` (default `qwen2.5:1.5b`, falls back to `OLLAMA_MODEL`). Failing batches split in half; a merchant failing 3 times gets the regex rules.

## Regenerating README media

The screenshots in `docs/screenshots/` and `docs/demo.gif` come from demo mode: temporarily move `.env.local` aside, `npm run build && npm start`, then capture with Playwright and encode the GIF with ffmpeg (about 900px wide, 10 fps, 64-color palette, kept under 8 MB). The demo must never show real account data.
