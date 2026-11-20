import { isAddress, isSignature } from "./address.js";
import { assessTransaction } from "./assess.js";
import { referenceForClaim } from "./claim.js";
import { SIGNATURE_LIMIT } from "./rpc.js";
import { spentKey } from "./store.js";
import { readUnlockClaims, readUnlockToken, signUnlockToken } from "./token.js";

const fail = (status, reason) => ({ ok: false, status, reason });

/** Nothing could be concluded. The caller keeps its claim and asks again; nothing is granted. */
const CANNOT_TELL = fail(503, "unavailable");
const PENDING = fail(202, "pending");
// Not an error: a payment sent a moment ago is simply not visible yet. 202, like "pending",
// so a browser waiting on its own payment does not fill its console with failed requests.
const NOT_FOUND = fail(202, "not_found");
/** Still walking back through a long history: ask again with the cursor that comes with it. */
const SEARCHING = fail(202, "searching");
const REUSED = fail(409, "reused");
/** The operator refunded this payment and marked it spent (DEPLOY.md, "Refund requests"). */
const REFUNDED = fail(409, "refunded");

/** A spent record's answer: refunded by the operator, or used for a grind. */
const spentAnswer = (record) => (record?.refunded === true ? REFUNDED : REUSED);

/** How many listed transactions one verify call reads when it has to search by reference. */
export const REFERENCE_READS = 4;

/**
 * How many pages of signatures one verify call lists while walking back to
 * the oldest end of a reference's history. Past that, the call answers
 * "searching" with a cursor, and the next call carries on from there.
 */
export const REFERENCE_PAGES = 2;

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
  if (assessment.ok) {
    const spent = await store.get(spentKey(signature));
    return spent ? spentAnswer(spent) : { paid: signature };
  }
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
 * The claim's own payment is broadcast before anyone else can know the
 * reference, so it sits at the oldest end of the history. The node lists
 * newest first, a page at a time, so the search first walks back to that end
 * (REFERENCE_PAGES pages per call; a longer history is resumed on the next
 * call from the cursor this one returns), then reads successful rows oldest
 * first, at most REFERENCE_READS per call. A flood of transactions naming the
 * reference after the payment delays the answer by a few calls; it cannot
 * hide the payment.
 *
 * "Not found" is only said after the whole history was listed in one call
 * and every successful row in it was read. A search that started from a
 * cursor skipped newer rows it never read, so it can say "cannot tell", never
 * "not found".
 */
async function searchReference({ rpc, store, reference, payTo, cursor }) {
  let rows = [];
  let before = cursor;
  let atOldestEnd = false;
  for (let page = 0; page < REFERENCE_PAGES; page++) {
    const listed = await rpc.getSignaturesForAddress(reference, before ? { before } : {});
    rows = rows.concat(listed);
    if (listed.length < SIGNATURE_LIMIT) {
      atOldestEnd = true;
      break;
    }
    before = listed[listed.length - 1].signature;
  }
  if (!atOldestEnd) return { ...SEARCHING, cursor: before };
  if (rows.length === 0) return cursor === undefined ? NOT_FOUND : CANNOT_TELL;

  let pending = false;
  let unread = false;
  let unreadable = false;
  /** The answer for a paying transaction found already spent, if one was. */
  let spent = null;
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
      const record = await store.get(spentKey(row.signature));
      if (!record) return { paid: row.signature };
      spent = spentAnswer(record);
    } else if (assessment.reason === "malformed" || assessment.reason === "unrelated") {
      // The node listed a transaction under the reference that does not name it, or served it broken.
      unreadable = true;
    }
  }

  if (pending) return PENDING;
  if (unread || unreadable) return CANNOT_TELL;
  if (spent) return spent;
  // Newer rows were skipped on the way back from the cursor, and never read.
  if (cursor !== undefined) return CANNOT_TELL;
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
export async function verifyPayment({ claim, signature, cursor, rpc, store, payTo, secret, now = Date.now() }) {
  const reference = referenceForClaim(claim);
  if (!reference) return fail(400, "invalid");
  if (signature !== undefined && !isSignature(signature)) return fail(400, "invalid");
  if (cursor !== undefined && !isSignature(cursor)) return fail(400, "invalid");
  if (!isAddress(payTo) || !secret) return fail(500, "config");

  const lookup = { rpc, store, reference, payTo };
  const found =
    (signature !== undefined ? await judgePointed({ ...lookup, signature }) : null) ??
    (await searchReference({ ...lookup, cursor }));
  if (!found.paid) return found;
  return { ok: true, status: 200, ...signUnlockToken({ signature: found.paid, secret, now }) };
}

/**
 * Spend the payment a token points at. The single conditional write is the
 * whole decision: the first request to create the record wins, and every
 * other token for that transaction is refused from then on. That holds as
 * long as the store makes the write atomically (see store.js). Only a token
 * that is authentic under the current secret, and unexpired, can spend.
 *
 * The token that won gets the same answer every time it is presented, so a
 * page whose response was lost can ask again without losing the grind it
 * paid for. That answer writes nothing and rests only on the record the
 * winning spend wrote: the token must name that transaction and carry the
 * record's random id (jti, 96 bits), which nobody but the holder of the
 * winning token has ever seen. So it is given even after the token expired,
 * or after UNLOCK_SECRET was rotated: checking the old signature again would
 * protect nothing (a repeated "ok" grants nothing new, and the grind runs in
 * the holder's own browser), and refusing would cost a paying customer the
 * grind that a lost answer already spent. The page keeps the token with its
 * claim and runs one spend at a time across tabs, so the repeated answer
 * reaches one grind.
 */
export async function consumeUnlock({ token, store, secret, now = Date.now() }) {
  // No secret, no spending and no answers: the function is not configured.
  if (!secret) return fail(400, "bad");
  const parsed = readUnlockToken(token, secret, now);
  if (parsed.ok && (await store.create(spentKey(parsed.signature), { at: now, jti: parsed.jti }))) {
    return { ok: true, status: 200 };
  }

  // Not a fresh spend. Only the record of the winning spend can answer for it.
  const named = parsed.ok || parsed.reason === "expired" ? parsed : readUnlockClaims(token);
  if (!named) return fail(400, "bad");
  const spent = await store.get(spentKey(named.signature));
  if (spent?.refunded === true) return REFUNDED;
  if (spent && spent.jti === named.jti) return { ok: true, status: 200 };
  if (parsed.ok) return REUSED;
  return parsed.reason === "expired" ? fail(401, "expired") : fail(400, "bad");
}
