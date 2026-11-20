/**
 * Payment state for this browser, with no DOM in it.
 *
 * One payment attempt is one claim: 32 random bytes kept here and shown to
 * nobody but our own functions. The server names the claim's hash in the
 * transfer it builds, and later hands the unlock only to whoever presents the
 * claim. The claim is saved before the wallet is asked to sign, so a payment
 * survives a reload, a closed tab, or a wallet that never answers.
 *
 * While a claim is saved and unresolved, no second payment is started, and
 * an unlock token is only ever spent for the claim it was issued for.
 */
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";
import { classifyWalletError } from "../../shared/pay-copy.js";
import { checkPreparedTransfer, referenceOf } from "./transfer-check.js";

export const CLAIM_KEY = "vg-pay-claim";

/**
 * Saved by the version of this page before claims: the reference of a payment
 * that may have been made and never spent. It cannot be redeemed any more, so
 * the customer is shown it, with how to get a refund, until they dismiss it.
 */
export const RETIRED_REF_KEY = "vg-pay-ref";

/**
 * Payments this browser gave up, or whose own transaction paid something
 * other than exactly 1.00 USDC: their reference (and signature, when known),
 * which is what a refund request quotes. Kept until the customer hides each.
 */
export const REFUND_NOTES_KEY = "vg-pay-refunds";

/** The browser-wide lock a spend holds, so one payment reaches one grind across tabs. */
export const SPEND_LOCK = "vg-pay-spend";

/**
 * Without Web Locks: how long a spend's lease in storage lasts, and how often
 * a waiting tab looks again. The holder renews the lease before every request
 * it sends, and no request lasts longer than POST_TIMEOUT_MS, so a live
 * holder's lease never runs out while it spends.
 */
export const LEASE_MS = 120_000;
/** The longest the page waits for one answer from the functions. Well under LEASE_MS. */
export const POST_TIMEOUT_MS = 20_000;
const LEASE_POLL_MS = 250;
const LEASE_SETTLE_MS = 50;

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
 * Run `fn(hold)` holding the browser-wide lock `name`, so two tabs never
 * spend at once. Web Locks where the browser has them: the lock goes with the
 * tab, so a tab closed mid-spend frees it at once, and `hold()` is always
 * true. Otherwise a lease in storage, which a tab closed mid-spend holds for
 * at most LEASE_MS. There `hold()` renews the lease and says whether this tab
 * still holds it: `fn` calls it before each request, and stops when it is
 * false (the tab was frozen past LEASE_MS and another tab took over).
 */
function storageLock(storage, { now, sleep, random }) {
  return async (name, fn) => {
    const key = `${name}-lease`;
    const owner = encodeBase58(random(16));
    const read = () => {
      try {
        return JSON.parse(storage.getItem(key) || "null");
      } catch {
        return null;
      }
    };
    for (;;) {
      const lease = read();
      if (lease && lease.owner !== owner && Number.isFinite(lease.until) && lease.until > now()) {
        await sleep(LEASE_POLL_MS);
        continue;
      }
      storage.setItem(key, JSON.stringify({ owner, until: now() + LEASE_MS }));
      // Another tab may have written its own lease at the same moment: the last write holds it.
      await sleep(LEASE_SETTLE_MS);
      if (read()?.owner === owner) break;
    }
    const hold = () => {
      if (read()?.owner !== owner) return false;
      storage.setItem(key, JSON.stringify({ owner, until: now() + LEASE_MS }));
      return true;
    };
    try {
      return await fn(hold);
    } finally {
      if (read()?.owner === owner) storage.removeItem(key);
    }
  };
}

/**
 * @param {object} deps
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} deps.storage
 * @param {(name: string, body: object) => Promise<{ status: number, data: any }>} deps.post  rejects when the request never got an answer
 * @param {{ request(name: string, fn: () => Promise<any>): Promise<any> } | null} [deps.locks]  Web Locks; null uses a lease in storage
 */
export function createPayFlow({
  storage,
  post,
  now = Date.now,
  sleep = abortableSleep,
  random = (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  locks = globalThis.navigator?.locks ?? null,
}) {
  const withLock = locks ? (name, fn) => locks.request(name, () => fn(() => true)) : storageLock(storage, { now, sleep, random });

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
      cursor: savedSignature(record.cursor),
    };
  }

  /** Write the saved attempt, keeping only the fields that are set. */
  function save({ claim, createdAt, sentAt = null, signature, walletError, token, tokenExpiresAt, cursor }) {
    storage.setItem(
      CLAIM_KEY,
      JSON.stringify({
        claim,
        createdAt,
        sentAt,
        ...(signature ? { signature } : {}),
        ...(walletError ? { walletError: true } : {}),
        ...(token ? { token, ...(Number.isFinite(tokenExpiresAt) ? { tokenExpiresAt } : {}) } : {}),
        ...(cursor ? { cursor } : {}),
      })
    );
  }

  /**
   * Change fields of the saved attempt, only if it is still `claim`: another
   * tab may have replaced it. Returns whether it wrote.
   */
  function update(claim, fields) {
    const record = pending();
    if (!record || record.claim !== claim) return false;
    save({ ...record, ...fields });
    return true;
  }

  /**
   * Clear the saved attempt, only if it is still `claim`: another tab may
   * have replaced it. Without a claim, nothing is cleared.
   */
  function forget(claim) {
    if (claim === undefined || pending()?.claim !== claim) return;
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
        // Declined before signing, or short of what the transfer needs: no USDC can have moved.
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

  // ── What the customer is told to quote for a refund, kept until they hide it ──

  /** @returns {{ reference: string, signature?: string, why: "abandoned" | "rejected", at: number }[]} */
  function refundNotes() {
    let list;
    try {
      list = JSON.parse(storage.getItem(REFUND_NOTES_KEY) || "[]");
    } catch {
      list = [];
    }
    return Array.isArray(list) ? list.filter((note) => typeof note?.reference === "string" && note.reference.length > 0) : [];
  }

  async function noteRefund(record, why) {
    const reference = await referenceOf(record.claim);
    const notes = refundNotes().filter((note) => note.reference !== reference);
    notes.push({ reference, ...(record.signature ? { signature: record.signature } : {}), why, at: now() });
    storage.setItem(REFUND_NOTES_KEY, JSON.stringify(notes));
    return reference;
  }

  function dismissRefund(reference) {
    const notes = refundNotes().filter((note) => note.reference !== reference);
    if (notes.length === 0) storage.removeItem(REFUND_NOTES_KEY);
    else storage.setItem(REFUND_NOTES_KEY, JSON.stringify(notes));
  }

  /**
   * Give up the saved attempt at the customer's request, which the page only
   * offers after ABANDON_OFFER_AFTER_MS. Its reference (never the claim) is
   * kept in the refund notes first, so what the customer needs to ask for a
   * refund survives a reload and later payments. Returns the note, or null if
   * the attempt is no longer the saved one.
   */
  async function abandon(claim) {
    const record = pending();
    if (!record || record.claim !== claim) return null;
    const reference = await referenceOf(claim);
    if (pending()?.claim !== claim) return null;
    await noteRefund(record, "abandoned");
    forget(claim);
    return { reference, signature: record.signature };
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
  async function check(record = pending()) {
    if (!record) return { state: "none" };
    const body = {
      claim: record.claim,
      ...(record.signature ? { signature: record.signature } : {}),
      ...(record.cursor ? { cursor: record.cursor } : {}),
    };
    let response;
    try {
      response = await post("verify", body);
    } catch {
      return { state: "unavailable" };
    }
    const { status, data } = response;
    const reason = data?.reason;
    const message = typeof data?.message === "string" ? data.message : "";
    if (status === 200 && typeof data?.token === "string") {
      return {
        state: "paid",
        claim: record.claim,
        token: data.token,
        expiresAt: Number.isFinite(data.expiresAt) ? data.expiresAt : null,
      };
    }
    if (status === 202 && reason === "pending") return { state: "pending" };
    if (status === 202 && reason === "not_found") return { state: "unseen" };
    if (status === 202 && reason === "searching" && savedSignature(data?.cursor)) {
      // A long history: the next check carries on from here, even after a reload.
      update(record.claim, { cursor: data.cursor });
      return { state: "searching" };
    }
    if (status === 409 && (reason === "reused" || reason === "refunded")) return { state: "used", reason, message };
    if (status === 400 && typeof reason === "string") return { state: "rejected", reason, message };
    return { state: "unavailable" };
  }

  /**
   * Follow the saved attempt until it resolves.
   * Outcomes: "paid" (with the claim and a token), "gone" (never reached the
   * chain), "used", "rejected", "stopped" (the caller aborted; the claim is
   * kept), "none" (nothing saved). Every outcome except "paid" and "stopped"
   * clears the claim, because nothing more can come of it.
   *
   * Every look goes to verify, even when the attempt holds a saved token, so
   * the give-up offer and the server's verdicts always apply. A saved token
   * means this browser was paid and began to spend; then:
   * - "used" is most likely that spend, whose answer was lost: the saved
   *   token is returned, and unlock() replays it, which settles whose it was;
   * - "not found" (a node without the history) is never given up on its own.
   *
   * onState(state, info) after each check that settles nothing:
   *   info.giveUpIn       ms left before an unseen payment is given up; null when it never will be
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
      const result = await check(record);
      if (signal?.aborted) return { outcome: "stopped" };
      const wasPaid = record.token !== null;
      const since = record.sentAt ?? record.createdAt;
      switch (result.state) {
        case "none":
          return { outcome: "none" };
        case "paid":
          return { outcome: "paid", claim: record.claim, token: result.token, expiresAt: result.expiresAt };
        case "used":
          if (wasPaid && result.reason === "reused") {
            return { outcome: "paid", claim: record.claim, token: record.token, expiresAt: record.tokenExpiresAt };
          }
          forget(record.claim);
          return { outcome: "used", reason: result.reason, message: result.message };
        case "rejected":
          // The claim's own transaction, final, moved USDC but not exactly 1.00 to the payee
          // (after a payee change, say): the customer may be owed a refund, so its reference is kept.
          if (result.reason !== "failed") await noteRefund(record, "rejected");
          forget(record.claim);
          return { outcome: "rejected", reason: result.reason, message: result.message };
        case "unseen":
          if (!wasPaid && now() - since > GIVE_UP_AFTER_MS) {
            forget(record.claim);
            return { outcome: "gone" };
          }
          wait = POLL_MS;
          break;
        case "pending":
        case "searching":
          wait = POLL_MS;
          break;
        default:
          // The service not answering is never a reason to give up on a payment.
          wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      }
      onState(result.state, {
        claim: record.claim,
        giveUpIn: wasPaid ? null : Math.max(0, since + GIVE_UP_AFTER_MS - now()),
        walletError: record.walletError,
        signature: record.signature !== null,
        canAbandon: (result.state !== "unseen" || wasPaid) && now() - since >= ABANDON_OFFER_AFTER_MS,
      });
      await sleep(wait, signal);
    }
  }

  /**
   * Send an unlock token to consume. The same token is safe to send again, so
   * a lost response is retried rather than treated as a failure. On a verdict
   * the attempt is cleared, if it is still `claim`. `hold` is the spend
   * lock's: asked before each request, and when it is false nothing more is
   * sent ("elsewhere").
   * @returns {Promise<{ ok: true } | { ok: false, reason: "reused" | "refunded" | "expired" | "bad" | "unavailable" | "elsewhere", message?: string }>}
   */
  async function spend(token, claim, hold = () => true) {
    let wait = 1_000;
    for (let attempt = 0; attempt < SPEND_ATTEMPTS; attempt++) {
      if (!hold()) return { ok: false, reason: "elsewhere" };
      let response = null;
      try {
        response = await post("consume", { token });
      } catch {
        response = null;
      }
      const reason = response?.data?.reason;
      const message = typeof response?.data?.message === "string" ? response.data.message : undefined;
      if (response?.status === 200 && response.data?.ok === true) {
        forget(claim);
        return { ok: true };
      }
      if (response?.status === 409 && (reason === "reused" || reason === "refunded")) {
        forget(claim);
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

  /**
   * Spend the unlock for one grind. `paid` is what watch() returned: the
   * claim the token was issued for, and the token.
   *
   * One spend runs at a time in this browser (the "vg-pay-spend" lock), and
   * each starts from the saved attempt, never from what a tab remembers:
   * - If the saved attempt is not `paid.claim`, that payment was spent here
   *   or in another tab, given up, or replaced. Nothing is spent ("elsewhere").
   * - The token is saved with its claim before consume is called, so a spend
   *   whose answer is lost survives a reload. A token saved by an earlier
   *   spend of this claim is replayed before any other: the token that won is
   *   answered "ok" every time, and any other is refused once one has won.
   * - Only a token that comes back stale (expired, or not the winner) sends
   *   the page to verify for a fresh one.
   * @param {{ claim: string, token: string, expiresAt?: number | null }} paid
   * @returns {Promise<{ ok: true } | { ok: false, reason: "reused" | "refunded" | "elsewhere" | "rejected" | "unavailable", message?: string }>}
   */
  async function unlock(paid) {
    if (typeof paid?.claim !== "string" || typeof paid.token !== "string") return { ok: false, reason: "unavailable" };
    const { claim } = paid;
    return withLock(SPEND_LOCK, async (hold) => {
      const record = pending();
      if (!record || record.claim !== claim) return { ok: false, reason: "elsewhere" };
      const first = record.token ? { token: record.token, expiresAt: record.tokenExpiresAt } : paid;
      if (!update(claim, { token: first.token, tokenExpiresAt: first.expiresAt })) return { ok: false, reason: "elsewhere" };
      const spent = await spend(first.token, claim, hold);
      if (spent.ok || (spent.reason !== "expired" && spent.reason !== "bad")) return spent;

      // That token can no longer spend. The payment may still be unspent: ask verify.
      const current = pending();
      if (!current || current.claim !== claim || !hold()) return { ok: false, reason: "elsewhere" };
      const again = await check(current);
      if (again.state === "paid") {
        if (!update(claim, { token: again.token, tokenExpiresAt: again.expiresAt })) return { ok: false, reason: "elsewhere" };
        return spend(again.token, claim, hold);
      }
      if (again.state === "used") {
        forget(claim);
        return { ok: false, reason: again.reason, message: again.message };
      }
      if (again.state === "rejected") {
        if (again.reason !== "failed") await noteRefund(current, "rejected");
        forget(claim);
        return { ok: false, reason: "rejected", message: again.message };
      }
      return { ok: false, reason: "unavailable" };
    });
  }

  return {
    pending,
    begin,
    markSent,
    forget,
    check,
    watch,
    spend,
    pay,
    unlock,
    abandon,
    refundNotes,
    dismissRefund,
    retiredReference,
    dismissRetired,
  };
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
