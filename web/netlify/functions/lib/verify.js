import { isAddress, isSignature } from "./address.js";
import { assessTransaction } from "./assess.js";
import { referenceForClaim } from "./claim.js";
import { SIGNATURE_LIMIT } from "./rpc.js";
import { spentKey } from "./store.js";
import { readUnlockToken, signUnlockToken } from "./token.js";

const fail = (status, reason) => ({ ok: false, status, reason });

/** Nothing could be concluded. The caller keeps its claim and asks again; nothing is granted. */
const CANNOT_TELL = fail(503, "unavailable");

/**
 * The transaction to judge, found from the page's signature or from the
 * reference, or the answer to give when there is none to judge yet.
 *
 * The signature is the one the wallet returned to the page. It is only a
 * pointer: whatever it points at must still name the claim's reference, or
 * it is ignored. With it, transactions that third parties add naming the
 * reference are never looked at. Without it (the wallet failed after
 * sending, or the page was closed), the payment is the oldest successful
 * transaction naming the reference, because the reference is unknown to
 * everyone else until that transaction is broadcast.
 */
async function findPayment(rpc, reference, signature) {
  if (signature !== undefined) {
    const [status] = await rpc.getSignatureStatuses([signature]);
    // Unknown to the node: look the claim up by reference instead, in case
    // what landed is not what the wallet reported.
    if (status) return { row: { signature, ...status }, pointed: true };
  }

  const rows = await rpc.getSignaturesForAddress(reference);
  // Not an error: a payment sent a moment ago is simply not visible yet. 202, like "pending",
  // so a browser waiting on its own payment does not fill its console with failed requests.
  if (rows.length === 0) return { answer: fail(202, "not_found") };
  // A full page means older transactions exist that were not returned, so the oldest is unknown.
  if (rows.length >= SIGNATURE_LIMIT) return { answer: CANNOT_TELL };
  const succeeded = rows.filter((row) => row.err === null);
  if (succeeded.length === 0) return { answer: fail(400, "failed") };
  return { row: succeeded.at(-1), pointed: false };
}

/**
 * Confirm the payment behind a claim and issue a short-lived unlock token for it.
 *
 * Nothing the caller says is believed. The claim only proves which reference
 * they may speak for, and the optional signature only says where to look.
 * The payment itself is read from the finalized transaction: it succeeded,
 * it names the reference, and the payee received exactly 1.00 USDC.
 *
 * A 400 is a verdict about the claim's own transaction, and the page gives
 * the attempt up on it. Anything short of that (an odd answer from the node,
 * a reference too crowded to read) is a 503 and decides nothing.
 *
 * This function writes nothing. A payment is spent in `consumeUnlock`, keyed
 * by the transaction signature, so one transaction unlocks one grind no
 * matter how many references or tokens point at it.
 */
export async function verifyPayment({ claim, signature, rpc, store, payTo, secret, now = Date.now() }) {
  const reference = referenceForClaim(claim);
  if (!reference) return fail(400, "invalid");
  if (signature !== undefined && !isSignature(signature)) return fail(400, "invalid");
  if (!isAddress(payTo) || !secret) return fail(500, "config");

  const { row, pointed, answer } = await findPayment(rpc, reference, signature);
  if (answer) return answer;
  if (row.confirmationStatus === "processed" || row.confirmationStatus === "confirmed") {
    return fail(202, "pending");
  }

  // Asked for at "finalized": null until the transaction can no longer be rolled back.
  const tx = await rpc.getTransaction(row.signature);
  if (!tx) return fail(202, "pending");

  // A failure is read from the transaction as well, so it is only reported for this claim's own.
  const assessment = assessTransaction(tx, { payTo, reference, signature: row.signature });
  if (!assessment.ok) {
    // The page pointed at a transaction that is not this claim's: judge the claim without it.
    if (assessment.reason === "unrelated" && pointed) {
      return verifyPayment({ claim, rpc, store, payTo, secret, now });
    }
    if (assessment.reason === "malformed" || assessment.reason === "unrelated") return CANNOT_TELL;
    return fail(400, assessment.reason);
  }

  // Checked only once the transaction is known to be this claim's own payment.
  if (await store.get(spentKey(row.signature))) return fail(409, "reused");

  return { ok: true, status: 200, ...signUnlockToken({ signature: row.signature, secret, now }) };
}

/**
 * Spend the payment a token points at. The single conditional write is the
 * whole decision: the first request to create the record wins, and every
 * other token for that transaction is refused from then on.
 *
 * The token that won gets the same answer every time it is presented, before
 * or after it expires, so a page whose response was lost can ask again
 * without losing the grind it paid for. That writes nothing: the payment was
 * spent once. Only the claim holder was ever given the token, and the grind
 * runs in their own browser, so a repeated "ok" gives nobody anything new.
 */
export async function consumeUnlock({ token, store, secret, now = Date.now() }) {
  const parsed = readUnlockToken(token, secret, now);
  if (!parsed.ok && parsed.reason !== "expired") return fail(400, parsed.reason);

  const key = spentKey(parsed.signature);
  if (parsed.ok && (await store.create(key, { at: now, jti: parsed.jti }))) return { ok: true, status: 200 };

  const spent = await store.get(key);
  if (spent?.jti === parsed.jti) return { ok: true, status: 200 };
  if (!parsed.ok) return fail(401, "expired");
  return fail(409, "reused");
}
