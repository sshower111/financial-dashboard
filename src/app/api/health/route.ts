import { NextResponse } from "next/server";
import { OLLAMA_MODEL, ollamaHealthy } from "@/lib/ai/ollama";
import { DEMO_MODE } from "@/lib/env";

export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({ demo: DEMO_MODE, ollama: await ollamaHealthy(), model: OLLAMA_MODEL });
}
