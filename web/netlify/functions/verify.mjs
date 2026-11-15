import { payToAddress, solanaRpcUrl, unlockSecret } from "./lib/constants.js";
import { json, readJson } from "./lib/http.js";
import { blobStore } from "./lib/store.js";
import { verifyPayment } from "./lib/verify.js";

function rpcClient(url) {
  return {
    async getSignaturesForAddress(address) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [address, { limit: 25 }],
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error("rpc signatures failed");
      return data.result || [];
    },
    async getTransaction(signature) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error("rpc transaction failed");
      return data.result;
    },
  };
}

const REASONS = {
  pending: "Waiting for the payment to finalize.",
  reused: "That payment was already used for a grind.",
  wrong_amount: "The payment amount does not cover $1.",
  wrong_mint: "The token received was not USDC.",
  invalid: "The payment could not be matched.",
  config: "Payment verification is not configured.",
};

export default async function verify(request) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const secret = unlockSecret();
  const rpcUrl = solanaRpcUrl();
  if (!secret || !rpcUrl) {
    return json({ error: "Payment verification is not configured.", reason: "config" }, 500);
  }

  const body = await readJson(request);
  let store;
  try {
    store = await blobStore();
  } catch {
    return json({ error: "Payment storage is unavailable.", reason: "config" }, 500);
  }

  try {
    const result = await verifyPayment({
      reference: body?.reference,
      asset: body?.asset,
      rpc: rpcClient(rpcUrl),
      store,
      payTo: payToAddress(),
      secret,
    });
    return json(
      {
        ok: result.ok,
        reason: result.reason,
        message: REASONS[result.reason] || (result.ok ? "Paid." : "Payment was not accepted."),
        token: result.token,
        expiresAt: result.expiresAt,
        asset: result.asset,
      },
      result.status
    );
  } catch {
    return json({ error: "The Solana network is unreachable from the server.", reason: "pending" }, 503);
  }
}
