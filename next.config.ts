import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Ollama endpoint is only ever called server-side (API routes + worker).
  serverExternalPackages: ["plaid"],
  // lets the dev server be used through an HTTPS tunnel (needed for Plaid OAuth + webhooks)
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.dev", "*.ngrok.app", "*.ngrok.io", "*.trycloudflare.com"],
  // don't let `next dev` write/re-add its agent-rules block to AGENTS.md (CLAUDE.md is the source of truth)
  agentRules: false,
};

export default nextConfig;
