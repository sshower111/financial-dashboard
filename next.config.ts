import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Ollama endpoint is only ever called server-side (API routes + worker).
  serverExternalPackages: ["plaid"],
};

export default nextConfig;
