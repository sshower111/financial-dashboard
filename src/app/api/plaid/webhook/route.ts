import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyPlaidWebhook } from "@/lib/plaid-verify";

/**
 * Plaid webhook receiver. Verifies, records and returns 200 immediately —
 * the worker does the actual sync + AI categorization asynchronously.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (process.env.PLAID_VERIFY_WEBHOOKS !== "false") {
    const ok = await verifyPlaidWebhook(raw, req.headers.get("plaid-verification"));
    if (!ok) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let payload: { webhook_type?: string; webhook_code?: string };
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { error } = await supabaseAdmin().from("webhook_logs").insert({
    webhook_type: payload.webhook_type ?? "UNKNOWN", webhook_code: payload.webhook_code ?? "UNKNOWN", payload,
  });
  if (error) { console.error("webhook insert", error); return NextResponse.json({ error: "store failed" }, { status: 500 }); }
  return NextResponse.json({ received: true });
}
