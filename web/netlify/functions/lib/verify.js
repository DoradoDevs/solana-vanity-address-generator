import { readUnlockToken, signUnlockToken } from "./token.js";
import { isAddress } from "./address.js";
import { assessTransaction } from "./assess.js";

async function findFinalized(rpc, reference) {
  const signatures = await rpc.getSignaturesForAddress(reference);
  for (const row of signatures || []) {
    if (row.confirmationStatus !== "finalized" || row.err) continue;
    const tx = await rpc.getTransaction(row.signature);
    if (tx) return { signature: row.signature, tx };
  }
  if ((signatures || []).length > 0) return { pending: true };
  return { pending: true, empty: true };
}

/**
 * Confirm a 1.00 USDC payment, remember it, and issue one short-lived unlock token.
 * A reference that was already consumed for a grind is rejected.
 * A reference that was paid but not yet consumed returns a fresh token.
 */
export async function verifyPayment({
  reference,
  asset = "usdc",
  rpc,
  store,
  payTo,
  secret,
  now = Date.now(),
}) {
  if (!isAddress(reference)) return { ok: false, status: 400, reason: "invalid" };
  if (asset !== "usdc") return { ok: false, status: 400, reason: "invalid" };
  if (!isAddress(payTo)) return { ok: false, status: 500, reason: "config" };
  if (!secret) return { ok: false, status: 500, reason: "config" };

  const existing = await store.get(reference);
  if (existing?.status === "consumed") {
    return { ok: false, status: 409, reason: "reused" };
  }
  if (existing?.status === "paid") {
    const issued = signUnlockToken({ reference, secret, now });
    return { ok: true, status: 200, ...issued, asset: existing.asset };
  }

  const found = await findFinalized(rpc, reference);
  if (found.empty) return { ok: false, status: 404, reason: "not_found" };
  if (!found.tx) return { ok: false, status: 202, reason: "pending" };

  const assessment = assessTransaction(found.tx, { payTo, reference });
  if (!assessment.ok) return { ok: false, status: 400, ...assessment };

  await store.set(reference, {
    status: "paid",
    asset: "usdc",
    signature: found.signature,
    at: now,
  });
  const issued = signUnlockToken({ reference, secret, now });
  return { ok: true, status: 200, ...issued, asset: "usdc" };
}

export async function consumeUnlock({ token, store, secret, now = Date.now() }) {
  const parsed = readUnlockToken(token, secret, now);
  if (!parsed.ok) {
    return {
      ok: false,
      status: parsed.reason === "expired" ? 401 : 400,
      reason: parsed.reason,
    };
  }
  const record = await store.get(parsed.ref);
  if (!record) return { ok: false, status: 400, reason: "invalid" };
  if (record.status === "consumed") return { ok: false, status: 409, reason: "reused" };
  if (record.status !== "paid") return { ok: false, status: 400, reason: "invalid" };
  await store.set(parsed.ref, { ...record, status: "consumed", consumedAt: now });
  return { ok: true, status: 200, reference: parsed.ref };
}
