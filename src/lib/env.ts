export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
/** Demo mode: no Supabase configured → synthetic ledger, nothing persisted server-side. */
export const DEMO_MODE = !SUPABASE_URL || !SUPABASE_ANON_KEY;
