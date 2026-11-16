import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TOKEN_TTL_MS } from "./constants.js";

const VERSION = 2;
const MAX_TOKEN_LENGTH = 512;

function mac(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * A short-lived capability to spend one specific payment: the transaction
 * signature, an expiry, and a random id that tells one issued token from
 * another. HMAC-SHA256 over the encoded payload with UNLOCK_SECRET.
 */
export function signUnlockToken({ signature, secret, now = Date.now(), ttlMs = TOKEN_TTL_MS }) {
  if (!secret) throw new Error("missing unlock secret");
  const payload = { v: VERSION, sig: signature, exp: now + ttlMs, jti: randomBytes(12).toString("base64url") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${body}.${mac(body, secret)}`, expiresAt: payload.exp };
}

/**
 * @returns {{ ok: true, signature: string, jti: string, exp: number }
 *   | { ok: false, reason: "expired", signature: string, jti: string }
 *   | { ok: false, reason: "bad" }}
 */
export function readUnlockToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "bad" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "bad" };
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(body, secret));
  // The signature is checked before anything in the payload is read.
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad" };
  }
  if (
    payload?.v !== VERSION ||
    typeof payload.sig !== "string" ||
    typeof payload.jti !== "string" ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "bad" };
  }
  // Expired but authentic: what it names is returned so the ledger can still be asked about it.
  if (payload.exp < now) return { ok: false, reason: "expired", signature: payload.sig, jti: payload.jti };
  return { ok: true, signature: payload.sig, jti: payload.jti, exp: payload.exp };
}
