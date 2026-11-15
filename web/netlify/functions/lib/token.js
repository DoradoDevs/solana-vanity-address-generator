import { createHmac, timingSafeEqual } from "node:crypto";
import { TOKEN_TTL_MS } from "./constants.js";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function signUnlockToken({
  reference,
  secret,
  now = Date.now(),
  ttlMs = TOKEN_TTL_MS,
}) {
  if (!secret) throw new Error("missing unlock secret");
  const payload = { v: 1, ref: reference, exp: now + ttlMs };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

/**
 * @returns {{ ok: true, ref: string, exp: number } | { ok: false, reason: "bad" | "expired", ref?: string }}
 */
export function readUnlockToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== "string") return { ok: false, reason: "bad" };
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "bad" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad" };
  }
  if (payload?.v !== 1 || typeof payload.ref !== "string" || typeof payload.exp !== "number") {
    return { ok: false, reason: "bad" };
  }
  if (payload.exp < now) return { ok: false, reason: "expired", ref: payload.ref };
  return { ok: true, ref: payload.ref, exp: payload.exp };
}
