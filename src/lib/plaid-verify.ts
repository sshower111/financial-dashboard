import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { plaid } from "./plaid";

const keyCache = new Map<string, JWK>();

/**
 * Verify Plaid's `Plaid-Verification` JWT (ES256) and that it signs this exact body.
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 */
export async function verifyPlaidWebhook(rawBody: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const { alg, kid } = decodeProtectedHeader(token);
    if (alg !== "ES256" || !kid) return false;
    let jwk = keyCache.get(kid);
    if (!jwk) {
      const { data } = await plaid().webhookVerificationKeyGet({ key_id: kid });
      if (data.key.expired_at) return false;
      jwk = data.key as unknown as JWK;
      keyCache.set(kid, jwk);
    }
    const { payload } = await jwtVerify(token, await importJWK(jwk, "ES256"), { maxTokenAge: "5 min" });
    const expected = Buffer.from(String(payload.request_body_sha256 ?? ""), "hex");
    const actual = createHash("sha256").update(rawBody).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
