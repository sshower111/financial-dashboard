"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { DEMO_MODE } from "@/lib/env";

export default function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/auth/callback` } });
    if (error) { setErr(error.message); setState("error"); } else setState("sent");
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm border border-line">
        <div className="border-b border-line px-5 py-4">
          <div className="text-[15px] font-semibold tracking-tight">Financial Dashboard</div>
          <div className="label mt-0.5">Sign in with a one-time email link</div>
        </div>
        {DEMO_MODE ? (
          <p className="px-5 py-5 text-ink-2">Supabase isn&apos;t configured, so the app runs on demo data. <a className="text-accent underline underline-offset-2" href="/">Open the dashboard</a>.</p>
        ) : state === "sent" ? (
          <p className="px-5 py-5 text-ink-2">Check <span className="num text-ink">{email}</span> for a sign-in link.</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3 px-5 py-5">
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-9 border border-line bg-bg px-3 outline-none focus:border-ink" />
            <button disabled={state === "sending"} className="h-9 bg-accent text-accent-ink disabled:opacity-60">{state === "sending" ? "Sending…" : "Send link"}</button>
            {state === "error" && <p className="text-[12px] text-accent">{err}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
