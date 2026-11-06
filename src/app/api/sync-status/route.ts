import { NextResponse } from "next/server";
import { DEMO_MODE } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Background sync progress for the signed-in user:
 *  - pulling: unprocessed Plaid sync jobs for the user's own items (webhook_logs is service-role only,
 *    so it's read here, filtered to item ids the user can see under RLS)
 *  - queued: transactions still waiting for categorization (RLS-scoped count)
 */
export async function GET() {
  if (DEMO_MODE) return NextResponse.json({ pulling: 0, queued: 0 });
  const { sb, user } = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [ins, q] = await Promise.all([
    sb.from("institutions").select("plaid_item_id"),
    sb.from("transactions").select("id", { count: "exact", head: true }).is("category", null),
  ]);
  const items = (ins.data ?? []).map((i) => i.plaid_item_id as string).filter(Boolean);
  let pulling = 0;
  if (items.length) {
    const { count } = await supabaseAdmin().from("webhook_logs").select("id", { count: "exact", head: true })
      .eq("processed", false).lt("attempts", 8 /* worker MAX_ATTEMPTS */).in("webhook_type", ["INTERNAL", "TRANSACTIONS"]).in("payload->>item_id", items);
    pulling = count ?? 0;
  }
  return NextResponse.json({ pulling, queued: q.count ?? 0 });
}
