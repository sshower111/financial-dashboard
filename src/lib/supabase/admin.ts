import { createClient } from "@supabase/supabase-js";

/** Service-role client: bypasses RLS. Server routes and the worker only — never import from client code. */
export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL are required");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
