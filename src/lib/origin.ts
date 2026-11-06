/**
 * The origin the browser actually used. Behind a tunnel (ngrok) the server sees
 * itself as localhost:3000, so `req.url` would send redirects to https://localhost:3000.
 * Prefer the forwarded host/proto headers the proxy sets.
 */
export function publicOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host");
  if (!host) return new URL(req.url).origin;
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim()
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
