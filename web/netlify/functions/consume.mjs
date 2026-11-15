import { unlockSecret } from "./lib/constants.js";
import { consumeUnlock } from "./lib/verify.js";
import { json, readJson } from "./lib/http.js";
import { openStore } from "./lib/store.js";

export function consumeMessage(result) {
  if (result.ok) return "Unlocked.";
  if (result.reason === "reused") return "That payment was already used for a grind.";
  if (result.reason === "expired") return "The unlock expired. Verify the payment again.";
  if (result.reason === "invalid") return "Payment still settling, retrying…";
  return "The unlock token is not valid.";
}

export default async function consume(request) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const secret = unlockSecret();
  if (!secret) {
    console.log("consume config");
    return json({ error: "Payment verification is not configured.", reason: "config" }, 500);
  }

  const body = await readJson(request);
  let store;
  try {
    store = await openStore();
  } catch {
    console.log("consume config");
    return json({ error: "Payment storage is unavailable.", reason: "config" }, 500);
  }

  const result = await consumeUnlock({ token: body?.token, store, secret });
  console.log(`consume ${result.ok ? "unlocked" : result.reason || "rejected"}`);
  return json(
    { ok: result.ok, reason: result.reason, message: consumeMessage(result) },
    result.status
  );
}
