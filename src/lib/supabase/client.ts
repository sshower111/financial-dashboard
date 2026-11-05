"use client";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../env";

let client: ReturnType<typeof createBrowserClient> | null = null;
export function supabaseBrowser() {
  return (client ??= createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY));
}
