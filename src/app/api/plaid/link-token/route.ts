import { NextResponse } from "next/server";
import { CountryCode, Products } from "plaid";
import { plaid } from "@/lib/plaid";
import { requireUser } from "@/lib/supabase/server";
import { DEMO_MODE } from "@/lib/env";

export async function POST() {
  if (DEMO_MODE) return NextResponse.json({ error: "Connect Supabase to link real accounts" }, { status: 400 });
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { data } = await plaid().linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: "Ledger",
      language: "en",
      country_codes: [CountryCode.Us, CountryCode.Ca],
      products: [Products.Transactions],
      optional_products: [Products.Investments],
      transactions: { days_requested: 730 },
      webhook: process.env.PLAID_WEBHOOK_URL || undefined,
    });
    return NextResponse.json({ link_token: data.link_token });
  } catch (e) {
    console.error("linkTokenCreate", e);
    return NextResponse.json({ error: "Could not start Plaid Link" }, { status: 502 });
  }
}
