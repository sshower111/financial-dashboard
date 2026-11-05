import { NextResponse } from "next/server";
import { DEMO_MODE } from "@/lib/env";
import { categorizeWithLLM, categorizeWithRules, type CategorizeInput } from "@/lib/ai/categorize";

/**
 * Demo-mode helper so the live simulator exercises the same local model the worker uses.
 * In live mode categorization runs only in the background worker.
 */
export async function POST(req: Request) {
  if (!DEMO_MODE) return NextResponse.json({ error: "categorization runs in the worker" }, { status: 404 });
  const { items } = (await req.json()) as { items: CategorizeInput[] };
  if (!Array.isArray(items) || items.length > 20) return NextResponse.json({ error: "1–20 items" }, { status: 400 });
  try { return NextResponse.json({ results: await categorizeWithLLM(items) }); }
  catch { return NextResponse.json({ results: items.map(categorizeWithRules) }); }
}
