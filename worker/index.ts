/**
 * Financial Dashboard background worker.
 *
 *   npm run worker
 *
 * Loop:
 *   1. drain webhook_logs (Plaid webhooks + internal INITIAL_SYNC jobs) → /transactions/sync, balances, holdings
 *   2. categorize new transactions with the local Ollama model (batched, non-blocking for the UI)
 *   3. re-run anomaly detection for users whose ledgers changed
 *   4. refresh FX rates (ECB reference rates via Frankfurter, twice a day)
 *
 * Run a single instance: job claiming is not concurrency-safe across workers.
 */
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
for (const f of [".env.local", ".env"]) if (existsSync(f)) loadEnvFile(f);

const { supabaseAdmin } = await import("../src/lib/supabase/admin.ts");
const { plaid, ACCOUNT_TYPES, SUPPORTED_CCY } = await import("../src/lib/plaid.ts");
const { matchExisting } = await import("../src/lib/link-dedupe.ts");
const { guessDashboard } = await import("../src/lib/finance/scope.ts");
const { categorizeWithLLM, categorizeWithRules, forcedLabel, impossibleCategory, plausibleMerchant } = await import("../src/lib/ai/categorize.ts");
const { cacheKey } = await import("../src/lib/ai/merchant.ts");
const { hasModel, ollamaModels, OLLAMA_CATEGORIZE_MODEL, OLLAMA_MODEL, OLLAMA_URL } = await import("../src/lib/ai/ollama.ts");
const { detectAnomalies } = await import("../src/lib/finance/anomaly.ts");
const { markTransfers, P2P_RE } = await import("../src/lib/finance/transfers.ts");
import type { Account, Transaction } from "../src/lib/types.ts";
import type { CategorizeInput, CategorizeResult } from "../src/lib/ai/categorize.ts";
import type { RemovedTransaction, Transaction as PlaidTxn } from "plaid";

const db = supabaseAdmin();
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
const JOB_BATCH = 10;
const MAX_ATTEMPTS = 8;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface Item { id: string; user_id: string; access_token: string; cursor: string | null; country: string; plaid_institution_id: string }

async function itemFor(itemId: string): Promise<Item | null> {
  const { data } = await db.from("institutions").select("id,user_id,access_token,cursor,country,plaid_institution_id").eq("plaid_item_id", itemId).maybeSingle();
  return data as Item | null;
}

async function refreshAccounts(item: Item) {
  const { data } = await plaid().accountsGet({ access_token: item.access_token });
  const rows = data.accounts.map((a) => ({
    institution_id: item.id, user_id: item.user_id, plaid_account_id: a.account_id, mask: a.mask ?? null,
    name: a.official_name || a.name, type: ACCOUNT_TYPES.has(a.type) ? a.type : "other", subtype: a.subtype ?? "",
    currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? (item.country === "CA" ? "CAD" : "USD"),
    current_balance: a.balances.current, available_balance: a.balances.available, limit_amount: a.balances.limit,
  })).filter((a) => SUPPORTED_CCY.has(a.currency));
  const { data: mine } = await db.from("accounts").select("plaid_account_id,owner_label").eq("institution_id", item.id);
  const known = new Set((mine ?? []).map((a) => a.plaid_account_id as string));
  // known accounts: refresh balances (and backfill mask, migration 0005)
  const update = rows.filter((r) => known.has(r.plaid_account_id));
  if (update.length) await db.from("accounts").upsert(update, { onConflict: "plaid_account_id" }).throwOnError();
  // accounts this item hasn't stored: skip ones already linked through another connection to the same
  // bank (re-links), add genuinely new ones on the dashboard this bank's accounts are on
  let fresh = rows.filter((r) => !known.has(r.plaid_account_id));
  if (fresh.length) {
    const { data: others } = await db.from("institutions").select("id").eq("user_id", item.user_id).eq("plaid_institution_id", item.plaid_institution_id).neq("id", item.id);
    const otherIds = (others ?? []).map((o) => o.id as string);
    if (otherIds.length) {
      const { data: existing } = await db.from("accounts").select("name,type,subtype,mask").in("institution_id", otherIds);
      const dupes = matchExisting(fresh.map((r) => ({ ...r, account_id: r.plaid_account_id })), existing ?? []);
      fresh = fresh.filter((r) => !dupes.has(r.plaid_account_id));
    }
  }
  if (fresh.length) {
    const counts = new Map<string, number>();
    for (const a of mine ?? []) if (a.owner_label) counts.set(a.owner_label, (counts.get(a.owner_label) ?? 0) + 1);
    const sibling = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const plaidById = new Map(data.accounts.map((a) => [a.account_id, a]));
    await db.from("accounts").insert(fresh.map((r) => {
      const pa = plaidById.get(r.plaid_account_id)!;
      return { ...r, owner_label: sibling ?? guessDashboard({ name: r.name, official_name: pa.official_name, holder_category: (pa as { holder_category?: string | null }).holder_category }) };
    })).throwOnError();
    log(`item ${item.id.slice(0, 8)}: ${fresh.length} new account(s) added`);
  }
  return rows;
}

async function accountMap(institutionId: string) {
  const { data } = await db.from("accounts").select("id,plaid_account_id,type").eq("institution_id", institutionId);
  return new Map((data ?? []).map((a) => [a.plaid_account_id as string, a as { id: string; type: string }]));
}

async function syncTransactions(item: Item) {
  const acc = await accountMap(item.id);
  let cursor = item.cursor ?? undefined;
  let status = "TRANSACTIONS_UPDATE_STATUS_UNKNOWN";
  const added: PlaidTxn[] = [], modified: PlaidTxn[] = [], removed: RemovedTransaction[] = [];
  for (let restarts = 0; ; ) {
    try {
      let more = true;
      while (more) {
        const { data } = await plaid().transactionsSync({ access_token: item.access_token, cursor, count: 500, options: { include_original_description: true } });
        added.push(...data.added); modified.push(...data.modified); removed.push(...data.removed);
        more = data.has_more; cursor = data.next_cursor; status = data.transactions_update_status;
      }
      break;
    } catch (e: unknown) {
      const code = (e as { response?: { data?: { error_code?: string } } }).response?.data?.error_code;
      if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restarts++ < 3) {
        added.length = modified.length = removed.length = 0; cursor = item.cursor ?? undefined; continue;
      }
      throw e;
    }
  }
  const toRow = (t: PlaidTxn) => {
    const a = acc.get(t.account_id);
    if (!a) return null;
    return {
      account_id: a.id, user_id: item.user_id, plaid_transaction_id: t.transaction_id,
      amount: t.amount, iso_currency_code: t.iso_currency_code ?? t.unofficial_currency_code ?? "USD", date: t.date,
      raw_merchant_string: t.original_description ?? t.name, is_pending: t.pending,
      // Plaid's merchant name is only a hint; the LLM pass may refine it
      cleaned_merchant_name: t.merchant_name ?? null,
    };
  };
  // Plaid already knows card payments / own-account transfers: label new ones "Transfer" up front
  // (they skip the LLM queue). Only for `added`, so a user's later recategorization is never undone.
  const plaidTransfer = (t: PlaidTxn) => {
    const p = t.personal_finance_category?.primary;
    if (p !== "TRANSFER_IN" && p !== "TRANSFER_OUT" && p !== "LOAN_PAYMENTS") return null;
    // Plaid calls Interac e-Transfers / Zelle "transfers", but they usually go to other people (rent)
    if (P2P_RE.test(t.original_description ?? t.name ?? "")) return null;
    const d = t.personal_finance_category?.detailed ?? "";
    return d.includes("CREDIT_CARD") ? "Credit card payment" : p === "LOAN_PAYMENTS" ? "Loan payment" : "Between accounts";
  };
  const labelled = added.flatMap((t) => {
    const sub = plaidTransfer(t), r = sub ? toRow(t) : null;
    return r ? [{ ...r, category: "Transfer", subcategory: sub, ai_confidence_score: 1, ai_tags: ["plaid-pfc"] }] : [];
  });
  const labelledIds = new Set(labelled.map((r) => r.plaid_transaction_id));
  const rows = [...added, ...modified].map(toRow).filter((r): r is NonNullable<typeof r> => !!r && !labelledIds.has(r.plaid_transaction_id));
  // two upserts with uniform column sets: a mixed batch would null the category on the other rows
  for (const batch of [rows, labelled]) for (let i = 0; i < batch.length; i += 500) {
    // category columns are not in `rows`, so modified rows keep their AI labels
    await db.from("transactions").upsert(batch.slice(i, i + 500), { onConflict: "plaid_transaction_id" }).throwOnError();
  }
  const removedIds = removed.map((r) => r.transaction_id).filter(Boolean);
  if (removedIds.length) await db.from("transactions").delete().in("plaid_transaction_id", removedIds).throwOnError();
  await db.from("institutions").update({ cursor }).eq("id", item.id).throwOnError();
  log(`sync item ${item.id.slice(0, 8)}: +${added.length} ~${modified.length} -${removed.length} (${status})`);
  return { userId: item.user_id, complete: status === "HISTORICAL_UPDATE_COMPLETE" };
}

async function syncHoldings(item: Item) {
  const acc = await accountMap(item.id);
  if (![...acc.values()].some((a) => a.type === "investment")) return;
  try {
    const { data } = await plaid().investmentsHoldingsGet({ access_token: item.access_token });
    const sec = new Map(data.securities.map((s) => [s.security_id, s]));
    const rows = data.holdings.flatMap((h) => {
      const a = acc.get(h.account_id); const s = sec.get(h.security_id);
      if (!a) return [];
      return [{
        account_id: a.id, user_id: item.user_id, security_id: h.security_id,
        ticker: s?.ticker_symbol ?? (s?.type === "cash" ? "CASH" : "—"), name: s?.name ?? "Unknown security",
        quantity: h.quantity, institution_price: h.institution_price, institution_value: h.institution_value,
        currency: h.iso_currency_code ?? h.unofficial_currency_code ?? "USD", updated_at: new Date().toISOString(),
      }];
    });
    if (rows.length) await db.from("investment_holdings").upsert(rows, { onConflict: "account_id,security_id" }).throwOnError();
    // drop positions that were sold
    for (const a of acc.values()) {
      if (a.type !== "investment") continue;
      const keep = rows.filter((r) => r.account_id === a.id).map((r) => r.security_id);
      let q = db.from("investment_holdings").delete().eq("account_id", a.id);
      if (keep.length) q = q.not("security_id", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
      await q.throwOnError();
    }
    log(`holdings item ${item.id.slice(0, 8)}: ${rows.length} positions`);
  } catch (e: unknown) {
    const code = (e as { response?: { data?: { error_code?: string } } }).response?.data?.error_code;
    if (code === "PRODUCTS_NOT_SUPPORTED" || code === "NO_INVESTMENT_ACCOUNTS") return;
    throw e;
  }
}

const dirtyUsers = new Set<string>();

// Job claiming. With migration 0006 the claim_webhook_jobs RPC leases rows with FOR UPDATE SKIP LOCKED,
// so several workers can run at once. Without it, fall back to a plain select (one worker only).
const JOB_LEASE_SECONDS = 15 * 60;
let leaseClaims: boolean | null = null; // null = not probed yet

async function claimJobs() {
  if (leaseClaims !== false) {
    const { data, error } = await db.rpc("claim_webhook_jobs", { p_limit: JOB_BATCH, p_max_attempts: MAX_ATTEMPTS, p_lease_seconds: JOB_LEASE_SECONDS });
    if (!error) {
      leaseClaims = true;
      return ((data ?? []) as { created_at: string }[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    // function missing (PostgREST PGRST202 / Postgres 42883): 0006 not applied yet
    if (error.code !== "PGRST202" && error.code !== "42883") throw new Error(`claim_webhook_jobs: ${error.message}`);
    leaseClaims = false;
    log("migration 0006 not applied: claiming jobs without locks, run only one worker");
  }
  const { data: rows } = await db.from("webhook_logs").select("*").eq("processed", false).lt("attempts", MAX_ATTEMPTS).order("created_at").limit(50);
  // backoff: attempt n waits 20s·n² after the job was created (0s, 20s, 80s, 3m, 5m…)
  return (rows ?? []).filter((j) => Date.now() >= new Date(j.created_at).getTime() + 20_000 * j.attempts ** 2).slice(0, JOB_BATCH);
}

/** Update a claimed job and release its lease (the column only exists once 0006 is applied). */
function settleJob(id: string, patch: Record<string, unknown>) {
  return db.from("webhook_logs").update(leaseClaims ? { ...patch, locked_until: null } : patch).eq("id", id);
}

async function processJobs() {
  const jobs = (await claimJobs()) as any[];
  for (const job of jobs) {
    const { webhook_type: type, webhook_code: code } = job;
    const itemId = job.payload?.item_id as string | undefined;
    try {
      const item = itemId ? await itemFor(itemId) : null;
      if (item) {
        if (type === "INTERNAL" || type === "TRANSACTIONS") {
          await refreshAccounts(item);
          if (type === "INTERNAL" || code === "SYNC_UPDATES_AVAILABLE" || code === "INITIAL_UPDATE" || code === "HISTORICAL_UPDATE" || code === "DEFAULT_UPDATE") {
            const r = await syncTransactions(item);
            dirtyUsers.add(r.userId);
            if (type === "INTERNAL") {
              await syncHoldings(item);
              // Right after Link, Plaid is usually still pulling history. Without a webhook
              // nothing would tell us when it's ready, so the first-sync job retries itself.
              if (!r.complete && job.attempts + 1 < MAX_ATTEMPTS) {
                await settleJob(job.id, { attempts: job.attempts + 1, error: "waiting for Plaid to finish the initial pull" });
                continue;
              }
            }
          }
        } else if (type === "HOLDINGS" || type === "INVESTMENTS_TRANSACTIONS") {
          await refreshAccounts(item); await syncHoldings(item);
        } else if (type === "ITEM") {
          log(`item ${itemId} ${code}`, job.payload?.error?.error_code ?? ""); // surfaced via webhook_logs; re-auth needs Link update mode
        }
      }
      await settleJob(job.id, { processed: true, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`job ${type}/${code} failed:`, msg);
      await settleJob(job.id, { attempts: job.attempts + 1, error: msg.slice(0, 500) });
    }
  }
}

// ── categorization ──────────────────────────────────────────────────────────────────────────
// 1. merchant cache: rows whose normalized merchant (per user, money in/out) was already categorized
//    get that answer instantly, no LLM call. Built from the DB, newest decision first, so manual
//    recategorizations win; refreshed every CACHE_TTL and fed by new LLM answers.
// 2. the rest are deduped by merchant and sent to the categorize model in one structured-JSON call
//    of up to CATEGORIZE_BATCH merchants. A failing batch is split in half and retried; a single
//    merchant that keeps failing falls back to the regex rules so the queue never stalls.
// 3. repeated failures (Ollama down, model missing) back off exponentially; cache hits keep flowing.
// 20, not 50: with 50 the 1.5B model copied answers onto the wrong items (see plausibleMerchant)
const BATCH = Math.max(1, Number(process.env.CATEGORIZE_BATCH ?? 20));
const FETCH = 1000;                       // queued rows examined per pass (cache hits are cheap)
const LLM_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000);
const CACHE_TTL = 15 * 60_000;
const MIN_CACHE_CONFIDENCE = 0.6;         // don't propagate low-confidence guesses
const ITEM_MAX_FAILS = 3;
const DRAIN_MS = 120_000;                 // max time per tick on categorization, so Plaid jobs aren't starved

interface Queued { id: string; user_id: string; raw_merchant_string: string; cleaned_merchant_name: string | null; amount: number; iso_currency_code: string }
interface Labels { cleaned_merchant_name: string; category: string; subcategory: string | null; ai_confidence_score: number; ai_tags: string[] }

const cache = new Map<string, Labels>();
let cacheBuiltAt = 0;
const itemFails = new Map<string, number>();
let failStreak = 0, backoffUntil = 0;
let ollamaUp = true, firstBatch = true;
const warned = new Set<string>();
const warnOnce = (k: string, msg: string) => { if (!warned.has(k)) { warned.add(k); log(msg); } };
const keyOf = (r: Pick<Queued, "user_id" | "raw_merchant_string" | "amount">) => cacheKey(r.user_id, r.raw_merchant_string, Number(r.amount));
const cleanTags = (t: unknown) => (Array.isArray(t) ? t : []).filter((x): x is string => typeof x === "string" && !x.startsWith("anomaly:"));
const backoff = () => { failStreak++; const wait = Math.min(5_000 * 2 ** failStreak, 600_000); backoffUntil = Date.now() + wait; return wait; };

async function buildCache() {
  const t0 = Date.now();
  cache.clear();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db.from("transactions")
      .select("user_id,raw_merchant_string,amount,cleaned_merchant_name,category,subcategory,ai_confidence_score,ai_tags")
      .not("category", "is", null).order("updated_at", { ascending: false }).range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      const k = keyOf(r);
      const conf = r.ai_confidence_score == null ? 1 : Number(r.ai_confidence_score);
      // never propagate a label that is impossible (Income on spend) or belongs to another merchant
      if (!k || cache.has(k) || conf < MIN_CACHE_CONFIDENCE || impossibleCategory(r.category, Number(r.amount))
        || (r.cleaned_merchant_name && !plausibleMerchant(r.cleaned_merchant_name, r.raw_merchant_string))) continue;
      cache.set(k, { cleaned_merchant_name: r.cleaned_merchant_name ?? r.raw_merchant_string, category: r.category, subcategory: r.subcategory, ai_confidence_score: conf, ai_tags: cleanTags(r.ai_tags) });
    }
    if ((data ?? []).length < 1000) break;
  }
  cacheBuiltAt = Date.now();
  log(`merchant cache: ${cache.size} merchants (${Date.now() - t0}ms)`);
}

/** Write labels, one request per distinct label set (cache hits for one merchant share a payload). */
async function writeLabels(rows: { row: Queued; labels: Labels }[]) {
  const groups = new Map<string, { labels: Labels; ids: string[] }>();
  for (const { row, labels } of rows) {
    const k = JSON.stringify(labels);
    (groups.get(k) ?? groups.set(k, { labels, ids: [] }).get(k)!).ids.push(row.id);
    dirtyUsers.add(row.user_id);
  }
  for (const { labels, ids } of groups.values())
    for (let i = 0; i < ids.length; i += 200)
      // `.is(category, null)`: never overwrite a label set meanwhile (e.g. by the user)
      await db.from("transactions").update(labels).in("id", ids.slice(i, i + 200)).is("category", null).throwOnError();
}

const toLabels = (r: CategorizeResult): Labels => ({ cleaned_merchant_name: r.merchant, category: r.category, subcategory: r.subcategory, ai_confidence_score: Math.round(r.confidence * 100) / 100, ai_tags: r.tags });
const toInput = (t: Queued): CategorizeInput => ({ id: t.id, raw: t.raw_merchant_string, amount: Number(t.amount), currency: t.iso_currency_code, merchantHint: t.cleaned_merchant_name });
const describe = (e: unknown) => e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${Math.round(LLM_TIMEOUT / 1000)}s` : e.message) : String(e);
/** errors where splitting the batch can't help */
const fatal = (e: unknown) => /not found|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(describe(e) + String((e as { cause?: unknown })?.cause ?? ""));

/** Pick the categorize model; fall back to the assistant model if it isn't pulled yet. null = unavailable. */
async function resolveModel(): Promise<string | null> {
  const installed = await ollamaModels();
  if (!installed) return null;
  if (hasModel(installed, OLLAMA_CATEGORIZE_MODEL)) return OLLAMA_CATEGORIZE_MODEL;
  if (hasModel(installed, OLLAMA_MODEL)) {
    warnOnce("fallback", `categorize model ${OLLAMA_CATEGORIZE_MODEL} isn't installed; using ${OLLAMA_MODEL} (slower). Run: ollama pull ${OLLAMA_CATEGORIZE_MODEL}`);
    return OLLAMA_MODEL;
  }
  warnOnce("nomodel", `neither ${OLLAMA_CATEGORIZE_MODEL} nor ${OLLAMA_MODEL} is installed in Ollama. Run: ollama pull ${OLLAMA_CATEGORIZE_MODEL}`);
  return null;
}

/** One LLM call; on failure split in half and retry. Returns results for the items that succeeded. */
async function llmWithSplit(items: Queued[], model: string): Promise<Map<string, CategorizeResult>> {
  const out = new Map<string, CategorizeResult>();
  const bump = (t: Queued, why: string) => {
    const n = (itemFails.get(t.id) ?? 0) + 1;
    if (n < ITEM_MAX_FAILS) { itemFails.set(t.id, n); return; }
    itemFails.delete(t.id);
    out.set(t.id, categorizeWithRules(toInput(t)));
    log(`  gave up on "${t.raw_merchant_string.slice(0, 50)}" after ${n} LLM failures (${why}); used rules`);
  };
  try {
    const res = await categorizeWithLLM(items.map(toInput), { model, timeoutMs: LLM_TIMEOUT, missing: "omit" });
    for (const r of res) { out.set(r.id, r); itemFails.delete(r.id); }
    for (const t of items) if (!out.has(t.id)) bump(t, "missing or impossible label in model output");
    return out;
  } catch (e) {
    if (fatal(e)) throw e;
    if (items.length === 1) { bump(items[0], describe(e).slice(0, 80)); return out; }
    const mid = Math.ceil(items.length / 2);
    log(`  batch of ${items.length} failed (${describe(e).slice(0, 120)}); splitting ${mid}+${items.length - mid}`);
    for (const half of [items.slice(0, mid), items.slice(mid)]) for (const [k, v] of await llmWithSplit(half, model)) out.set(k, v);
    return out;
  }
}

/** One categorization pass. Returns true if it made progress and more work may remain. */
async function categorize(): Promise<boolean> {
  if (Date.now() - cacheBuiltAt > CACHE_TTL) await buildCache();
  const { data, error } = await db.from("transactions").select("id,user_id,raw_merchant_string,cleaned_merchant_name,amount,iso_currency_code")
    .is("category", null).order("created_at").limit(FETCH);
  if (error) throw error;
  const queued = (data ?? []) as Queued[];
  if (!queued.length) return false;

  // 1. bank wording that decides the label on its own (e-Transfers, direct deposits), then the cache
  const t0 = Date.now();
  const hits: { row: Queued; labels: Labels }[] = [], misses: Queued[] = [];
  for (const r of queued) {
    const f = forcedLabel(toInput(r));
    if (f) { hits.push({ row: r, labels: toLabels(f) }); continue; }
    const c = cache.get(keyOf(r)); if (c) hits.push({ row: r, labels: c }); else misses.push(r);
  }
  if (hits.length) {
    await writeLabels(hits);
    log(`cache: ${hits.length} of ${queued.length} queued applied instantly (${Date.now() - t0}ms), ${misses.length} need the LLM`);
  }
  if (!misses.length) return true;

  // 2. LLM, unless backing off
  if (Date.now() < backoffUntil) return hits.length > 0;
  const model = await resolveModel();
  if (!model) {
    if (ollamaUp) log(`Ollama unreachable at ${OLLAMA_URL} or no model installed; ${misses.length}+ transactions waiting (cache hits still apply)`);
    ollamaUp = false; backoff(); return hits.length > 0;
  }
  if (!ollamaUp) log("Ollama back online");
  ollamaUp = true;

  // one representative per merchant; its answer is applied to every queued row of that merchant
  const groups = new Map<string, Queued[]>();
  const gk = (r: Queued) => keyOf(r) || `id:${r.id}`;
  for (const r of misses) (groups.get(gk(r)) ?? groups.set(gk(r), []).get(gk(r))!).push(r);
  const reps = [...groups.values()].slice(0, BATCH).map((g) => g[0]);
  const covered = reps.reduce((n, r) => n + groups.get(gk(r))!.length, 0);
  log(`ollama: ${reps.length} merchants (${covered} txns) → ${model}…${firstBatch ? " (first call loads the model; can take a minute on CPU)" : ""}`);
  firstBatch = false;
  const t1 = Date.now();
  let results: Map<string, CategorizeResult>;
  try {
    results = await llmWithSplit(reps, model);
  } catch (e) {
    const wait = backoff();
    log(`ollama: batch failed (${describe(e).slice(0, 160)}); backing off ${Math.round(wait / 1000)}s`);
    return hits.length > 0;
  }
  const updates: { row: Queued; labels: Labels }[] = [];
  let viaRules = 0;
  for (const rep of reps) {
    const r = results.get(rep.id);
    if (!r) continue; // left queued; retried next pass
    if (r.source === "rules") viaRules++;
    const labels = toLabels(r), k = keyOf(rep);
    for (const row of groups.get(gk(rep))!) updates.push({ row, labels });
    if (k && r.source === "llm" && r.confidence >= MIN_CACHE_CONFIDENCE) cache.set(k, labels);
  }
  await writeLabels(updates);
  const secs = (Date.now() - t1) / 1000;
  if (results.size) failStreak = 0; else backoff();
  log(`ollama: ${results.size}/${reps.length} merchants → ${updates.length} txns in ${secs.toFixed(1)}s (${(results.size / Math.max(secs, 0.001)).toFixed(2)} merchants/s${viaRules ? `, ${viaRules} via rules fallback` : ""}), ${misses.length - covered} still queued`);
  return updates.length > 0 || hits.length > 0;
}

async function scanAnomalies() {
  for (const userId of [...dirtyUsers]) {
    dirtyUsers.delete(userId);
    const since = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
    const { data } = await db.from("transactions").select("*").eq("user_id", userId).gte("date", since);
    const txns = (data ?? []).map((t) => ({ ...t, amount: Number(t.amount) })) as Transaction[];
    const { data: accts } = await db.from("accounts").select("id,type").eq("user_id", userId);
    const found = detectAnomalies(markTransfers({ accounts: (accts ?? []) as Account[], transactions: txns }).transactions);
    const kindsById = new Map<string, string[]>();
    for (const a of found) (kindsById.get(a.transactionId) ?? kindsById.set(a.transactionId, []).get(a.transactionId)!).push(`anomaly:${a.kind}`);
    let changed = 0;
    for (const t of txns) {
      const kinds = kindsById.get(t.id) ?? [];
      const base = (t.ai_tags ?? []).filter((x) => !x.startsWith("anomaly:"));
      const nextTags = [...base, ...kinds];
      const flag = kinds.length > 0;
      if (flag === t.is_anomaly && JSON.stringify(nextTags) === JSON.stringify(t.ai_tags ?? [])) continue;
      await db.from("transactions").update({ is_anomaly: flag, ai_tags: nextTags }).eq("id", t.id);
      changed++;
    }
    if (changed) log(`anomaly scan ${userId.slice(0, 8)}: ${found.length} open, ${changed} updated`);
  }
}

let lastFx = 0;
/** USD-based reference rates (European Central Bank, via the free Frankfurter API — no key). */
async function refreshFx() {
  if (Date.now() - lastFx < 12 * 3600_000) return;
  lastFx = Date.now();
  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,CAD", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { date: string; rates: Record<string, number> };
    const rows = Object.entries(json.rates).filter(([, v]) => v > 0).map(([quote, rate]) => ({ base: "USD", quote, rate, as_of: json.date }));
    if (rows.length) await db.from("fx_rates").upsert(rows, { onConflict: "base,quote" }).throwOnError();
    log(`fx: ${rows.map((r) => `USD/${r.quote} ${r.rate}`).join("  ")} (${json.date})`);
  } catch (e) {
    log("fx refresh failed (keeping last stored rates):", e instanceof Error ? e.message : e);
  }
}

log(`worker up · poll ${POLL_MS}ms · categorize ${OLLAMA_CATEGORIZE_MODEL} (batch ${BATCH}) · assistant ${OLLAMA_MODEL} @ ${OLLAMA_URL}`);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
while (!stopping) {
  try {
    await refreshFx();
    await processJobs();
    // drain the categorization queue, but yield to Plaid jobs every DRAIN_MS
    const until = Date.now() + DRAIN_MS;
    while (!stopping && Date.now() < until && (await categorize()));
    await scanAnomalies();
  } catch (e) {
    log("tick failed:", e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
log("worker stopped");
