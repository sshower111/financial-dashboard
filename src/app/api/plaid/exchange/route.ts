import { NextResponse } from "next/server";
import { CountryCode } from "plaid";
import { ACCOUNT_TYPES, SUPPORTED_CCY, plaid, plaidCountries } from "@/lib/plaid";
import { matchExisting, type LinkedAccount } from "@/lib/link-dedupe";
import { DEFAULT_DASHBOARD } from "@/lib/finance/scope";
import { requireUser } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Exchange a Link public_token, store the item server-side, and enqueue the first sync.
 *  - accounts land on the dashboard that was open when linking (`dashboard` in the body)
 *  - accounts already linked through an earlier connection to the same bank are skipped; if nothing
 *    is new, the new Plaid item is removed again (no duplicate import, no extra Plaid billing)
 */
export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { public_token, dashboard } = (await req.json()) as { public_token?: string; dashboard?: string };
  if (!public_token) return NextResponse.json({ error: "public_token required" }, { status: 400 });
  const target = typeof dashboard === "string" && /^[\w-]{1,40}$/.test(dashboard) ? dashboard : DEFAULT_DASHBOARD;

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

    const { data: acc } = await p.accountsGet({ access_token: ex.access_token });
    const incoming = acc.accounts
      .map((a) => ({
        account_id: a.account_id, mask: a.mask ?? null,
        name: a.official_name || a.name, type: ACCOUNT_TYPES.has(a.type) ? a.type : "other", subtype: a.subtype ?? "",
        currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? (country === "CA" ? "CAD" : "USD"),
        current_balance: a.balances.current, available_balance: a.balances.available, limit_amount: a.balances.limit,
      }))
      .filter((a) => SUPPORTED_CCY.has(a.currency));

    // accounts already linked via an earlier connection to this bank
    const { data: prevInst } = await db.from("institutions").select("id").eq("user_id", user.id).eq("plaid_institution_id", instId);
    const prevIds = (prevInst ?? []).map((r) => r.id as string);
    const { data: existing } = prevIds.length
      ? await db.from("accounts").select("id,name,type,subtype,mask").in("institution_id", prevIds)
      : { data: [] as (LinkedAccount & { id: string })[] };
    const dupes = matchExisting(incoming, (existing ?? []) as (LinkedAccount & { id: string })[]);
    const fresh = incoming.filter((a) => !dupes.has(a.account_id));

    if (!fresh.length) {
      await p.itemRemove({ access_token: ex.access_token }).catch((e) => console.error("plaid itemRemove (duplicate link)", e));
      return NextResponse.json({ error: `${name} is already linked (${dupes.size} account${dupes.size === 1 ? "" : "s"}). Nothing imported.`, duplicate: true }, { status: 409 });
    }

    const { data: row, error } = await db.from("institutions").insert({
      user_id: user.id, plaid_item_id: ex.item_id, plaid_institution_id: instId, name, country, access_token: ex.access_token,
    }).select("id").single();
    if (error) throw error;
    // only new accounts are stored; the worker syncs transactions only for stored accounts
    const { error: e2 } = await db.from("accounts").insert(fresh.map(({ account_id, ...a }) => ({
      ...a, institution_id: row.id, user_id: user.id, plaid_account_id: account_id, owner_label: target,
    })));
    if (e2) throw e2;
    await db.from("webhook_logs").insert({ webhook_type: "INTERNAL", webhook_code: "INITIAL_SYNC", payload: { item_id: ex.item_id } });
    return NextResponse.json({ ok: true, institution: name, accounts: fresh.length, skipped: dupes.size });
  } catch (e) {
    console.error("plaid exchange", e);
    return NextResponse.json({ error: "Could not link this institution" }, { status: 502 });
  }
}
