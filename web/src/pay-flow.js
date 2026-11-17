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
import { classifyWalletError } from "../../shared/pay-copy.js";
import { checkPreparedTransfer } from "./transfer-check.js";

export const CLAIM_KEY = "vg-pay-claim";

/**
 * Saved by the version of this page before claims: the reference of a payment
 * that may have been made and never spent. It cannot be redeemed any more, so
 * the customer is shown it, with how to get a refund, until they dismiss it.
 */
export const RETIRED_REF_KEY = "vg-pay-ref";

export const POLL_MS = 3_000;
export const MAX_BACKOFF_MS = 15_000;

/**
 * The transfer is built on a blockhash that expires about a minute and a half
 * after it was fetched. If the chain still has no trace of the payment three
 * minutes after it was sent, it never landed and never will.
 */
export const GIVE_UP_AFTER_MS = 180_000;

/**
 * A saved payment that has been neither found nor ruled out for this long,
 * because the check is not answering or keeps saying "pending", can be given
 * up by the customer, with a warning. Nothing gives it up on its own.
 */
export const ABANDON_OFFER_AFTER_MS = 10 * 60_000;

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

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  /** The saved attempt, or null. Read from storage every time so two tabs agree. */
  function pending() {
    let record;
    try {
      record = JSON.parse(storage.getItem(CLAIM_KEY) || "null");
    } catch {
      record = null;
    }
    if (!record || typeof record.claim !== "string" || !Number.isFinite(record.createdAt)) return null;
    const token = typeof record.token === "string" && record.token.length > 0 ? record.token : null;
    return {
      claim: record.claim,
      createdAt: record.createdAt,
      sentAt: Number.isFinite(record.sentAt) ? record.sentAt : null,
      signature: savedSignature(record.signature),
      walletError: record.walletError === true,
      token,
      tokenExpiresAt: token && Number.isFinite(record.tokenExpiresAt) ? record.tokenExpiresAt : null,
    };
  }

  /** Write the saved attempt, keeping only the fields that are set. */
  function save({ claim, createdAt, sentAt = null, signature, walletError, token, tokenExpiresAt }) {
    storage.setItem(
      CLAIM_KEY,
      JSON.stringify({
        claim,
        createdAt,
        sentAt,
        ...(signature ? { signature } : {}),
        ...(walletError ? { walletError: true } : {}),
        ...(token ? { token, ...(Number.isFinite(tokenExpiresAt) ? { tokenExpiresAt } : {}) } : {}),
      })
    );
  }

  /** Clear the saved attempt. Given a claim, only if that is still the one saved: another tab may have replaced it. */
  function forget(claim) {
    if (claim !== undefined && pending()?.claim !== claim) return;
    storage.removeItem(CLAIM_KEY);
  }

  /** Start a new attempt. Refuses while another one is unresolved. */
  function begin() {
    if (pending()) throw new Error("a payment is already pending");
    const claim = encodeBase58(random(32));
    save({ claim, createdAt: now() });
    return claim;
  }

  /**
   * The wallet has (or may have) sent the transaction. The give-up clock
   * starts here. When the wallet said which transaction it sent, that
   * signature is kept and every check names it, so the server reads that
   * transaction directly instead of searching the reference's history.
   * @param {unknown} [walletOutput] what signAndSendTransaction resolved with, if it did
   * @param {string} [claim] the claim the transaction was built for; nothing changes if another attempt replaced it
   * @param {{ walletError?: boolean }} [how] the wallet threw an error nobody recognises, so it may or may not have sent
   */
  function markSent(walletOutput, claim, { walletError = false } = {}) {
    const record = pending();
    if (!record || (claim !== undefined && record.claim !== claim)) return;
    save({
      claim: record.claim,
      createdAt: record.createdAt,
      sentAt: now(),
      signature: signatureFromWallet(walletOutput),
      walletError,
    });
  }

  /**
   * Start a payment: a new claim, the transfer prepare builds for it, this
   * page's own check of that transfer, then the wallet. Only bytes that pass
   * checkPreparedTransfer ever reach signAndSend, and they reach it unchanged.
   * @param {{ payer: string, signAndSend: (bytes: Uint8Array) => Promise<unknown> }} wallet
   * @returns {Promise<
   *   | { outcome: "busy" }
   *   | { outcome: "unreachable" | "not_prepared", reason?: string, error?: string }
   *   | { outcome: "refused", problem: string }
   *   | { outcome: "declined", kind: string }
   *   | { outcome: "sent" | "unknown", claim: string }>}
   *   busy: another tab is paying, nothing changed. unreachable, not_prepared,
   *   refused, declined: nothing was sent and the claim is cleared. sent,
   *   unknown: the transfer went out, or may have; the claim is kept to follow.
   */
  async function pay({ payer, signAndSend }) {
    let claim;
    try {
      claim = begin();
    } catch {
      return { outcome: "busy" };
    }
    let bytes;
    try {
      const prepared = await post("prepare", { payer, claim });
      if (typeof prepared?.data?.transaction !== "string") {
        forget(claim);
        return { outcome: "not_prepared", reason: prepared?.data?.reason, error: prepared?.data?.error };
      }
      bytes = bytesFromBase64(prepared.data.transaction);
    } catch {
      forget(claim);
      return { outcome: "unreachable" };
    }

    // The server builds the transfer; this page decides whether it is the one to sign.
    let problem;
    try {
      problem = await checkPreparedTransfer(bytes, { payer, claim });
    } catch {
      problem = "check failed";
    }
    if (problem) {
      forget(claim);
      return { outcome: "refused", problem };
    }

    let output;
    try {
      output = await signAndSend(bytes);
    } catch (error) {
      const kind = classifyWalletError(error);
      if (kind) {
        // Declined, refused at preflight, or short of funds: the wallet sent nothing.
        forget(claim);
        return { outcome: "declined", kind };
      }
      // Anything else leaves it unknown whether the transfer went out, so it is looked for.
      markSent(undefined, claim, { walletError: true });
      return { outcome: "unknown", claim };
    }
    markSent(output, claim);
    return { outcome: "sent", claim };
  }

  /**
   * Give up the saved attempt at the customer's request, which the page only
   * offers after ABANDON_OFFER_AFTER_MS. Returns what was given up, so the
   * page can show what the customer needs to ask for a refund.
   */
  function abandon(claim) {
    const record = pending();
    if (!record || record.claim !== claim) return null;
    forget(claim);
    return record;
  }

  /** The reference saved by the version of this page before claims, or null. */
  function retiredReference() {
    const value = storage.getItem(RETIRED_REF_KEY);
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function dismissRetired() {
    storage.removeItem(RETIRED_REF_KEY);
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
    if (status === 200 && typeof data?.token === "string") {
      return { state: "paid", token: data.token, expiresAt: Number.isFinite(data.expiresAt) ? data.expiresAt : null };
    }
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
   *
   * An attempt that holds a saved token was paid, and its spend had begun
   * when the page went away: that token is the answer, with no request.
   * unlock() replays it, and asks verify again only if it is stale.
   *
   * onState(state, info) after each check that settles nothing:
   *   info.giveUpIn       ms left before an unseen payment is given up
   *   info.walletError    the wallet reported an error nobody recognises
   *   info.signature      the wallet said which transaction it sent
   *   info.canAbandon     the customer may now give the attempt up
   *   info.claim          the attempt this is about
   */
  async function watch({ signal, onState = () => {} } = {}) {
    let wait = POLL_MS;
    for (;;) {
      if (signal?.aborted) return { outcome: "stopped" };
      const record = pending();
      if (!record) return { outcome: "none" };
      if (record.token) return { outcome: "paid", token: record.token, expiresAt: record.tokenExpiresAt };
      const result = await check();
      if (signal?.aborted) return { outcome: "stopped" };
      switch (result.state) {
        case "none":
          return { outcome: "none" };
        case "paid":
          return { outcome: "paid", token: result.token, expiresAt: result.expiresAt };
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
      const since = record.sentAt ?? record.createdAt;
      onState(result.state, {
        claim: record.claim,
        giveUpIn: Math.max(0, since + GIVE_UP_AFTER_MS - now()),
        walletError: record.walletError,
        signature: record.signature !== null,
        canAbandon: result.state !== "unseen" && now() - since >= ABANDON_OFFER_AFTER_MS,
      });
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

  /** Keep the token with the attempt it unlocks, so a reload can replay it. */
  function holdToken(token, expiresAt) {
    const record = pending();
    if (!record || record.token === token) return;
    save({ ...record, token, tokenExpiresAt: expiresAt });
  }

  /**
   * Spend the saved attempt's unlock for one grind. The token is saved with
   * the claim before /api/consume is called, so a spend whose answer is lost
   * survives a reload: the token that won is answered "ok" every time it is
   * sent again. A token saved by an earlier visit is replayed before a new
   * one is used. Only if the token is stale (expired, or signed with a secret
   * since changed) does verify issue a fresh one.
   * @param {{ token: string, expiresAt?: number | null }} [fresh] the token this visit was given
   */
  async function unlock(fresh) {
    const record = pending();
    const saved = record?.token ? { token: record.token, expiresAt: record.tokenExpiresAt } : null;
    const first = saved ?? fresh;
    if (!first?.token) return { ok: false, reason: "unavailable" };
    holdToken(first.token, first.expiresAt);
    let spent = await spend(first.token);
    if (!spent.ok && (spent.reason === "expired" || spent.reason === "bad")) {
      // The payment is still there and unspent; only the token was stale.
      const again = await check();
      if (again.state === "paid") {
        holdToken(again.token, again.expiresAt);
        spent = await spend(again.token);
      } else if (again.state === "used") {
        forget();
        spent = { ok: false, reason: "reused", message: again.message };
      } else {
        spent = { ok: false, reason: "unavailable" };
      }
    }
    return spent;
  }

  return { pending, begin, markSent, forget, check, watch, spend, pay, unlock, abandon, retiredReference, dismissRetired };
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
