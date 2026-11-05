import { NextResponse } from "next/server";
import { CountryCode } from "plaid";
import { ACCOUNT_TYPES, SUPPORTED_CCY, plaid, plaidCountries } from "@/lib/plaid";
import { requireUser } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Exchange a Link public_token, store the item server-side, and enqueue the first sync. */
export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { public_token } = (await req.json()) as { public_token?: string };
  if (!public_token) return NextResponse.json({ error: "public_token required" }, { status: 400 });

  const p = plaid(), db = supabaseAdmin();
  try {
    const { data: ex } = await p.itemPublicTokenExchange({ public_token });
    const { data: item } = await p.itemGet({ access_token: ex.access_token });
    const instId = item.item.institution_id ?? "unknown";
    let name = "Institution", country: "US" | "CA" = "US";
    if (item.item.institution_id) {
      const { data: inst } = await p.institutionsGetById({ institution_id: instId, country_codes: plaidCountries() });
      name = inst.institution.name;
      country = inst.institution.country_codes.includes(CountryCode.Ca) && !inst.institution.country_codes.includes(CountryCode.Us) ? "CA" : "US";
    }
    const { data: row, error } = await db.from("institutions").insert({
      user_id: user.id, plaid_item_id: ex.item_id, plaid_institution_id: instId, name, country, access_token: ex.access_token,
    }).select("id").single();
    if (error) throw error;

    const { data: acc } = await p.accountsGet({ access_token: ex.access_token });
    const rows = acc.accounts
      .map((a) => ({
        institution_id: row.id, user_id: user.id, plaid_account_id: a.account_id,
        name: a.official_name || a.name, type: ACCOUNT_TYPES.has(a.type) ? a.type : "other", subtype: a.subtype ?? "",
        currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? (country === "CA" ? "CAD" : "USD"),
        current_balance: a.balances.current, available_balance: a.balances.available, limit_amount: a.balances.limit,
      }))
      .filter((a) => SUPPORTED_CCY.has(a.currency));
    if (rows.length) {
      const { error: e2 } = await db.from("accounts").upsert(rows, { onConflict: "plaid_account_id" });
      if (e2) throw e2;
    }
    await db.from("webhook_logs").insert({ webhook_type: "INTERNAL", webhook_code: "INITIAL_SYNC", payload: { item_id: ex.item_id } });
    return NextResponse.json({ ok: true, institution: name, accounts: rows.length });
  } catch (e) {
    console.error("plaid exchange", e);
    return NextResponse.json({ error: "Could not link this institution" }, { status: 502 });
  }
}
