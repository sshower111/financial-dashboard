/**
 * One-off: fill transactions.plaid_category / plaid_category_confidence (migration 0008) for rows
 * synced before the worker stored them, by re-reading the last 2 years from Plaid /transactions/get.
 *
 *   npx tsx scripts/backfill-plaid-category.ts             fill the Plaid columns only
 *   npx tsx scripts/backfill-plaid-category.ts --requeue   also send every model/rule-labelled row back
 *                                                          to the worker queue (restart the worker first)
 *
 * --requeue keeps own-account transfers Plaid labelled at sync (tag plaid-pfc), except e-Transfers /
 * Zelle, restores Plaid's merchant name, and writes a backup of the old labels to <temp dir>/requeue-backup-<ts>.json.
 */
import { loadEnvFile } from "node:process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const f of [".env.local", ".env"]) if (existsSync(f)) loadEnvFile(f);

const { supabaseAdmin } = await import("../src/lib/supabase/admin.ts");
const { plaid } = await import("../src/lib/plaid.ts");
const { P2P_RE } = await import("../src/lib/finance/transfers.ts");

const db = supabaseAdmin();
const requeue = process.argv.includes("--requeue");
const day = (d: Date) => d.toISOString().slice(0, 10);

interface Info { detailed: string | null; confidence: string | null; merchant: string | null }
const info = new Map<string, Info>();

const { data: items } = await db.from("institutions").select("id,name,access_token").throwOnError();
for (const it of items ?? []) {
  let offset = 0, total = Infinity;
  try {
    while (offset < total) {
      const { data } = await plaid().transactionsGet({
        access_token: it.access_token, start_date: day(new Date(Date.now() - 730 * 86_400_000)), end_date: day(new Date()),
        options: { count: 500, offset },
      });
      total = data.total_transactions;
      for (const t of data.transactions) info.set(t.transaction_id, { detailed: t.personal_finance_category?.detailed ?? null, confidence: t.personal_finance_category?.confidence_level ?? null, merchant: t.merchant_name ?? null });
      offset += data.transactions.length;
      if (!data.transactions.length) break;
    }
    console.log(`${it.name}: ${total} transactions from Plaid`);
  } catch (e) {
    const err = (e as { response?: { data?: { error_code?: string } } }).response?.data?.error_code ?? String(e);
    console.log(`${it.name}: skipped (${err})`);
  }
}

// every row, paged
const rows: { id: string; plaid_transaction_id: string; raw_merchant_string: string; category: string | null; subcategory: string | null; cleaned_merchant_name: string | null; ai_confidence_score: number | null; ai_tags: string[] | null; plaid_category: string | null }[] = [];
for (let from = 0; ; from += 1000) {
  const { data } = await db.from("transactions").select("id,plaid_transaction_id,raw_merchant_string,category,subcategory,cleaned_merchant_name,ai_confidence_score,ai_tags,plaid_category").order("id").range(from, from + 999).throwOnError();
  rows.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}

/** Group ids by an identical patch so each distinct patch is one UPDATE … WHERE id IN (…). */
async function apply(patches: { id: string; patch: Record<string, unknown> }[], label: string) {
  const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  for (const { id, patch } of patches) { const k = JSON.stringify(patch); (groups.get(k) ?? groups.set(k, { patch, ids: [] }).get(k)!).ids.push(id); }
  const jobs = [...groups.values()].flatMap(({ patch, ids }) => Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) => ({ patch, ids: ids.slice(i * 200, i * 200 + 200) })));
  for (let i = 0; i < jobs.length; i += 8)
    await Promise.all(jobs.slice(i, i + 8).map(({ patch, ids }) => db.from("transactions").update(patch).in("id", ids).throwOnError()));
  console.log(`${label}: ${patches.length} rows in ${jobs.length} updates`);
}

await apply(rows.flatMap((r) => {
  const p = info.get(r.plaid_transaction_id);
  return p && p.detailed && !r.plaid_category ? [{ id: r.id, patch: { plaid_category: p.detailed, plaid_category_confidence: p.confidence } }] : [];
}), "Plaid category filled");
console.log(`not found at Plaid (older than 2 years or removed): ${rows.filter((r) => !info.has(r.plaid_transaction_id)).length}`);

if (requeue) {
  const keep = (r: (typeof rows)[number]) => r.category == null || ((r.ai_tags ?? []).includes("plaid-pfc") && !P2P_RE.test(r.raw_merchant_string));
  const redo = rows.filter((r) => !keep(r));
  const file = join(tmpdir(), `requeue-backup-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(redo.map(({ id, category, subcategory, cleaned_merchant_name, ai_confidence_score, ai_tags }) => ({ id, category, subcategory, cleaned_merchant_name, ai_confidence_score, ai_tags }))));
  console.log(`backup of ${redo.length} old labels: ${file}`);
  await apply(redo.map((r) => ({ id: r.id, patch: {
    category: null, subcategory: null, ai_confidence_score: null,
    // Plaid's merchant name (an earlier re-queue cleared it); the model's old name is not trusted
    cleaned_merchant_name: info.get(r.plaid_transaction_id)?.merchant ?? null,
  } })), "re-queued for the worker");
}
