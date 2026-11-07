import { NextResponse } from "next/server";
import { plaid } from "@/lib/plaid";
import { requireUser } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Unlink a bank connection: remove the item at Plaid (stops billing / webhooks), then delete the
 * institution row; accounts, transactions and holdings cascade. Only the owner's own rows.
 */
export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { institution_id } = (await req.json()) as { institution_id?: string };
  if (!institution_id) return NextResponse.json({ error: "institution_id required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: inst } = await db.from("institutions").select("id,name,access_token").eq("id", institution_id).eq("user_id", user.id).maybeSingle();
  if (!inst) return NextResponse.json({ error: "not found" }, { status: 404 });
  let plaidRemoved = true;
  try { await plaid().itemRemove({ access_token: inst.access_token }); }
  catch (e) { plaidRemoved = false; console.error("plaid itemRemove", e); } // already removed / revoked: still delete locally
  const { error } = await db.from("institutions").delete().eq("id", inst.id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, institution: inst.name, plaidRemoved });
}
