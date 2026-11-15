import { unlockSecret } from "./lib/constants.js";
import { consumeUnlock } from "./lib/verify.js";
import { json, readJson } from "./lib/http.js";
import { openStore } from "./lib/store.js";

export default async function consume(request) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const secret = unlockSecret();
  if (!secret) return json({ error: "Payment verification is not configured.", reason: "config" }, 500);

  const body = await readJson(request);
  let store;
  try {
    store = await openStore();
  } catch {
    return json({ error: "Payment storage is unavailable.", reason: "config" }, 500);
  }

  const result = await consumeUnlock({ token: body?.token, store, secret });
  const message =
    result.reason === "reused"
      ? "That payment was already used for a grind."
      : result.reason === "expired"
        ? "The unlock expired. Verify the payment again."
        : result.ok
          ? "Unlocked."
          : "The unlock token is not valid.";
  return json({ ok: result.ok, reason: result.reason, message }, result.status);
}
