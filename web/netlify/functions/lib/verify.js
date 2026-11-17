import { isAddress, isSignature } from "./address.js";
import { assessTransaction } from "./assess.js";
import { referenceForClaim } from "./claim.js";
import { SIGNATURE_LIMIT } from "./rpc.js";
import { spentKey } from "./store.js";
import { readUnlockToken, signUnlockToken } from "./token.js";

const fail = (status, reason) => ({ ok: false, status, reason });

/** Nothing could be concluded. The caller keeps its claim and asks again; nothing is granted. */
const CANNOT_TELL = fail(503, "unavailable");
const PENDING = fail(202, "pending");
// Not an error: a payment sent a moment ago is simply not visible yet. 202, like "pending",
// so a browser waiting on its own payment does not fill its console with failed requests.
const NOT_FOUND = fail(202, "not_found");
const REUSED = fail(409, "reused");

/** How many listed transactions one verify call reads when it has to search by reference. */
export const REFERENCE_READS = 4;

const notFinal = (status) => status.confirmationStatus === "processed" || status.confirmationStatus === "confirmed";

/**
 * The transaction the page pointed at: the signature its wallet returned.
 * It is only a pointer. Whatever it points at must still name the claim's
 * reference, or it is ignored (null) and the claim is looked up by reference.
 * When it does name the reference, it is the claim's own transaction, and
 * once read at `finalized` it is the one thing verify gives a verdict on.
 */
async function judgePointed({ rpc, store, reference, signature, payTo }) {
  const [status] = await rpc.getSignatureStatuses([signature]);
  // Unknown to the node: look the claim up by reference, in case what landed is not what the wallet reported.
  if (!status) return null;
  if (notFinal(status)) return PENDING;
  // Asked for at "finalized": null until the transaction can no longer be rolled back.
  const tx = await rpc.getTransaction(signature);
  if (!tx) return PENDING;
  const assessment = assessTransaction(tx, { payTo, reference, signature });
  if (assessment.ok) return (await store.get(spentKey(signature))) ? REUSED : { paid: signature };
  if (assessment.reason === "unrelated") return null;
  if (assessment.reason === "malformed") return CANNOT_TELL;
  // failed, wrong_mint, wrong_amount: the claim's own transaction did not pay.
  return fail(400, assessment.reason);
}

/**
 * Search the transactions naming the reference for one that pays. The
 * reference is public once the payment is broadcast, so anyone can add
 * transactions naming it. None of them can redeem anything (only the claim
 * holder gets a token, and a payment is spent once by its signature), so any
 * transaction that pays is the payment, and nothing else found here is a
 * verdict: what does not pay may not even be the claim's own.
 *
 * Successful rows are read oldest first, because the claim's own payment is
 * broadcast before anyone else can know the reference. At most
 * REFERENCE_READS are read per call, which bounds what one request costs.
 */
async function searchReference({ rpc, store, reference, payTo }) {
  const rows = await rpc.getSignaturesForAddress(reference);
  if (rows.length === 0) return NOT_FOUND;

  let pending = false;
  let unread = false;
  let unreadable = false;
  let spent = false;
  let reads = 0;
  for (const row of [...rows].reverse()) {
    if (row.err !== null) continue;
    if (notFinal(row)) {
      pending = true;
      continue;
    }
    if (reads === REFERENCE_READS) {
      unread = true;
      break;
    }
    reads += 1;
    const tx = await rpc.getTransaction(row.signature);
    if (!tx) {
      pending = true;
      continue;
    }
    const assessment = assessTransaction(tx, { payTo, reference, signature: row.signature });
    if (assessment.ok) {
      if (!(await store.get(spentKey(row.signature)))) return { paid: row.signature };
      spent = true;
    } else if (assessment.reason === "malformed" || assessment.reason === "unrelated") {
      // The node listed a transaction under the reference that does not name it, or served it broken.
      unreadable = true;
    }
  }

  if (pending) return PENDING;
  // A full page means older transactions exist that were not returned.
  if (unread || unreadable || rows.length >= SIGNATURE_LIMIT) return CANNOT_TELL;
  if (spent) return REUSED;
  // Nothing that names the reference pays. The page's give-up clock decides when to stop looking.
  return NOT_FOUND;
}

/**
 * Confirm the payment behind a claim and issue a short-lived unlock token for it.
 *
 * Nothing the caller says is believed. The claim only proves which reference
 * they may speak for, and the optional signature only says where to look.
 * The payment itself is read from the finalized transaction: it succeeded,
 * it names the reference, and the payee received exactly 1.00 USDC.
 *
 * A 400 is only ever a verdict on the transaction the page pointed at, read
 * at `finalized` and naming the claim's reference: its own. The page gives
 * the attempt up on it. The search by reference never ends in a 400, because
 * a transaction found that way may be someone else's. Anything short of a
 * verdict (an odd answer from the node, a reference too crowded to read) is
 * a 202 or a 503 and decides nothing.
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

  const lookup = { rpc, store, reference, payTo };
  const found =
    (signature !== undefined ? await judgePointed({ ...lookup, signature }) : null) ?? (await searchReference(lookup));
  if (!found.paid) return found;
  return { ok: true, status: 200, ...signUnlockToken({ signature: found.paid, secret, now }) };
}

/**
 * Spend the payment a token points at. The single conditional write is the
 * whole decision: the first request to create the record wins, and every
 * other token for that transaction is refused from then on. That holds as
 * long as the store makes the write atomically (see store.js).
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
