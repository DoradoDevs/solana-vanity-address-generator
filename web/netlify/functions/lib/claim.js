import { createHash } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../../../../shared/base58.js";

/**
 * A claim is 32 random bytes that only the paying browser holds. Its SHA-256,
 * read as a Solana address, is the reference account named in the payment.
 *
 * The reference is public the moment the transaction is broadcast. The claim
 * is not, and a reference cannot be turned back into one. So whoever can show
 * the claim is the browser that started the payment, and nobody can redeem a
 * payment by reading someone else's transaction off the chain.
 *
 * @returns {string | null} the reference address, or null when the claim is malformed
 */
export function referenceForClaim(claim) {
  if (typeof claim !== "string" || claim.length < 32 || claim.length > 44) return null;
  let bytes;
  try {
    bytes = decodeBase58(claim);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return encodeBase58(new Uint8Array(createHash("sha256").update(bytes).digest()));
}
