// Payment verification, attacked. Each test tries one way of getting a grind
// that was not paid for, or of breaking a grind that was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessTransaction } from "../netlify/functions/lib/assess.js";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import { TOKEN_PROGRAM_ID, USDC_MINT } from "../netlify/functions/lib/constants.js";
import { SIGNATURE_LIMIT } from "../netlify/functions/lib/rpc.js";
import { memoryStore, spentKey } from "../netlify/functions/lib/store.js";
import { readUnlockToken } from "../netlify/functions/lib/token.js";
import { consumeUnlock, verifyPayment } from "../netlify/functions/lib/verify.js";
import {
  OTHER_MINT,
  PAYEE_ATA,
  PAYER,
  PAYER_ATA,
  PAY_TO,
  STRANGER,
  TOKEN_2022,
  balance,
  chainRpc,
  newClaim,
  newSignature,
  paymentTx,
} from "./helpers/chain.js";

const SECRET = "test-unlock-secret-value";
const NOW = 1_700_000_000_000;

function verify(overrides) {
  return verifyPayment({ store: memoryStore(), payTo: PAY_TO, secret: SECRET, now: NOW, ...overrides });
}

function consume(token, store, now = NOW) {
  return consumeUnlock({ token, store, secret: SECRET, now });
}

/** A paid claim on its own chain. */
function paid(txOptions = {}) {
  const { claim, reference } = newClaim();
  const tx = paymentTx({ references: [reference], ...txOptions });
  return { claim, reference, tx, signature: tx.transaction.signatures[0], rpc: chainRpc([tx]) };
}

// ── The honest path ──────────────────────────────────────────────────────────

test("an exact 1.00 USDC payment verifies and the token names that transaction", async () => {
  const { claim, rpc, signature } = paid();
  const result = await verify({ claim, rpc });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.expiresAt, NOW + 10 * 60 * 1000);
  const parsed = readUnlockToken(result.token, SECRET, NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.signature, signature);
  assert.deepEqual(rpc.calls, { getSignaturesForAddress: 1, getTransaction: 1, getSignatureStatuses: 0 });
});

test("verify writes nothing: checking a payment twice leaves it unspent", async () => {
  const { claim, rpc, signature } = paid();
  const store = memoryStore();
  const first = await verify({ claim, rpc, store });
  const second = await verify({ claim, rpc, store });
  assert.equal(first.ok && second.ok, true);
  assert.notEqual(first.token, second.token);
  assert.equal(await store.get(spentKey(signature)), null);
});

test("the payee's first payment, which creates its USDC account, verifies", async () => {
  const { claim, rpc } = paid({
    pre: [balance(1, 5_000_000, { owner: PAYER })],
    post: [balance(1, 4_000_000, { owner: PAYER }), balance(2, 1_000_000)],
  });
  assert.equal((await verify({ claim, rpc })).ok, true);
});

// ── Who may redeem a payment ─────────────────────────────────────────────────

test("a claim that is not 32 Base58 bytes is refused before the chain is read", async () => {
  const rpc = chainRpc([]);
  for (const claim of [undefined, null, 42, "", "not base58 0OIl", "1".repeat(31), "2".repeat(45), { claim: "x" }]) {
    const result = await verify({ claim, rpc });
    assert.equal(result.status, 400, String(claim));
    assert.equal(result.reason, "invalid");
  }
  assert.equal(rpc.calls.getSignaturesForAddress, 0);
});

test("knowing a payment's reference, or any account in it, redeems nothing", async () => {
  const { reference, rpc } = paid();
  // Everything below is public: it is all in the customer's transaction.
  for (const stolen of [reference, PAYER, PAYER_ATA, PAYEE_ATA, PAY_TO, USDC_MINT, TOKEN_PROGRAM_ID]) {
    const result = await verify({ claim: stolen, rpc });
    assert.equal(result.ok, false, stolen);
    assert.equal(result.reason, "not_found", stolen);
    // What gets looked up is the hash of what was sent, never the address itself.
    assert.notEqual(referenceForClaim(stolen), stolen);
  }
});

test("someone else's payment cannot be reached with one's own claim", async () => {
  const customer = paid();
  const stranger = newClaim();
  const result = await verify({ claim: stranger.claim, rpc: customer.rpc });
  assert.equal(result.reason, "not_found");
});

// ── One payment, one grind ───────────────────────────────────────────────────

test("one payment naming three references unlocks one grind, not three", async () => {
  const claims = [newClaim(), newClaim(), newClaim()];
  const tx = paymentTx({ references: claims.map((c) => c.reference) });
  const rpc = chainRpc([tx]);
  const store = memoryStore();
  let grinds = 0;
  for (const { claim } of claims) {
    const result = await verify({ claim, rpc, store });
    if (!result.ok) continue;
    if ((await consume(result.token, store)).ok) grinds += 1;
  }
  assert.equal(grinds, 1);
  for (const { claim } of claims) {
    assert.equal((await verify({ claim, rpc, store })).reason, "reused");
  }
});

test("a spent payment is reported as used and no token is issued for it", async () => {
  const { claim, rpc, signature } = paid();
  const store = memoryStore();
  const first = await verify({ claim, rpc, store });
  assert.equal((await consume(first.token, store)).ok, true);
  for (const again of [await verify({ claim, rpc, store }), await verify({ claim, signature, rpc, store })]) {
    assert.equal(again.status, 409);
    assert.equal(again.reason, "reused");
    assert.equal(again.token, undefined);
  }
});

test("someone else's spent payment is never reported as used for this claim", async () => {
  const theirs = paid();
  const store = memoryStore();
  const { token } = await verify({ claim: theirs.claim, rpc: theirs.rpc, store });
  assert.equal((await consume(token, store)).ok, true);
  // A page that names a stranger's transaction learns nothing about it, and keeps its own claim.
  const mine = newClaim();
  const result = await verify({ claim: mine.claim, signature: theirs.signature, rpc: theirs.rpc, store });
  assert.equal(result.status, 202);
  assert.equal(result.reason, "not_found");
});

test("fifty different tokens for one payment, spent at once: exactly one wins", async () => {
  const { claim, rpc } = paid();
  const store = memoryStore();
  const tokens = [];
  for (let i = 0; i < 50; i++) tokens.push((await verify({ claim, rpc, store, now: NOW + i })).token);
  assert.equal(new Set(tokens).size, 50);
  const results = await Promise.all(tokens.map((token) => consume(token, store)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.reason === "reused").length, 49);
});

test("the same token sent again gets the same answer, and a second token is refused", async () => {
  const { claim, rpc } = paid();
  const store = memoryStore();
  const first = await verify({ claim, rpc, store });
  const second = await verify({ claim, rpc, store });
  assert.equal((await consume(first.token, store)).ok, true);
  // The response was lost and the page asks again.
  assert.equal((await consume(first.token, store)).ok, true);
  const other = await consume(second.token, store);
  assert.equal(other.ok, false);
  assert.equal(other.status, 409);
  assert.equal(other.reason, "reused");
});

test("the token that spent a payment gets the same answer whenever it asks again, even after it expires", async () => {
  const { claim, rpc } = paid();
  const store = memoryStore();
  const { token, expiresAt } = await verify({ claim, rpc, store });
  const second = (await verify({ claim, rpc, store, now: NOW + 1 })).token;
  // The spend lands a moment before expiry, and the answer is lost on the way back.
  assert.equal((await consume(token, store, expiresAt - 1_000)).ok, true);
  for (const later of [expiresAt + 1_000, expiresAt + 3_600_000]) {
    assert.equal((await consume(token, store, later)).ok, true, String(later));
  }
  // Any other token for that payment is still refused, expired or not.
  assert.equal((await consume(second, store, expiresAt - 500)).reason, "reused");
  assert.equal((await consume(second, store, expiresAt + 10_000)).ok, false);
});

test("tokens issued in the same millisecond for one payment are still different tokens", async () => {
  const { claim, rpc } = paid();
  const store = memoryStore();
  const [a, b] = await Promise.all([verify({ claim, rpc, store }), verify({ claim, rpc, store })]);
  assert.equal(a.expiresAt, b.expiresAt);
  assert.notEqual(a.token, b.token);
  const results = await Promise.all([consume(a.token, store), consume(b.token, store)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

// ── The amount, the asset, the recipient ─────────────────────────────────────

test("anything other than exactly 1.00 USDC to the payee is refused", async () => {
  for (const received of [0, 1, 999_999, 1_000_001, 2_000_000, 100_000_000]) {
    const { claim, rpc } = paid({ post: [balance(2, 7_000_000 + received)] });
    const result = await verify({ claim, rpc });
    assert.equal(result.ok, false, String(received));
    assert.equal(result.status, 400);
    assert.equal(result.reason, "wrong_amount", String(received));
  }
});

test("three 1.00 USDC transfers in one transaction are not one payment", async () => {
  const { claim, rpc } = paid({ post: [balance(2, 10_000_000)] });
  assert.equal((await verify({ claim, rpc })).reason, "wrong_amount");
});

test("a look-alike mint is not USDC", async () => {
  const { claim, rpc } = paid({
    pre: [balance(2, 0, { mint: OTHER_MINT })],
    post: [balance(2, 1_000_000, { mint: OTHER_MINT })],
  });
  const result = await verify({ claim, rpc });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_mint");
});

test("a balance row that claims USDC under Token-2022 is never counted as USDC", async () => {
  const { claim, rpc } = paid({
    pre: [balance(2, 7_000_000, { programId: TOKEN_2022 })],
    post: [balance(2, 8_000_000, { programId: TOKEN_2022 })],
  });
  // No such account can exist on chain, so this is a node to distrust: nothing granted, nothing decided.
  const result = await verify({ claim, rpc });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test("1.00 USDC into a token account someone else owns pays nobody we know", async () => {
  const { claim, rpc } = paid({
    pre: [balance(2, 7_000_000, { owner: STRANGER })],
    post: [balance(2, 8_000_000, { owner: STRANGER })],
  });
  assert.equal((await verify({ claim, rpc })).reason, "wrong_amount");
});

test("USDC moved between the payee's own accounts is not a payment", async () => {
  const { claim, rpc } = paid({
    pre: [balance(2, 7_000_000), balance(6, 3_000_000)],
    post: [balance(2, 8_000_000), balance(6, 2_000_000)],
  });
  assert.equal((await verify({ claim, rpc })).reason, "wrong_amount");
});

test("1.00 USDC in and straight back out nets to nothing", async () => {
  const { claim, rpc } = paid({ pre: [balance(2, 7_000_000)], post: [balance(2, 7_000_000)] });
  assert.equal((await verify({ claim, rpc })).reason, "wrong_amount");
});

test("an account the payee stopped owning in the transaction counts as money out", async () => {
  // The payee's account gained 1.00, but another account of the payee's, holding 1.00, left its ownership.
  const { claim, rpc } = paid({
    pre: [balance(2, 7_000_000), balance(6, 1_000_000)],
    post: [balance(2, 8_000_000), balance(6, 1_000_000, { owner: STRANGER })],
  });
  assert.equal((await verify({ claim, rpc })).reason, "wrong_amount");
});

test("lamports alone, with no token balances changing, are not a payment", async () => {
  const { claim, rpc } = paid({ pre: [], post: [] });
  assert.equal((await verify({ claim, rpc })).reason, "wrong_amount");
});

// ── Success and finality ─────────────────────────────────────────────────────

test("a transaction that failed on chain is not a payment", async () => {
  const { claim, rpc } = paid({ err: { InstructionError: [1, { Custom: 1 }] } });
  const result = await verify({ claim, rpc });
  assert.equal(result.status, 400);
  assert.equal(result.reason, "failed");
  assert.equal(rpc.calls.getTransaction, 0);
});

test("a transaction listed as successful but recorded as failed is the failure it records", async () => {
  const { claim, reference } = newClaim();
  const tx = paymentTx({ references: [reference] });
  const served = structuredClone(tx);
  served.meta.err = { InstructionError: [1, { Custom: 1 }] };
  const result = await verify({ claim, rpc: chainRpc([{ tx, served }]) });
  assert.equal(result.status, 400);
  assert.equal(result.reason, "failed");
});

test("a payment that is confirmed but not final is pending, and its transaction is not fetched", async () => {
  for (const status of ["processed", "confirmed"]) {
    const { claim, reference } = newClaim();
    const rpc = chainRpc([{ tx: paymentTx({ references: [reference] }), status }]);
    const result = await verify({ claim, rpc });
    assert.equal(result.status, 202, status);
    assert.equal(result.reason, "pending");
    assert.equal(rpc.calls.getTransaction, 0);
  }
});

test("a row that says finalized is not believed until the finalized transaction is served", async () => {
  const { claim, reference } = newClaim();
  const tx = paymentTx({ references: [reference] });
  const rpc = {
    async getSignaturesForAddress() {
      return [{ signature: tx.transaction.signatures[0], err: null, confirmationStatus: "finalized" }];
    },
    async getTransaction() {
      return null;
    },
  };
  const result = await verify({ claim, rpc });
  assert.equal(result.status, 202);
  assert.equal(result.reason, "pending");
});

test("a payment that has not reached the chain yet is not_found, not an error", async () => {
  const result = await verify({ claim: newClaim().claim, rpc: chainRpc([]) });
  assert.equal(result.status, 202);
  assert.equal(result.reason, "not_found");
});

// ── Third parties naming the reference ───────────────────────────────────────

test("a junk transaction that names the reference afterwards cannot hide the payment", async () => {
  const { claim, reference, tx } = paid();
  const junk = paymentTx({ references: [reference], pre: [balance(2, 8_000_000)], post: [balance(2, 8_000_000)] });
  const failedJunk = paymentTx({ references: [reference], err: { InstructionError: [0, "Custom"] } });
  const result = await verify({ claim, rpc: chainRpc([tx, junk, failedJunk]) });
  assert.equal(result.ok, true);
  assert.equal(readUnlockToken(result.token, SECRET, NOW).signature, tx.transaction.signatures[0]);
});

test("a failed first attempt does not block the successful payment that follows it", async () => {
  const { claim, reference } = newClaim();
  const failed = paymentTx({ references: [reference], err: { InstructionError: [1, { Custom: 1 }] } });
  const good = paymentTx({ references: [reference] });
  assert.equal((await verify({ claim, rpc: chainRpc([failed, good]) })).ok, true);
});

/** A paid claim whose reference a third party then named in a full page of failed transactions. */
function flooded() {
  const customer = paid();
  const junk = Array.from({ length: SIGNATURE_LIMIT }, () =>
    paymentTx({ references: [customer.reference], err: { InstructionError: [0, { Custom: 1 }] } })
  );
  return { ...customer, rpc: chainRpc([customer.tx, ...junk]) };
}

test("a full page of signatures hides the oldest, so the answer is 'cannot tell', never a verdict", async () => {
  const { claim, rpc } = flooded();
  const result = await verify({ claim, rpc });
  assert.equal(result.ok, false);
  // 503: the page keeps its claim and asks again. A 400 would make it give the payment up.
  assert.equal(result.status, 503);
  assert.equal(result.reason, "unavailable");
  assert.equal(rpc.calls.getTransaction, 0);
});

test("the transaction the page sent is judged on its own, however many others name the reference", async () => {
  const { claim, rpc, signature } = flooded();
  const result = await verify({ claim, signature, rpc });
  assert.equal(result.ok, true);
  assert.equal(readUnlockToken(result.token, SECRET, NOW).signature, signature);
  assert.equal(rpc.calls.getSignaturesForAddress, 0);
});

test("the page's signature is only a pointer: a transaction that does not name the claim is ignored", async () => {
  const mine = paid();
  const theirs = paid();
  const rpc = chainRpc([mine.tx, theirs.tx]);
  const own = await verify({ claim: mine.claim, signature: theirs.signature, rpc });
  assert.equal(own.ok, true);
  assert.equal(readUnlockToken(own.token, SECRET, NOW).signature, mine.signature);
  const nothing = await verify({ claim: newClaim().claim, signature: theirs.signature, rpc });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.reason, "not_found");
});

test("the page's own transaction is followed through landing, finality and failure", async () => {
  const { claim, reference } = newClaim();
  const tx = paymentTx({ references: [reference] });
  const signature = tx.transaction.signatures[0];
  const at = (status, entry = tx) => verify({ claim, signature, rpc: chainRpc([{ tx: entry, status }]) });
  assert.equal((await at("unseen")).reason, "not_found");
  assert.equal((await at("processed")).reason, "pending");
  assert.equal((await at("confirmed")).reason, "pending");
  assert.equal((await at("finalized")).ok, true);
  const failed = paymentTx({ references: [reference], signature, err: { InstructionError: [1, { Custom: 1 }] } });
  assert.equal((await at("confirmed", failed)).reason, "pending");
  const final = await at("finalized", failed);
  assert.equal(final.status, 400);
  assert.equal(final.reason, "failed");
});

test("a signature that is not 64 Base58 bytes is refused before the chain is read", async () => {
  const { claim, rpc } = paid();
  for (const signature of ["", "abc", "0".repeat(88), 42, null, { s: 1 }, "1".repeat(89)]) {
    const result = await verify({ claim, signature, rpc });
    assert.equal(result.status, 400, String(signature));
    assert.equal(result.reason, "invalid");
  }
  assert.deepEqual(rpc.calls, { getSignaturesForAddress: 0, getTransaction: 0, getSignatureStatuses: 0 });
});

// ── RPC answers that are wrong, missing or odd ───────────────────────────────

test("an RPC failure grants nothing and reaches the caller as an exception", async () => {
  const { claim } = newClaim();
  const rpc = {
    async getSignaturesForAddress() {
      throw new Error("rpc down");
    },
  };
  await assert.rejects(verify({ claim, rpc }), /rpc down/);
});

test("a node that serves the wrong transaction, or one without its record, grants nothing and decides nothing", async () => {
  const { claim, reference } = newClaim();
  const tx = paymentTx({ references: [reference] });
  const other = paymentTx({ references: [reference] });
  const unnamed = paymentTx({ references: [], signature: tx.transaction.signatures[0] });
  const noMeta = { ...structuredClone(tx), meta: null };
  const noBalances = structuredClone(tx);
  delete noBalances.meta.preTokenBalances;
  for (const served of [other, unnamed, noMeta, noBalances]) {
    const result = await verify({ claim, rpc: chainRpc([{ tx, served }]) });
    assert.equal(result.ok, false);
    // Unavailable, so the page keeps the claim and asks again rather than being told it did not pay.
    assert.equal(result.status, 503);
    assert.equal(result.reason, "unavailable");
  }
});

test("token balances that are missing or malformed never read as a payment", () => {
  const { reference } = newClaim();
  const good = paymentTx({ references: [reference] });
  const args = { payTo: PAY_TO, reference, signature: good.transaction.signatures[0] };
  assert.deepEqual(assessTransaction(good, args), { ok: true });

  const mutate = (change) => {
    const tx = structuredClone(good);
    change(tx);
    return assessTransaction(tx, args);
  };
  const malformed = { ok: false, reason: "malformed" };
  // With no "before" list, a transaction that moved nothing would look like the whole balance arriving.
  assert.deepEqual(mutate((tx) => delete tx.meta.preTokenBalances), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta.preTokenBalances = null)), malformed);
  assert.deepEqual(mutate((tx) => delete tx.meta.postTokenBalances), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta.postTokenBalances = {})), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta = null)), malformed);
  assert.deepEqual(mutate((tx) => delete tx.meta.err), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta.postTokenBalances[1].uiTokenAmount.amount = "8000000.0")), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta.postTokenBalances[1].uiTokenAmount.amount = 8_000_000)), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta.postTokenBalances[1].uiTokenAmount.amount = "-1")), malformed);
  assert.deepEqual(mutate((tx) => delete tx.meta.postTokenBalances[1].uiTokenAmount), malformed);
  assert.deepEqual(mutate((tx) => (tx.meta.postTokenBalances[1].accountIndex = "2")), malformed);
  assert.deepEqual(mutate((tx) => tx.meta.postTokenBalances.push(balance(2, 1_000_000))), malformed);
  assert.deepEqual(mutate((tx) => tx.meta.postTokenBalances.push(null)), malformed);
  assert.deepEqual(mutate((tx) => (tx.transaction.message.accountKeys = undefined)), malformed);
  assert.deepEqual(mutate((tx) => (tx.transaction.signatures = [newSignature()])), malformed);
  assert.deepEqual(assessTransaction(null, args), malformed);
  assert.deepEqual(assessTransaction("tx", args), malformed);
  // Readable, but not a payment, or not this claim's.
  assert.deepEqual(mutate((tx) => (tx.meta.err = "boom")), { ok: false, reason: "failed" });
  assert.deepEqual(assessTransaction(good, { ...args, reference: newClaim().reference }), { ok: false, reason: "unrelated" });
});

test("amounts are compared as integers, well past what a float can hold", () => {
  const { reference } = newClaim();
  const huge = 18_446_744_073_708_551_615n; // u64 max minus 1.00 USDC
  const tx = paymentTx({
    references: [reference],
    pre: [balance(2, huge)],
    post: [balance(2, huge + 1_000_000n)],
  });
  const args = { payTo: PAY_TO, reference };
  assert.deepEqual(assessTransaction(tx, args), { ok: true });
  const off = paymentTx({ references: [reference], pre: [balance(2, huge)], post: [balance(2, huge + 1_000_001n)] });
  assert.equal(assessTransaction(off, args).reason, "wrong_amount");
});

// ── Configuration ────────────────────────────────────────────────────────────

test("without a secret or a valid payee nothing is verified", async () => {
  const { claim, rpc } = paid();
  for (const overrides of [{ secret: null }, { secret: "" }, { payTo: "not-an-address" }, { payTo: "" }]) {
    const result = await verify({ claim, rpc, ...overrides });
    assert.equal(result.status, 500);
    assert.equal(result.reason, "config");
  }
  assert.equal(rpc.calls.getSignaturesForAddress, 0);
});

// ── Spending ─────────────────────────────────────────────────────────────────

test("consume refuses tokens that are expired, altered, foreign or malformed", async () => {
  const { claim, rpc, signature } = paid();
  const store = memoryStore();
  const { token, expiresAt } = await verify({ claim, rpc, store });

  const expired = await consume(token, store, expiresAt + 1);
  assert.equal(expired.status, 401);
  assert.equal(expired.reason, "expired");

  const [body, mac] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  const forged = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 86_400_000 })).toString("base64url");
  const legacy = Buffer.from(JSON.stringify({ v: 1, ref: PAYER, exp: payload.exp })).toString("base64url");
  for (const bad of [
    `${forged}.${mac}`,
    `${legacy}.${mac}`,
    `${body}.${mac.slice(0, -1)}`,
    `${body}.${mac}x`,
    `${body}.`,
    body,
    `.${mac}`,
    "",
    "x".repeat(600),
    null,
    undefined,
    { token },
  ]) {
    const result = await consume(bad, store);
    assert.equal(result.status, 400, String(bad).slice(0, 30));
    assert.equal(result.reason, "bad");
  }
  const wrongSecret = await consumeUnlock({ token, store, secret: "another-secret-entirely", now: NOW });
  assert.equal(wrongSecret.reason, "bad");
  const noSecret = await consumeUnlock({ token, store, secret: null, now: NOW });
  assert.equal(noSecret.reason, "bad");
  // None of that spent anything.
  assert.equal(await store.get(spentKey(signature)), null);
  assert.equal((await consume(token, store)).ok, true);
});

test("when the ledger cannot be written, nothing is spent and the token still works later", async () => {
  const { claim, rpc } = paid();
  const store = memoryStore();
  const { token } = await verify({ claim, rpc, store });
  const down = {
    async create() {
      throw new Error("blobs unavailable");
    },
    async get() {
      throw new Error("blobs unavailable");
    },
  };
  await assert.rejects(consumeUnlock({ token, store: down, secret: SECRET, now: NOW }), /blobs unavailable/);
  assert.equal((await consume(token, store)).ok, true);
});
