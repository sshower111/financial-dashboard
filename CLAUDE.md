# Financial Dashboard — notes for Claude

Real-time personal finance dashboard: Plaid → Supabase → background worker (local Ollama LLM) → Next.js UI over Supabase Realtime. The README covers features and architecture; this file covers working on the code; **`docs/HANDOFF.md`** covers running it, current status, what's verified and open items.

## Commands

```bash
npm run dev        # Next.js on :3000 (demo mode if .env.local has no Supabase vars)
npm run worker     # background worker: Plaid sync, LLM categorization, anomaly scan, FX refresh
npm run live       # owner's one-window setup: next dev + worker + ngrok (scripts/live.mjs); Ctrl+C stops all
npm run live:prod  # same with next build + next start. Port LIVE_PORT (default 3001); ngrok domain from
                   # NGROK_DOMAIN or the PLAID_REDIRECT_URI host in .env.local (NGROK_DOMAIN=off skips ngrok)
npm test           # finance engine unit tests (node:test via tsx)
npm run typecheck
npm run build
```

The owner works on **Windows PowerShell 5.1**: `&&` doesn't work there. Give commands one per line or one per code block.

## Layout

- `src/lib/finance/*`: pure, tested functions (fx, networth, cashflow, pacing, recurring, forecast, anomaly). The UI, the worker and the copilot context all share them. Change these with tests in `engine.test.ts`.
- `src/lib/ai/*`: Ollama client (`/api/generate`, `think:false`, JSON-schema output), categorizer (LLM + regex fallback), copilot context builder.
- `src/app/api/*`: plaid link-token / exchange / webhook (ES256 JWT verification), copilot (streaming), categorize (demo only), health.
- `worker/index.ts`: queue = `webhook_logs` (processed=false, backoff by `attempts`), claimed via the `claim_webhook_jobs` RPC (0006, `FOR UPDATE SKIP LOCKED` + `locked_until` lease). 0006 is applied (2026-11-09), so several workers can run; if the RPC is missing it falls back to an unlocked select (one instance only).
- `src/components/LiveSync.tsx`: initial load, Realtime subscription (sets the JWT with `realtime.setAuth` **before** subscribing; otherwise RLS silently drops events), the demo simulator, and layout persistence.
- `src/lib/demo.ts`: deterministic US demo ledger (seeded per calendar day). `engine.test.ts` asserts on its merchant names.
- `supabase/migrations/`: 0001 init, 0002 USD defaults, 0003 `accounts.owner_label`, 0004 dashboards (applied to the live project), 0005 `accounts.mask`, 0006 job-claim RPC (all applied to the live project), 0007 `accounts.nickname` (applied 2026-11-09; recorded in Supabase as `0006_account_nickname`; UI shows nickname, else Plaid name + ··last4), 0008 `transactions.plaid_category` + confidence (applied 2026-11-09; backfilled by `scripts/backfill-plaid-category.ts`).
- **Dashboards** (`src/lib/finance/scope.ts`, `DashboardTabs.tsx`): separate dashboards (Personal / Business / user-added), no combined view. Stable id in `accounts.owner_label`, `budgets.dashboard`, `dashboard_layouts.dashboard`; names in `user_settings.dashboards` (rename = settings only). `useScopedData()` in `src/store/derived.ts` is the only filter: panels never read `s.data` for accounts/transactions; `/api/copilot` applies the same `scopeLedger`. Linking puts new accounts on the open dashboard; accounts the worker discovers later go where that bank's other accounts are (else `guessDashboard()`).
- **Re-link dedupe** (`src/lib/link-dedupe.ts`): a new Plaid item for a bank already linked only stores accounts that don't match existing ones (type + subtype + mask, name fallback); if none are new the item is removed at Plaid (409). The worker applies the same check before inserting accounts. `/api/plaid/remove` unlinks a bank (Plaid item/remove + cascade delete); UI under Edit layout → Accounts → Linked banks.

## Conventions

- **Design system**: tokens in `src/app/globals.css` (cream `#F9F8F6` / charcoal `#121212`, 1px sand/charcoal borders, terracotta accent `#C85A32`/`#D97757` only for active, alert and over-budget states). No shadows, glows or gradients. Every number goes through the `.num` class (mono, tabular) and the `<Money>` component. Recharts stays monochrome. Framer Motion is opacity-only.
- **Amount sign**: Plaid convention, `amount > 0` = money out.
- **Currency**: base currency is USD. Never convert implicitly: `convert()` throws on a missing rate. FX rows are `(base, quote, rate)`, refreshed from Frankfurter (ECB) by the worker.
- **Security**: RLS on every table. Clients can't read `institutions.access_token` (column grants) and can't insert bank-sourced rows. Only the service role (worker and API routes) writes Plaid data. Never expose `SUPABASE_SERVICE_ROLE_KEY` or put it in a `NEXT_PUBLIC_*` variable.
- `NEXT_PUBLIC_*` values are inlined at **build** time. Rebuild after changing them.
- **Commits**: the author email must be the GitHub noreply address, or GitHub rejects the push (GH007):
  `git config user.email "28240293+sshower111@users.noreply.github.com"` and `git config user.name "sshower111"`.

## Current state (as of 2026-11-07)

- **GitHub**: https://github.com/sshower111/financial-dashboard (public, `main`).
- **Live demo**: https://financial-dashboard-sshower.vercel.app, a Vercel project `financial-dashboard` that auto-deploys from `main`. It has **no env vars**, so it runs in demo mode. Keep it that way: adding Supabase keys there would expose a login to the real database.
- **Supabase**: project `financial-dashboard` (renamed from `ledger`), ref `vvsxskhbtrgrucnqszzf`, region ca-central-1, free plan. Free projects pause after about a week idle; restore from the dashboard. Migrations 0001–0004 are applied; confirm 0005. One user, the owner.
- **Plaid**: production, `PLAID_COUNTRY_CODES=US,CA`, real US and CA banks and brokerages linked. The owner runs `npm start` + `npm run worker` + an ngrok static domain and uses the app only through that HTTPS domain (never commit the domain).
- **Verified**: Realtime delivers inserts and updates to the browser in about 1 second (Playwright against the live project, with a throwaway user that was deleted afterwards).

## Open items

1. Disable "Allow new users to sign up" in Supabase Auth before exposing the app over ngrok (confirm with the owner whether it's done).
2. Not yet checked against real data: the live sync-progress indicator, the cached/batched categorization path, and the duplicate flag + Remove after b2be63f (see HANDOFF §6).
3. Open question: a "session" label the owner saw in Live activity is not in the code; probably a raw bank string or AI subcategory.
4. Roadmap: Plaid Link update mode (`ITEM_LOGIN_REQUIRED`), encrypting access tokens (Supabase Vault), CSV import for brokers Plaid doesn't cover.
5. Categorization order (worker): fixed rules first (`forcedLabel`: Interac e-Transfer / Zelle = payment to / from a person, never Transfer; money in marked "Direct deposit" = Income), then Plaid's category when Plaid is HIGH/VERY_HIGH and named the merchant (`plaidLabel`), then the merchant cache, then up to `CATEGORIZE_BATCH`=20 merchants per call to `OLLAMA_CATEGORIZE_MODEL` (default now `OLLAMA_MODEL`; qwen2.5:1.5b filed restaurants as Transfer). Plaid overrides the model when Plaid is confident or the model says Transfer for a purchase. Recurring groups by the bank text (`merchantKey` in recurring.ts), not the AI name.

## Regenerating README media

The screenshots in `docs/screenshots/` and `docs/demo.gif` come from demo mode: temporarily move `.env.local` aside, `npm run build && npm start`, then capture with Playwright and encode the GIF with ffmpeg (about 900px wide, 10 fps, 64-color palette, kept under 8 MB). The demo must never show real account data.
