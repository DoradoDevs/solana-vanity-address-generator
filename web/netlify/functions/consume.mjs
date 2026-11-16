import { unlockSecret } from "./lib/constants.js";
import { describeFailure, json, postOnly, readJson } from "./lib/http.js";
import { blobStore } from "./lib/store.js";
import { consumeUnlock } from "./lib/verify.js";

export const config = { path: "/api/consume" };

const MESSAGES = {
  reused: "That payment was already used for a grind.",
  expired: "The unlock expired. Checking the payment again.",
  bad: "The unlock token is not valid.",
  config: "Payment verification is not configured.",
  unavailable: "Payment verification is temporarily unavailable.",
};

function reply(status, reason) {
  console.log(`consume ${reason || "unlocked"}`);
  return json({ ok: status === 200, reason, message: reason ? MESSAGES[reason] : "Unlocked." }, status);
}

export default async function consume(request) {
  if (request.method !== "POST") return postOnly();
  const secret = unlockSecret();
  if (!secret) return reply(500, "config");

  const body = await readJson(request);
  if (!body) return reply(400, "bad");

  let result;
  try {
    result = await consumeUnlock({ token: body.token, store: blobStore(), secret });
  } catch (error) {
    // The ledger did not answer, so nothing was spent. The same token can be sent again.
    console.log(`consume failure ${describeFailure(error)}`);
    return reply(503, "unavailable");
  }
  return reply(result.status, result.reason);
}
