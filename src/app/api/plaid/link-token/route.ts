import { NextResponse } from "next/server";
import { Products } from "plaid";
import { plaid, plaidCountries } from "@/lib/plaid";
import { requireUser } from "@/lib/supabase/server";
import { DEMO_MODE } from "@/lib/env";

export async function POST() {
  if (DEMO_MODE) return NextResponse.json({ error: "Connect Supabase to link real accounts" }, { status: 400 });
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { data } = await plaid().linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: "Financial Dashboard",
      language: "en",
      country_codes: plaidCountries(),
      products: [Products.Transactions],
      optional_products: [Products.Investments],
      transactions: { days_requested: 730 },
      webhook: process.env.PLAID_WEBHOOK_URL || undefined,
      // OAuth banks (Chase, BofA, Wells Fargo and others) send the user back here; must be
      // registered under Developers → API → Allowed redirect URIs in the Plaid dashboard
      redirect_uri: process.env.PLAID_REDIRECT_URI || undefined,
    });
    return NextResponse.json({ link_token: data.link_token });
  } catch (e) {
    console.error("linkTokenCreate", e);
    return NextResponse.json({ error: "Could not start Plaid Link" }, { status: 502 });
  }
}
