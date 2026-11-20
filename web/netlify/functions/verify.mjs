import { payToAddress, solanaRpcUrl, unlockSecret } from "./lib/constants.js";
import { describeFailure, json, postOnly, readJson } from "./lib/http.js";
import { createRpc } from "./lib/rpc.js";
import { blobStore } from "./lib/store.js";
import { verifyPayment } from "./lib/verify.js";

// Each call costs an RPC request, so the edge limits it per visitor. A page
// that is waiting on finality polls about 20 times a minute.
export const config = {
  path: "/api/verify",
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

const MESSAGES = {
  pending: "The payment is on chain and waiting to be finalized.",
  not_found: "No payment has reached the chain for this attempt yet.",
  searching: "Many transactions name this payment. Still looking through them for it.",
  reused: "That payment was already used for a grind.",
  refunded: "That payment was refunded to the wallet that paid it, so it cannot unlock a grind.",
  failed: "The payment transaction failed on chain, so no USDC moved.",
  wrong_amount: "The transaction did not pay exactly 1.00 USDC.",
  wrong_mint: "The token received was not USDC.",
  invalid: "The payment could not be matched.",
  config: "Payment verification is not configured.",
  unavailable: "Payment verification is temporarily unavailable.",
};

function reply(status, reason, extra = {}) {
  console.log(`verify ${reason || "paid"}`);
  return json({ ok: status === 200, reason, message: reason ? MESSAGES[reason] : "Paid.", ...extra }, status);
}

export default async function verify(request) {
  if (request.method !== "POST") return postOnly();
  const secret = unlockSecret();
  const rpcUrl = solanaRpcUrl();
  if (!secret || !rpcUrl) return reply(500, "config");
  // PAY_TO_ADDRESS names a payee other than the pinned one. 503: the page keeps any saved payment.
  const payTo = payToAddress();
  if (!payTo) return reply(503, "config");

  const body = await readJson(request);
  if (!body) return reply(400, "invalid");

  let result;
  try {
    result = await verifyPayment({
      claim: body.claim,
      signature: body.signature,
      cursor: body.cursor,
      rpc: createRpc(rpcUrl),
      store: blobStore(),
      payTo,
      secret,
    });
  } catch (error) {
    // The RPC node or the ledger did not answer. Nothing is granted; the caller may ask again.
    console.log(`verify failure ${describeFailure(error)}`);
    return reply(503, "unavailable");
  }
  if (!result.ok) return reply(result.status, result.reason, result.cursor ? { cursor: result.cursor } : {});
  return reply(200, undefined, { token: result.token, expiresAt: result.expiresAt });
}
