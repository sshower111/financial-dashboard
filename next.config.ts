import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Ollama endpoint is only ever called server-side (API routes + worker).
  serverExternalPackages: ["plaid"],
  // lets the dev server be used through an HTTPS tunnel (needed for Plaid OAuth + webhooks)
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok.app", "*.ngrok.io", "*.trycloudflare.com"],
};

export default nextConfig;
