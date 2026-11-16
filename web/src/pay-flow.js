/**
 * Payment state for this browser, with no DOM in it.
 *
 * One payment attempt is one claim: 32 random bytes kept here and shown to
 * nobody but our own functions. The server names the claim's hash in the
 * transfer it builds, and later hands the unlock only to whoever presents the
 * claim. The claim is saved before the wallet is asked to sign, so a payment
 * survives a reload, a closed tab, or a wallet that never answers.
 *
 * While a claim is saved and unresolved, no second payment is started.
 */
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";

export const CLAIM_KEY = "vg-pay-claim";

/** Saved by earlier versions of this page. A bare reference cannot be redeemed any more. */
const RETIRED_KEYS = ["vg-pay-ref"];

export const POLL_MS = 3_000;
export const MAX_BACKOFF_MS = 15_000;

/**
 * The transfer is built on a blockhash that expires about a minute and a half
 * after it was fetched. If the chain still has no trace of the payment three
 * minutes after it was sent, it never landed and never will.
 */
export const GIVE_UP_AFTER_MS = 180_000;

const SPEND_ATTEMPTS = 4;

/** A transaction signature as saved: 64 bytes in Base58, or null. */
function savedSignature(value) {
  if (typeof value !== "string" || value.length < 64 || value.length > 88) return null;
  try {
    return decodeBase58(value).length === 64 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The signature in what Wallet Standard's solana:signAndSendTransaction
 * resolved with (one output per transaction sent), or null.
 */
function signatureFromWallet(outputs) {
  const raw = Array.isArray(outputs) ? outputs[0]?.signature : undefined;
  return raw instanceof Uint8Array && raw.length === 64 ? encodeBase58(raw) : null;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * @param {object} deps
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} deps.storage
 * @param {(name: string, body: object) => Promise<{ status: number, data: any }>} deps.post  rejects when the request never got an answer
 */
export function createPayFlow({
  storage,
  post,
  now = Date.now,
  sleep = abortableSleep,
  random = (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
}) {
  for (const key of RETIRED_KEYS) storage.removeItem(key);

  /** The saved attempt, or null. Read from storage every time so two tabs agree. */
  function pending() {
    let record;
    try {
      record = JSON.parse(storage.getItem(CLAIM_KEY) || "null");
    } catch {
      record = null;
    }
    if (!record || typeof record.claim !== "string" || !Number.isFinite(record.createdAt)) return null;
    return {
      claim: record.claim,
      createdAt: record.createdAt,
      sentAt: Number.isFinite(record.sentAt) ? record.sentAt : null,
      signature: savedSignature(record.signature),
    };
  }

  function save(record) {
    storage.setItem(CLAIM_KEY, JSON.stringify(record));
  }

  function forget() {
    storage.removeItem(CLAIM_KEY);
  }

  /** Start a new attempt. Refuses while another one is unresolved. */
  function begin() {
    if (pending()) throw new Error("a payment is already pending");
    const claim = encodeBase58(random(32));
    save({ claim, createdAt: now(), sentAt: null });
    return claim;
  }

  /**
   * The wallet has (or may have) sent the transaction. The give-up clock
   * starts here. When the wallet said which transaction it sent, that
   * signature is kept and every check names it, so the server reads that
   * transaction directly instead of searching the reference's history.
   * @param {unknown} [walletOutput] what signAndSendTransaction resolved with, if it did
   * @param {string} [claim] the claim the transaction was built for; nothing changes if another attempt replaced it
   */
  function markSent(walletOutput, claim) {
    const record = pending();
    if (!record || (claim !== undefined && record.claim !== claim)) return;
    const signature = signatureFromWallet(walletOutput);
    save({ claim: record.claim, createdAt: record.createdAt, sentAt: now(), ...(signature ? { signature } : {}) });
  }

  /**
   * Ask the server about the saved attempt, once.
   * A status only means what it says when the body carries the matching
   * reason; anything else (a proxy error page, a rate limit, a dropped
   * connection) is "unavailable" and decides nothing.
   */
  async function check() {
    const record = pending();
    if (!record) return { state: "none" };
    let response;
    try {
      response = await post("verify", record.signature ? { claim: record.claim, signature: record.signature } : { claim: record.claim });
    } catch {
      return { state: "unavailable" };
    }
    const { status, data } = response;
    const reason = data?.reason;
    const message = typeof data?.message === "string" ? data.message : "";
    if (status === 200 && typeof data?.token === "string") return { state: "paid", token: data.token };
    if (status === 202 && reason === "pending") return { state: "pending" };
    if (status === 202 && reason === "not_found") return { state: "unseen" };
    if (status === 409 && reason === "reused") return { state: "used", message };
    if (status === 400 && typeof reason === "string") return { state: "rejected", reason, message };
    return { state: "unavailable" };
  }

  /**
   * Follow the saved attempt until it resolves.
   * Outcomes: "paid" (with a token), "gone" (never reached the chain),
   * "used", "rejected", "stopped" (the caller aborted; the claim is kept),
   * "none" (nothing saved). Every outcome except "paid" and "stopped"
   * clears the claim, because nothing more can come of it.
   */
  async function watch({ signal, onState = () => {} } = {}) {
    let wait = POLL_MS;
    for (;;) {
      if (signal?.aborted) return { outcome: "stopped" };
      const record = pending();
      if (!record) return { outcome: "none" };
      const result = await check();
      if (signal?.aborted) return { outcome: "stopped" };
      switch (result.state) {
        case "none":
          return { outcome: "none" };
        case "paid":
          return { outcome: "paid", token: result.token };
        case "used":
          forget();
          return { outcome: "used", message: result.message };
        case "rejected":
          forget();
          return { outcome: "rejected", reason: result.reason, message: result.message };
        case "unseen":
          if (now() - (record.sentAt ?? record.createdAt) > GIVE_UP_AFTER_MS) {
            forget();
            return { outcome: "gone" };
          }
          wait = POLL_MS;
          break;
        case "pending":
          wait = POLL_MS;
          break;
        default:
          // The service not answering is never a reason to give up on a payment.
          wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      }
      onState(result.state);
      await sleep(wait, signal);
    }
  }

  /**
   * Spend an unlock token. The same token is safe to send again, so a lost
   * response is retried rather than treated as a failure.
   * @returns {Promise<{ ok: true } | { ok: false, reason: "reused" | "expired" | "bad" | "unavailable", message?: string }>}
   */
  async function spend(token) {
    let wait = 1_000;
    for (let attempt = 0; attempt < SPEND_ATTEMPTS; attempt++) {
      let response = null;
      try {
        response = await post("consume", { token });
      } catch {
        response = null;
      }
      const reason = response?.data?.reason;
      const message = typeof response?.data?.message === "string" ? response.data.message : undefined;
      if (response?.status === 200 && response.data?.ok === true) {
        forget();
        return { ok: true };
      }
      if (response?.status === 409 && reason === "reused") {
        forget();
        return { ok: false, reason, message };
      }
      if ((response?.status === 401 && reason === "expired") || (response?.status === 400 && reason === "bad")) {
        return { ok: false, reason, message };
      }
      if (attempt < SPEND_ATTEMPTS - 1) await sleep(wait);
      wait *= 2;
    }
    return { ok: false, reason: "unavailable" };
  }

  return { pending, begin, markSent, forget, check, watch, spend };
}

/** localStorage when the browser allows writing to it, otherwise memory for the life of the page. */
export function browserStorage() {
  try {
    const local = globalThis.localStorage;
    const probe = "vg-storage-probe";
    local.setItem(probe, "1");
    local.removeItem(probe);
    return local;
  } catch {
    const memory = new Map();
    return {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    };
  }
}
