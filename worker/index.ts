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
const { categorizeWithLLM } = await import("../src/lib/ai/categorize.ts");
const { ollamaHealthy, OLLAMA_MODEL, OLLAMA_URL } = await import("../src/lib/ai/ollama.ts");
const { detectAnomalies } = await import("../src/lib/finance/anomaly.ts");
import type { Transaction } from "../src/lib/types.ts";
import type { RemovedTransaction, Transaction as PlaidTxn } from "plaid";

const db = supabaseAdmin();
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
const BATCH = 10;
const MAX_ATTEMPTS = 8;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface Item { id: string; user_id: string; access_token: string; cursor: string | null; country: string }

async function itemFor(itemId: string): Promise<Item | null> {
  const { data } = await db.from("institutions").select("id,user_id,access_token,cursor,country").eq("plaid_item_id", itemId).maybeSingle();
  return data as Item | null;
}

async function refreshAccounts(item: Item) {
  const { data } = await plaid().accountsGet({ access_token: item.access_token });
  const rows = data.accounts.map((a) => ({
    institution_id: item.id, user_id: item.user_id, plaid_account_id: a.account_id,
    name: a.official_name || a.name, type: ACCOUNT_TYPES.has(a.type) ? a.type : "other", subtype: a.subtype ?? "",
    currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? (item.country === "CA" ? "CAD" : "USD"),
    current_balance: a.balances.current, available_balance: a.balances.available, limit_amount: a.balances.limit,
  })).filter((a) => SUPPORTED_CCY.has(a.currency));
  if (rows.length) await db.from("accounts").upsert(rows, { onConflict: "plaid_account_id" }).throwOnError();
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
  const rows = [...added, ...modified].map(toRow).filter((r): r is NonNullable<typeof r> => !!r);
  for (let i = 0; i < rows.length; i += 500) {
    // category columns are not in the payload, so modified rows keep their AI labels
    await db.from("transactions").upsert(rows.slice(i, i + 500), { onConflict: "plaid_transaction_id" }).throwOnError();
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

async function processJobs() {
  const { data: rows } = await db.from("webhook_logs").select("*").eq("processed", false).lt("attempts", MAX_ATTEMPTS).order("created_at").limit(50);
  // backoff: attempt n waits 20s·n² after the job was created (0s, 20s, 80s, 3m, 5m…)
  const jobs = (rows ?? []).filter((j) => Date.now() >= new Date(j.created_at).getTime() + 20_000 * j.attempts ** 2).slice(0, BATCH);
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
                await db.from("webhook_logs").update({ attempts: job.attempts + 1, error: "waiting for Plaid to finish the initial pull" }).eq("id", job.id);
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
      await db.from("webhook_logs").update({ processed: true, error: null }).eq("id", job.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`job ${type}/${code} failed:`, msg);
      await db.from("webhook_logs").update({ attempts: job.attempts + 1, error: msg.slice(0, 500) }).eq("id", job.id);
    }
  }
}

let ollamaUp = true;
let firstBatch = true;
async function categorize() {
  const { data } = await db.from("transactions").select("id,user_id,raw_merchant_string,cleaned_merchant_name,amount,iso_currency_code")
    .is("category", null).order("created_at").limit(BATCH);
  if (!data?.length) return 0;
  if (!(await ollamaHealthy())) {
    if (ollamaUp) log(`Ollama unreachable at ${OLLAMA_URL}; ${data.length}+ transactions waiting`);
    ollamaUp = false; return 0;
  }
  if (!ollamaUp) log("Ollama back online");
  ollamaUp = true;
  const t0 = Date.now();
  const { count } = await db.from("transactions").select("id", { count: "exact", head: true }).is("category", null);
  log(`categorizing ${data.length} of ${count ?? "?"} queued with ${OLLAMA_MODEL}…${firstBatch ? " (first call loads the model; can take a few minutes on CPU)" : ""}`);
  firstBatch = false;
  let results;
  try {
    results = await categorizeWithLLM(data.map((t) => ({ id: t.id, raw: t.raw_merchant_string, amount: Number(t.amount), currency: t.iso_currency_code, merchantHint: t.cleaned_merchant_name })));
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "timed out after 5 min" : e.message) : String(e);
    log(`categorization failed: ${msg.slice(0, 200)} — will retry next tick`);
    return 0;
  }
  const userOf = new Map(data.map((t) => [t.id, t.user_id as string]));
  await Promise.all(results.map(async (r) => {
    // merge AI tags with any anomaly tags already present
    await db.from("transactions").update({
      cleaned_merchant_name: r.merchant, category: r.category, subcategory: r.subcategory,
      ai_confidence_score: Math.round(r.confidence * 100) / 100, ai_tags: r.tags,
    }).eq("id", r.id).throwOnError();
    dirtyUsers.add(userOf.get(r.id)!);
  }));
  log(`categorized ${results.length} with ${OLLAMA_MODEL} in ${Date.now() - t0}ms`);
  return results.length;
}

async function scanAnomalies() {
  for (const userId of [...dirtyUsers]) {
    dirtyUsers.delete(userId);
    const since = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
    const { data } = await db.from("transactions").select("*").eq("user_id", userId).gte("date", since);
    const txns = (data ?? []).map((t) => ({ ...t, amount: Number(t.amount) })) as Transaction[];
    const found = detectAnomalies(txns);
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

log(`worker up · poll ${POLL_MS}ms · model ${OLLAMA_MODEL} @ ${OLLAMA_URL}`);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
while (!stopping) {
  try {
    await refreshFx();
    await processJobs();
    // keep draining the categorization queue while there is work
    while ((await categorize()) === BATCH && !stopping);
    await scanAnomalies();
  } catch (e) {
    log("tick failed:", e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
log("worker stopped");
