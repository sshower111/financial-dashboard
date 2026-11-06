import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/origin";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const origin = publicOrigin(req);
  const code = u.searchParams.get("code");
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", origin));
  }
  return NextResponse.redirect(new URL("/login?error=auth", origin));
}
