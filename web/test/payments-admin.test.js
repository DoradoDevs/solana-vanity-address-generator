// The operator's refund tool, web/scripts/payments.mjs, against a stand-in
// chain (chainRpc) and ledger (memoryStore). Nothing here reaches a network
// beyond 127.0.0.1, and nothing reaches Netlify.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { encodeBase58 } from "../../shared/base58.js";
import { SIGNATURE_LIMIT } from "../netlify/functions/lib/rpc.js";
import { memoryStore, spentKey } from "../netlify/functions/lib/store.js";
import { consumeUnlock, verifyPayment } from "../netlify/functions/lib/verify.js";
import {
  LAUNCH_AT,
  NOT_A_PAYMENT,
  REFUNDABLE,
  REFUNDED,
  REFUND_MIN_AGE_MS,
  SENT_BACK,
  TOO_RECENT,
  UNCLEAR,
  USED,
  checkPayment,
  findPayer,
  main,
  markRefunded,
  oldPayments,
  oldSolPayments,
  payeeUsdcAccount,
} from "../scripts/payments.mjs";
import {
  OTHER_MINT,
  PAYEE_ATA,
  PAYER,
  PAYER_ATA,
  PAY_TO,
  balance,
  chainRpc,
  newClaim,
  newSignature,
  paymentTx,
} from "./helpers/chain.js";

const webRoot = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(webRoot, "scripts", "payments.mjs");
const SECRET = "unlock-secret-for-tests-0123456789";
const DAY = REFUND_MIN_AGE_MS;

/** When the default test payment landed, in seconds like a node's blockTime: 2026-11-18, after the launch. */
const BLOCK_TIME = 1_795_000_000;
const PAID_AT = BLOCK_TIME * 1000;
/** The first moment a payment made at BLOCK_TIME may be refunded. */
const LATER = PAID_AT + DAY;

const newAddress = () => encodeBase58(new Uint8Array(randomBytes(32)));
const sigOf = (tx) => tx.transaction.signatures[0];

/**
 * paymentTx with a block time (chain.js gives every transaction the same one)
 * and, like every payment the page builds, a reference account of its own.
 */
function payment({ blockTime = BLOCK_TIME, references = [newClaim().reference], ...options } = {}) {
  const tx = paymentTx({ references, ...options });
  tx.blockTime = blockTime;
  return tx;
}

/**
 * chainRpc, with each listed row carrying its transaction's blockTime as a
 * real node's getSignaturesForAddress rows do. Kept here rather than in
 * helpers/chain.js, which nothing else needs to change for.
 */
function datedRpc(entries) {
  const rpc = chainRpc(entries);
  const times = new Map(entries.map((entry) => entry.tx ?? entry).map((tx) => [sigOf(tx), tx.blockTime ?? null]));
  const list = rpc.getSignaturesForAddress;
  rpc.getSignaturesForAddress = async (address, options) =>
    (await list(address, options)).map((row) => ({ ...row, blockTime: times.get(row.signature) }));
  return rpc;
}

/**
 * The records 34623f1 wrote, keyed by the reference at the top level of the
 * same store. Its verify, once it had read the payment naming the reference:
 *   store.set(reference, { status: "paid", asset: "usdc", signature: found.signature, at: now })
 * and its consume, when the grind started:
 *   store.set(parsed.ref, { ...record, status: "consumed", consumedAt: now })
 */
async function oldVerified(store, reference, signature, at = PAID_AT + 5_000) {
  const record = { status: "paid", asset: "usdc", signature, at };
  assert.equal(await store.create(reference, record), true);
  return record;
}
async function oldConsumed(store, reference, signature, at = PAID_AT + 5_000, consumedAt = PAID_AT + 9_000) {
  const record = { status: "paid", asset: "usdc", signature, at };
  assert.equal(await store.create(reference, { ...record, status: "consumed", consumedAt }), true);
}

/** Spend a payment the way the live site does: verify issues a token, consume spends it. */
async function spendForGrind({ claim, signature, rpc, store, now = PAID_AT + 60_000 }) {
  const issued = await verifyPayment({ claim, signature, rpc, store, payTo: PAY_TO, secret: SECRET, now });
  assert.equal(issued.status, 200);
  assert.equal((await consumeUnlock({ token: issued.token, store, secret: SECRET, now })).status, 200);
}

const check = (rpc, store, signature, now = LATER) => checkPayment({ rpc, store, now, payTo: PAY_TO, signature });
const mark = (rpc, store, signature, now = LATER) => markRefunded({ rpc, store, now, payTo: PAY_TO, signature });

/** Record which addresses an RPC is asked to list, and which transactions it is asked for. */
function watched(rpc) {
  const listed = [];
  const read = [];
  const list = rpc.getSignaturesForAddress;
  const get = rpc.getTransaction;
  rpc.getSignaturesForAddress = (address, options = {}) => {
    listed.push({ address, before: options.before });
    return list(address, options);
  };
  rpc.getTransaction = (signature) => {
    read.push(signature);
    return get(signature);
  };
  return { listed, read, of: (address) => listed.filter((call) => call.address === address).map((call) => call.before) };
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

// ------------------------------------------------------------------ check

test("check: an unspent payment a day old is REFUNDABLE, with its payer, time and possible references", async () => {
  const { reference } = newClaim();
  const tx = payment({ references: [reference] });
  const report = await check(datedRpc([tx]), memoryStore(), sigOf(tx));

  assert.equal(report.verdict, REFUNDABLE);
  assert.equal(report.finalized, true);
  assert.equal(report.succeeded, true);
  assert.equal(report.pays, true);
  assert.equal(report.payer, PAYER);
  assert.equal(report.payerAccount, PAYER_ATA);
  assert.equal(report.blockTime, BLOCK_TIME);
  // Read-only, not a signer, not a program, the mint or the payee.
  assert.deepEqual(report.references, [reference]);
  assert.equal(report.spent, null);
  assert.deepEqual(report.old, []);
  assert.equal(report.oldState, "none");
});

test("check: a payment the live site spent for a grind is USED", async () => {
  const { claim, reference } = newClaim();
  const tx = payment({ references: [reference] });
  const rpc = datedRpc([tx]);
  const store = memoryStore();
  await spendForGrind({ claim, signature: sigOf(tx), rpc, store });

  const report = await check(rpc, store, sigOf(tx));
  assert.equal(report.verdict, USED);
  assert.equal(report.spent.state, "used");
});

test("check: an already marked payment is REFUNDED", async () => {
  const tx = payment({ references: [newAddress()] });
  const store = memoryStore();
  await store.create(spentKey(sigOf(tx)), { refunded: true, at: LATER, payer: PAYER });

  const report = await check(datedRpc([tx]), store, sigOf(tx));
  assert.equal(report.verdict, REFUNDED);
  assert.deepEqual(report.spent, { state: "refunded", at: LATER, payer: PAYER, sentBack: null });
});

test("check: old-version records, as 34623f1 wrote them, under any account the payment names", async () => {
  const reference = newAddress();

  // Consumed: the old version gave this payment a grind.
  const consumed = payment({ references: [reference] });
  const consumedStore = memoryStore();
  await oldConsumed(consumedStore, reference, sigOf(consumed));
  const usedReport = await check(datedRpc([consumed]), consumedStore, sigOf(consumed));
  assert.equal(usedReport.verdict, USED);
  assert.equal(usedReport.oldState, "consumed");

  // Paid: verified, never spent. The old functions are gone, so it can only be refunded.
  const paid = payment({ references: [reference] });
  const paidStore = memoryStore();
  await oldVerified(paidStore, reference, sigOf(paid));
  const paidReport = await check(datedRpc([paid]), paidStore, sigOf(paid));
  assert.equal(paidReport.verdict, REFUNDABLE);
  assert.equal(paidReport.oldState, "paid");

  // The old verify took any address as a reference, so a record under the payee's own
  // account still counts when it names this payment.
  const abused = payment({ references: [reference] });
  const abusedStore = memoryStore();
  await oldConsumed(abusedStore, PAYEE_ATA, sigOf(abused));
  assert.equal((await check(datedRpc([abused]), abusedStore, sigOf(abused))).verdict, USED);
});

test("check: an old record about another payment under the same reference does not count for this one", async () => {
  // Two payments named one reference; the old verify credited the newer one, and it was consumed.
  const reference = newAddress();
  const first = payment({ references: [reference], blockTime: BLOCK_TIME - 60 });
  const second = payment({ references: [reference] });
  const store = memoryStore();
  await oldConsumed(store, reference, sigOf(second));
  const rpc = datedRpc([first, second]);

  assert.equal((await check(rpc, store, sigOf(second))).verdict, USED);
  const report = await check(rpc, store, sigOf(first));
  assert.equal(report.verdict, REFUNDABLE);
  assert.equal(report.oldState, "none");
  assert.deepEqual(report.old, [{ key: reference, status: "consumed", signature: sigOf(second), ours: false }]);
});

test("check: a record under one of its accounts that the old version could not have written is UNCLEAR", async () => {
  for (const record of [{ status: "spent", signature: "x" }, { status: "paid" }, "paid", [1]]) {
    const reference = newAddress();
    const tx = payment({ references: [reference] });
    const store = memoryStore();
    await store.create(reference, record);
    const report = await check(datedRpc([tx]), store, sigOf(tx));
    assert.equal(report.verdict, UNCLEAR, JSON.stringify(record));
    assert.equal(report.oldState, "unreadable");
  }
});

test("check: NOT_A_PAYMENT for an unknown, unfinalized, failed, short, wrong-mint or unreadable transaction", async () => {
  const store = memoryStore();
  const cases = {
    unknown: { entries: [], signature: newSignature() },
    unfinalized: (() => {
      const tx = payment();
      return { entries: [{ tx, status: "confirmed" }], signature: sigOf(tx) };
    })(),
    failed: payment({ err: { InstructionError: [1, { Custom: 1 }] } }),
    short: payment({
      pre: [balance(1, 5_000_000, { owner: PAYER }), balance(2, 7_000_000)],
      post: [balance(1, 4_010_000, { owner: PAYER }), balance(2, 7_990_000)],
    }),
    wrongMint: payment({
      pre: [balance(1, 5_000_000, { owner: PAYER, mint: OTHER_MINT }), balance(2, 0, { mint: OTHER_MINT })],
      post: [balance(1, 4_000_000, { owner: PAYER, mint: OTHER_MINT }), balance(2, 1_000_000, { mint: OTHER_MINT })],
    }),
    unreadable: (() => {
      const tx = payment();
      return { entries: [{ tx, served: { ...tx, meta: { ...tx.meta, preTokenBalances: undefined } } }], signature: sigOf(tx) };
    })(),
  };
  for (const [name, value] of Object.entries(cases)) {
    const { entries, signature } = value.entries ? value : { entries: [value], signature: sigOf(value) };
    const report = await check(datedRpc(entries), store, signature);
    assert.equal(report.verdict, NOT_A_PAYMENT, name);
    assert.equal(report.pays, false, name);
  }
});

test("check: TOO_RECENT until 24 hours after its block time, REFUNDABLE from that moment", async () => {
  const tx = payment({ references: [newAddress()] });
  const rpc = datedRpc([tx]);
  const store = memoryStore();
  assert.equal((await check(rpc, store, sigOf(tx), PAID_AT)).verdict, TOO_RECENT);
  assert.equal((await check(rpc, store, sigOf(tx), LATER - 1)).verdict, TOO_RECENT);
  assert.equal((await check(rpc, store, sigOf(tx), LATER)).verdict, REFUNDABLE);
});

test("check: a payment with no block time is UNCLEAR, since its age is unknown", async () => {
  const tx = payment({ references: [newAddress()], blockTime: null });
  assert.equal((await check(datedRpc([tx]), memoryStore(), sigOf(tx), LATER * 2)).verdict, UNCLEAR);
});

// ------------------------------------------------------------------ the payer

test("the payer is the owner of the one account that lost exactly 1.00 USDC: not the fee payer, whatever else moved", async () => {
  const owner = newAddress();
  const ownerAccount = newAddress();
  const shuffler = newAddress();
  const shufflerA = newAddress();
  const shufflerB = newAddress();
  const receiver = newAddress();
  // Index 0 PAYER signs and pays the fee. The USDC comes from owner's account at index 6.
  const tx = payment({
    references: [newAddress()],
    extraKeys: [ownerAccount, shufflerA, shufflerB],
    pre: [
      balance(1, 9_000_000, { owner: PAYER, mint: OTHER_MINT }),
      balance(2, 7_000_000),
      balance(6, 3_000_000, { owner }),
      balance(7, 5_000_000, { owner: shuffler }),
      balance(8, 0, { owner: receiver }),
    ],
    post: [
      // The fee payer also lost exactly 1_000_000 base units of another mint.
      balance(1, 8_000_000, { owner: PAYER, mint: OTHER_MINT }),
      balance(2, 8_000_000),
      balance(6, 2_000_000, { owner }),
      // Somebody else moved 2.00 USDC between two accounts in the same transaction.
      balance(7, 3_000_000, { owner: shuffler }),
      balance(8, 2_000_000, { owner: receiver }),
    ],
  });
  assert.deepEqual(findPayer(tx, { payTo: PAY_TO }), { payer: owner, account: ownerAccount, why: null });
  const report = await check(datedRpc([tx]), memoryStore(), sigOf(tx));
  assert.equal(report.verdict, REFUNDABLE);
  assert.equal(report.payer, owner);
});

test("no single account that lost exactly 1.00 USDC: no payer, and UNCLEAR", async () => {
  const a = newAddress();
  const b = newAddress();
  const accounts = [newAddress(), newAddress()];
  const cases = {
    "two accounts paid 0.60 and 0.40": payment({
      extraKeys: accounts,
      pre: [balance(2, 0), balance(6, 600_000, { owner: a }), balance(7, 400_000, { owner: b })],
      post: [balance(2, 1_000_000), balance(6, 0, { owner: a }), balance(7, 0, { owner: b })],
    }),
    "two accounts lost 1.00 each": payment({
      extraKeys: accounts,
      pre: [balance(2, 0), balance(6, 1_000_000, { owner: a }), balance(7, 1_000_000, { owner: b }), balance(1, 0, { owner: PAYER })],
      post: [balance(2, 1_000_000), balance(6, 0, { owner: a }), balance(7, 0, { owner: b }), balance(1, 1_000_000, { owner: PAYER })],
    }),
    "the paying account changed owner": payment({
      pre: [balance(1, 5_000_000, { owner: PAYER }), balance(2, 7_000_000)],
      post: [balance(1, 4_000_000, { owner: a }), balance(2, 8_000_000)],
    }),
  };
  for (const [name, tx] of Object.entries(cases)) {
    assert.equal(findPayer(tx, { payTo: PAY_TO }).payer, null, name);
    const report = await check(datedRpc([tx]), memoryStore(), sigOf(tx));
    assert.equal(report.pays, true, name);
    assert.equal(report.verdict, UNCLEAR, name);
  }
});

// ------------------------------------------------------------------ mark-refunded

test("mark-refunded writes { refunded, at, payer } and names the wallet that paid; a second mark is refused", async () => {
  const tx = payment({ references: [newAddress()] });
  const rpc = datedRpc([tx]);
  const store = memoryStore();

  const result = await mark(rpc, store, sigOf(tx), LATER + 1);
  assert.equal(result.marked, true);
  assert.equal(result.payer, PAYER);
  assert.deepEqual(await store.get(spentKey(sigOf(tx))), { refunded: true, at: LATER + 1, payer: PAYER });

  const again = await mark(rpc, store, sigOf(tx), LATER + 2);
  assert.equal(again.marked, false);
  assert.equal(again.report.verdict, REFUNDED);
  assert.deepEqual(await store.get(spentKey(sigOf(tx))), { refunded: true, at: LATER + 1, payer: PAYER });
});

test("mark-refunded refuses USED, REFUNDED, TOO_RECENT, NOT_A_PAYMENT and UNCLEAR, and writes nothing", async () => {
  const setups = {
    [USED]: async () => {
      const { claim, reference } = newClaim();
      const tx = payment({ references: [reference] });
      const rpc = datedRpc([tx]);
      const store = memoryStore();
      await spendForGrind({ claim, signature: sigOf(tx), rpc, store });
      return { rpc, store, signature: sigOf(tx) };
    },
    [`${USED} (old version)`]: async () => {
      const reference = newAddress();
      const tx = payment({ references: [reference] });
      const store = memoryStore();
      await oldConsumed(store, reference, sigOf(tx));
      return { rpc: datedRpc([tx]), store, signature: sigOf(tx) };
    },
    [REFUNDED]: async () => {
      const tx = payment();
      const store = memoryStore();
      await store.create(spentKey(sigOf(tx)), { refunded: true, at: LATER, payer: PAYER });
      return { rpc: datedRpc([tx]), store, signature: sigOf(tx) };
    },
    [TOO_RECENT]: async () => {
      const tx = payment({ blockTime: BLOCK_TIME + 1 });
      return { rpc: datedRpc([tx]), store: memoryStore(), signature: sigOf(tx) };
    },
    [NOT_A_PAYMENT]: async () => {
      const tx = payment({ err: { InstructionError: [1, "Custom"] } });
      return { rpc: datedRpc([tx]), store: memoryStore(), signature: sigOf(tx) };
    },
    [UNCLEAR]: async () => {
      const tx = payment({
        pre: [balance(1, 5_000_000, { owner: PAYER }), balance(2, 7_000_000)],
        post: [balance(1, 4_000_000, { owner: newAddress() }), balance(2, 8_000_000)],
      });
      return { rpc: datedRpc([tx]), store: memoryStore(), signature: sigOf(tx) };
    },
  };
  for (const [name, setup] of Object.entries(setups)) {
    const { rpc, store, signature } = await setup();
    const before = await store.get(spentKey(signature));
    const result = await mark(rpc, store, signature);
    assert.equal(result.marked, false, name);
    assert.equal(result.report.verdict, name.split(" ")[0], name);
    assert.equal(result.payer, undefined, name);
    assert.deepEqual(await store.get(spentKey(signature)), before, name);
  }
});

test("mark-refunded refuses when the payment is spent between its check and its mark", async () => {
  const tx = payment();
  const ledger = memoryStore();
  // consume wins the conditional create a moment before the refund mark tries it.
  const racing = {
    get: ledger.get,
    async create(key, value) {
      await ledger.create(key, { at: LATER, jti: "the-winning-token" });
      return ledger.create(key, value);
    },
  };
  const result = await mark(datedRpc([tx]), racing, sigOf(tx));
  assert.equal(result.marked, false);
  assert.equal(result.report.verdict, REFUNDABLE);
  assert.equal(result.payer, undefined);
  assert.match(result.why, /between the check and the mark/);
  assert.deepEqual(await ledger.get(spentKey(sigOf(tx))), { at: LATER, jti: "the-winning-token" });
});

test("after mark-refunded, the server's own verify and consume answer 409 refunded for that payment", async () => {
  const { claim, reference } = newClaim();
  const tx = payment({ references: [reference] });
  const signature = sigOf(tx);
  const rpc = datedRpc([tx]);
  const store = memoryStore();
  // The customer's page was given a token before the refund, and never spent it.
  const issued = await verifyPayment({ claim, signature, rpc, store, payTo: PAY_TO, secret: SECRET, now: LATER });
  assert.equal(issued.status, 200);

  assert.equal((await mark(rpc, store, signature, LATER + 1_000)).marked, true);

  for (const asked of [{ signature }, {}]) {
    const verified = await verifyPayment({ claim, ...asked, rpc, store, payTo: PAY_TO, secret: SECRET, now: LATER + 2_000 });
    assert.deepEqual([verified.status, verified.reason], [409, "refunded"]);
  }
  const consumed = await consumeUnlock({ token: issued.token, store, secret: SECRET, now: LATER + 3_000 });
  assert.deepEqual([consumed.status, consumed.reason], [409, "refunded"]);
  assert.deepEqual(await store.get(spentKey(signature)), { refunded: true, at: LATER + 1_000, payer: PAYER });
});

// ------------------------------------------------------------------ old-payments

test("old-payments: the payee account is the payee's USDC associated token account", () => {
  assert.equal(payeeUsdcAccount(PAY_TO), "5edXXhVJaW3prmqwhfjkSdRNwP4TG7fRiX1YLyfsW8iT");
});

test("old-payments pages back past a full page, skips what landed at or after --until, and stops at --since", async () => {
  const until = PAID_AT;
  const since = (BLOCK_TIME - 500) * 1000;
  const failed = (blockTime) => payment({ blockTime, err: { InstructionError: [1, "Custom"] } });
  const older = Array.from({ length: SIGNATURE_LIMIT }, () => failed(BLOCK_TIME - 2_000));
  const beforeSince = payment({ blockTime: BLOCK_TIME - 1_000 });
  const atSince = payment({ blockTime: BLOCK_TIME - 500 });
  const between = Array.from({ length: SIGNATURE_LIMIT }, () => failed(BLOCK_TIME - 300));
  const inside = payment({ blockTime: BLOCK_TIME - 100 });
  const lastBefore = payment({ blockTime: BLOCK_TIME - 1 });
  const atUntil = payment({ blockTime: BLOCK_TIME });
  const after = payment({ blockTime: BLOCK_TIME + 100 });
  const rpc = datedRpc([...older, beforeSince, atSince, ...between, inside, lastBefore, atUntil, after]);
  const seen = watched(rpc);

  const found = await collect(oldPayments({ rpc, store: memoryStore(), now: until + 2 * DAY, payTo: PAY_TO, until, since, payeeAccount: PAYEE_ATA }));

  assert.deepEqual(found.map((report) => report.signature), [lastBefore, inside, atSince].map(sigOf));
  assert.ok(found.every((report) => report.verdict === REFUNDABLE));
  // The payee's account: newest page, then one more from where it ended. The second page is
  // full too, but the listing stops at the first transaction older than --since.
  // Page one: after, atUntil, lastBefore, inside and between[999..4].
  assert.deepEqual(seen.of(PAYEE_ATA), [undefined, sigOf(between[4])]);
  // Failed transactions are never read, here or in the payer's history.
  const failedSigs = new Set([...older, ...between].map(sigOf));
  assert.equal(seen.read.filter((signature) => failedSigs.has(signature)).length, 0);
});

test("old-payments without --since walks to the oldest transaction", async () => {
  const filler = Array.from({ length: SIGNATURE_LIMIT + 5 }, () => payment({ blockTime: BLOCK_TIME - 50, err: { InstructionError: [0, "Custom"] } }));
  const first = payment({ blockTime: BLOCK_TIME - 10_000 });
  const rpc = datedRpc([first, ...filler]);
  const seen = watched(rpc);
  const found = await collect(oldPayments({ rpc, store: memoryStore(), now: PAID_AT + DAY, payTo: PAY_TO, until: PAID_AT, payeeAccount: PAYEE_ATA }));
  assert.deepEqual(found.map((report) => report.signature), [sigOf(first)]);
  assert.equal(seen.of(PAYEE_ATA).length, 2);
});

test("old-payments classifies each payment by the old records and spent/, and skips what does not pay", async () => {
  const until = PAID_AT;
  // Two minutes short of a day after --until: a day past everything but `recent`.
  const now = until + DAY - 120_000;
  const store = memoryStore();
  const t = (offset) => BLOCK_TIME - 3_600 + offset;

  const consumedRef = newAddress();
  const consumed = payment({ references: [consumedRef], blockTime: t(1) });
  await oldConsumed(store, consumedRef, sigOf(consumed));

  const paidRef = newAddress();
  const paid = payment({ references: [paidRef], blockTime: t(2) });
  await oldVerified(store, paidRef, sigOf(paid));

  const neverVerified = payment({ references: [newAddress()], blockTime: t(3) });

  const spentRef = newAddress();
  const spent = payment({ references: [spentRef], blockTime: t(4) });
  await oldVerified(store, spentRef, sigOf(spent));
  await store.create(spentKey(sigOf(spent)), { at: until + 10, jti: "a-token" });

  const refunded = payment({ references: [newAddress()], blockTime: t(5) });
  await store.create(spentKey(sigOf(refunded)), { refunded: true, at: until + 20, payer: PAYER });

  const strangeRef = newAddress();
  const strange = payment({ references: [strangeRef], blockTime: t(6) });
  await store.create(strangeRef, { status: "consumed" });

  // Not payments: a refund sent from the payee, a short payment, a failed one. The refund
  // went to PAYER with no mark, before `refunded` was marked: it was sent by hand, and
  // answers PAYER's oldest unused, unmarked payment, `paid`.
  const refundSent = payment({
    blockTime: t(7),
    pre: [balance(1, 0, { owner: PAYER }), balance(2, 9_000_000)],
    post: [balance(1, 1_000_000, { owner: PAYER }), balance(2, 8_000_000)],
  });
  const short = payment({
    blockTime: t(8),
    pre: [balance(1, 5_000_000, { owner: PAYER }), balance(2, 0)],
    post: [balance(1, 4_500_000, { owner: PAYER }), balance(2, 500_000)],
  });
  const failed = payment({ blockTime: t(9), err: { InstructionError: [1, "Custom"] } });

  // A minute before --until, so less than a day before now: listed, but not yet refundable.
  const recent = payment({ references: [newAddress()], blockTime: BLOCK_TIME - 60 });
  const rpc = datedRpc([consumed, paid, neverVerified, spent, refunded, strange, refundSent, short, failed, recent]);

  const found = await collect(oldPayments({ rpc, store, now, payTo: PAY_TO, until, payeeAccount: PAYEE_ATA }));
  const seen = Object.fromEntries(found.map((report) => [report.signature, [report.verdict, report.oldState]]));
  assert.deepEqual(seen, {
    [sigOf(recent)]: [TOO_RECENT, "none"],
    [sigOf(strange)]: [UNCLEAR, "unreadable"],
    [sigOf(refunded)]: [REFUNDED, "none"],
    [sigOf(spent)]: [USED, "paid"],
    [sigOf(neverVerified)]: [REFUNDABLE, "none"],
    [sigOf(paid)]: [SENT_BACK, "paid"],
    [sigOf(consumed)]: [USED, "consumed"],
  });
  assert.equal(found.find((report) => report.signature === sigOf(paid)).sentBack, sigOf(refundSent));
  assert.ok(found.filter((report) => report.verdict === REFUNDABLE).every((report) => report.payer === PAYER));
});

test("old-payments through the command line lists unspent payments and leaves out used and refunded ones", async () => {
  const store = memoryStore();
  const usedRef = newAddress();
  const used = payment({ references: [usedRef], blockTime: BLOCK_TIME - 30 });
  await oldConsumed(store, usedRef, sigOf(used));
  const refunded = payment({ blockTime: BLOCK_TIME - 20 });
  await store.create(spentKey(sigOf(refunded)), { refunded: true, at: PAID_AT, payer: PAYER });
  const openRef = newAddress();
  const open = payment({ references: [openRef], blockTime: BLOCK_TIME - 10 });
  await oldVerified(store, openRef, sigOf(open));
  // The real payee account: that is what the command lists.
  const rpc = datedRpc([used, refunded, open].map((tx) => {
    tx.transaction.message.accountKeys.push({ pubkey: payeeUsdcAccount(PAY_TO), signer: false, writable: true, source: "transaction" });
    return tx;
  }));

  const { code, out } = await runMain(["old-payments", "--until", new Date(PAID_AT).toISOString()], { rpc, store, now: PAID_AT + DAY });
  assert.equal(code, 0, out);
  // Signature, time, paying wallet, old record, verdict.
  assert.match(out, new RegExp(`\n${sigOf(open)}  ${new Date((BLOCK_TIME - 10) * 1000).toISOString()}  ${PAYER}  paid  ${REFUNDABLE}\n`));
  assert.ok(!out.includes(sigOf(used)), out);
  assert.ok(!out.includes(sigOf(refunded)), out);
  assert.match(out, /Listed 1\. Not listed: 1 used for a grind, 1 already refunded\./);
});

test("old-payments refuses an --until in the future and a --since not before it", async () => {
  const run = (until, since) => collect(oldPayments({ rpc: datedRpc([]), store: memoryStore(), now: PAID_AT, payTo: PAY_TO, until, since }));
  await assert.rejects(run(PAID_AT + 1), /after publishing/);
  await assert.rejects(run(PAID_AT, PAID_AT), /--since must be earlier/);
  assert.deepEqual(await run(PAID_AT, PAID_AT - 1), []);
});

// ------------------------------------------------------------------ the command line

const ENV = {
  SOLANA_RPC_URL: "http://127.0.0.1:9/key-in-path?api-key=SECRET",
  NETLIFY_SITE_ID: "11111111-2222-3333-4444-555555555555",
  NETLIFY_AUTH_TOKEN: "nfp_FAKEtokenThatMustNeverBePrinted",
};
const LEAKS = ["SECRET", "key-in-path", "api-key", "127.0.0.1:9", ENV.NETLIFY_AUTH_TOKEN, "FAKEtoken"];

/** A @netlify/blobs store over a memoryStore, answering the calls store.js makes. */
function blobsLike(store, { failWith } = {}) {
  return {
    async get(key, options) {
      if (failWith) throw failWith;
      assert.deepEqual(options, { type: "json" });
      return store.get(key);
    },
    async setJSON(key, value, options) {
      assert.deepEqual(options, { onlyIfNew: true });
      return { modified: await store.create(key, value) };
    },
  };
}

async function runMain(argv, { rpc, store = memoryStore(), env = ENV, now = LATER, blobs } = {}) {
  const lines = [];
  const errors = [];
  const opened = [];
  let rpcUrl;
  const code = await main(argv, {
    env,
    now: () => now,
    print: (line) => lines.push(line),
    printError: (line) => errors.push(line),
    createRpc: (url) => {
      rpcUrl = url;
      return rpc;
    },
    getStore: (options) => {
      opened.push(options);
      return blobs ?? blobsLike(store);
    },
  });
  return { code, out: lines.join("\n"), err: errors.join("\n"), opened, rpcUrl };
}

test("the command line reads with the operator's site and token, from grind-payments, strongly consistent", async () => {
  const tx = payment({ references: [newAddress()] });
  const store = memoryStore();
  const { code, out, opened, rpcUrl } = await runMain(["check", sigOf(tx)], { rpc: datedRpc([tx]), store });
  assert.equal(code, 0);
  assert.equal(rpcUrl, ENV.SOLANA_RPC_URL);
  assert.deepEqual(opened, [
    { name: "grind-payments", consistency: "strong", siteID: ENV.NETLIFY_SITE_ID, token: ENV.NETLIFY_AUTH_TOKEN },
  ]);
  assert.match(out, new RegExp(`paid by: +${PAYER} \\(its USDC account ${PAYER_ATA}\\)`));
  assert.match(out, /Verdict: REFUNDABLE/);
  for (const leak of LEAKS) assert.equal(out.includes(leak), false, leak);

  const marked = await runMain(["mark-refunded", sigOf(tx)], { rpc: datedRpc([tx]), store });
  assert.equal(marked.code, 0, marked.err);
  assert.match(marked.out, new RegExp(`Send exactly 1\\.00 USDC from the payee wallet ${PAY_TO} to:\\n  ${PAYER}\\n`));
  assert.deepEqual(await store.get(spentKey(sigOf(tx))), { refunded: true, at: LATER, payer: PAYER });

  const again = await runMain(["mark-refunded", sigOf(tx)], { rpc: datedRpc([tx]), store });
  assert.equal(again.code, 1);
  assert.match(again.out, /Verdict: REFUNDED/);
  assert.equal(again.out.includes("Send exactly"), false);
});

test("the command line never prints the token or the RPC URL, even inside a library's error", async () => {
  const tx = payment();
  const failWith = new Error(`401 for Bearer ${ENV.NETLIFY_AUTH_TOKEN} via ${ENV.SOLANA_RPC_URL} and /key-in-path`);
  const { code, err } = await runMain(["mark-refunded", sigOf(tx)], { rpc: datedRpc([tx]), blobs: blobsLike(memoryStore(), { failWith }) });
  assert.equal(code, 1);
  assert.match(err, /Stopped: Error: 401 for Bearer \[redacted\]/);
  assert.match(err, /Run check before sending anything/);
  for (const leak of LEAKS) assert.equal(err.includes(leak), false, leak);
});

test("the command line names a missing setting without printing any value, and checks its arguments first", async () => {
  const { NETLIFY_AUTH_TOKEN, ...partial } = ENV;
  const missing = await runMain(["check", newSignature()], { env: partial });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Set NETLIFY_AUTH_TOKEN in this shell first/);
  assert.deepEqual(missing.opened, []);
  assert.equal(missing.rpcUrl, undefined);
  for (const leak of LEAKS) assert.equal(missing.err.includes(leak), false, leak);

  for (const argv of [
    [],
    ["refund", newSignature()],
    ["check"],
    ["check", PAYER],
    ["mark-refunded", newSignature(), "extra"],
    ["old-payments"],
    ["old-payments", "--since", "2026-11-01T00:00:00Z"],
    ["old-payments", "--until", "2026-11-01"],
    ["old-payments", "--until", "2026-11-01T00:00:00"],
    ["old-payments", "--until", "2026-11-01T00:00:00Z", "--until", "2026-11-02T00:00:00Z"],
    ["old-payments", "--until", "2026-11-01T00:00:00Z", "--to", "x"],
  ]) {
    const result = await runMain(argv, { env: {} });
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, /Usage:/, argv.join(" "));
  }
});

test("run as a program with a failing RPC, no command prints the token or any part of the RPC URL", async () => {
  const env = { ...ENV };
  for (const name of ["PATH", "SystemRoot"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  const runs = [
    ["check", newSignature()],
    ["mark-refunded", newSignature()],
    ["old-payments", "--until", "2026-11-16T00:00:00Z"],
  ];
  const results = await Promise.all(
    runs.map((args) =>
      promisify(execFile)(process.execPath, [SCRIPT, ...args], { env, cwd: webRoot, timeout: 60_000 }).then(
        (done) => ({ code: 0, ...done }),
        (failed) => failed
      )
    )
  );
  results.forEach((result, i) => {
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.code, 1, `${runs[i][0]}: ${output}`);
    assert.match(output, /The Solana RPC did not answer usefully \((getTransaction|getSignaturesForAddress): network\)/, runs[i][0]);
    for (const leak of LEAKS) assert.equal(output.includes(leak), false, `${runs[i][0]} printed ${leak}`);
  });
});

test("the tool is not a function, no function imports it, and the built site does not contain it", async () => {
  assert.equal(path.relative(webRoot, SCRIPT).split(path.sep).join("/"), "scripts/payments.mjs");
  // Netlify deploys what is in netlify/functions (both netlify.toml files say so) and nothing else as an endpoint.
  for (const toml of ["netlify.toml", "../netlify.toml"]) {
    assert.match(fs.readFileSync(path.join(webRoot, toml), "utf8"), /\n\s*directory = "netlify\/functions"\r?\n/);
  }
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(path.join(webRoot, "netlify", "functions"))) {
    assert.equal(fs.readFileSync(file, "utf8").includes("payments.mjs"), false, file);
  }

  const markers = ["mark-refunded", "old-payments", "NETLIFY_AUTH_TOKEN", "REFUND_MIN_AGE_MS"];
  const clean = (root, files) => {
    for (const file of files) {
      const text = fs.readFileSync(file, "latin1");
      for (const marker of markers) assert.equal(text.includes(marker), false, `${path.relative(root, file)} contains ${marker}`);
    }
  };
  // public/ is copied into the site as it is.
  clean(path.join(webRoot, "public"), walk(path.join(webRoot, "public")));
  // The bundle, built for production into a folder of its own. build.test.js builds dist/ at the same
  // time and briefly adds a probe page to public/, so this build leaves public/ out (checked above).
  const { build } = await import("vite");
  const cache = path.join(webRoot, "node_modules", ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const out = fs.mkdtempSync(path.join(cache, "payments-admin-build-"));
  try {
    await build({
      root: webRoot,
      configFile: path.join(webRoot, "vite.config.js"),
      publicDir: false,
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
    });
    const files = walk(out);
    assert.ok(files.some((file) => file.endsWith("index.html")));
    assert.ok(files.some((file) => file.endsWith(".js")));
    clean(out, files);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── Round 5 ───────────────────────────────────────────────────────────────────

/** A transfer of exactly 1.00 USDC from the payee back to PAYER, as an operator sends a refund by hand. */
function refundTx(blockTime) {
  return payment({
    references: [],
    blockTime,
    pre: [balance(1, 0, { owner: PAYER }), balance(2, 9_000_000)],
    post: [balance(1, 1_000_000, { owner: PAYER }), balance(2, 8_000_000)],
  });
}

test("a 1.00 USDC transfer that names no reference (a tip) is not a payment: check, mark-refunded and old-payments leave it alone", async () => {
  const tip = payment({ references: [] });
  // A sysvar is read-only and no signer, but it is never a reference.
  const sysvarOnly = payment({ references: ["SysvarRent111111111111111111111111111111111"] });
  const store = memoryStore();
  const rpc = datedRpc([tip, sysvarOnly]);
  for (const tx of [tip, sysvarOnly]) {
    const report = await check(rpc, store, sigOf(tx));
    assert.equal(report.verdict, NOT_A_PAYMENT);
    assert.equal(report.reason, "no_reference");
    assert.match(report.why, /names no reference account.*such as a tip, is not a payment/);
    assert.equal((await mark(rpc, store, sigOf(tx))).marked, false);
    assert.equal(await store.get(spentKey(sigOf(tx))), null);
  }
  assert.deepEqual(await collect(oldPayments({ rpc, store, now: LATER + DAY, payTo: PAY_TO, until: LATER, payeeAccount: PAYEE_ATA })), []);
});

test("old-payments starts at the launch unless told otherwise", async () => {
  const launch = Math.floor(LAUNCH_AT / 1000);
  assert.equal(new Date(LAUNCH_AT).toISOString(), "2026-11-15T14:37:02.000Z");
  const beforeLaunch = payment({ blockTime: launch - 60 });
  const afterLaunch = payment({ blockTime: launch + 60 });
  const rpc = datedRpc([beforeLaunch, afterLaunch]);
  const args = { rpc, store: memoryStore(), now: LATER, payTo: PAY_TO, until: PAID_AT, payeeAccount: PAYEE_ATA };
  assert.deepEqual((await collect(oldPayments(args))).map((report) => report.signature), [sigOf(afterLaunch)]);
  const all = await collect(oldPayments({ ...args, since: (launch - 3_600) * 1000 }));
  assert.deepEqual(all.map((report) => report.signature), [sigOf(afterLaunch), sigOf(beforeLaunch)]);
});

test("a payment already refunded by hand is SENT_BACK: check says send nothing, mark-refunded records it, old-payments says so", async () => {
  const first = payment({ blockTime: BLOCK_TIME - 600 });
  const second = payment({ blockTime: BLOCK_TIME - 300 });
  const byHand = refundTx(BLOCK_TIME - 100); // one refund, after both: it answers the older one
  const store = memoryStore();
  const rpc = datedRpc([first, second, byHand]);

  const sent = await check(rpc, store, sigOf(first));
  assert.equal(sent.verdict, SENT_BACK);
  assert.equal(sent.sentBack, sigOf(byHand));
  assert.match(sent.why, /already went back from the payee to the wallet that paid.*Send nothing/);
  assert.equal((await check(rpc, store, sigOf(second))).verdict, REFUNDABLE);
  const listed = await collect(oldPayments({ rpc, store, now: LATER, payTo: PAY_TO, until: PAID_AT, payeeAccount: PAYEE_ATA }));
  assert.deepEqual(
    listed.map((report) => [report.signature, report.verdict]),
    [
      [sigOf(second), REFUNDABLE],
      [sigOf(first), SENT_BACK],
    ]
  );

  const marked = await mark(rpc, store, sigOf(first));
  assert.equal(marked.marked, true);
  assert.equal(marked.alreadySent, sigOf(byHand));
  assert.deepEqual(await store.get(spentKey(sigOf(first))), { refunded: true, at: LATER, payer: PAYER, sentBack: sigOf(byHand) });
  // Marked, it is REFUNDED, and the hand refund still belongs to it, not to the next payment.
  assert.equal((await check(rpc, store, sigOf(first))).verdict, REFUNDED);
  assert.equal((await check(rpc, store, sigOf(second))).verdict, REFUNDABLE);

  // Through the command line: nothing to send.
  const { code, out } = await runMain(["mark-refunded", sigOf(first)], { rpc, store: memoryStore(), now: LATER });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`already sent back in ${sigOf(byHand)}\\. Send nothing\\.`));
  assert.doesNotMatch(out, /Send exactly/);
});

test("a refund sent after a payment was marked belongs to that payment; one sent before any mark answers the oldest unmarked one", async () => {
  const marked = payment({ blockTime: BLOCK_TIME - 900 });
  const unmarked = payment({ blockTime: BLOCK_TIME - 800 });
  const afterMark = refundTx(BLOCK_TIME - 100);
  const rpc = datedRpc([marked, unmarked, afterMark]);
  // The runbook marks first and sends second: the refund after the mark is the marked payment's.
  const store = memoryStore();
  await store.create(spentKey(sigOf(marked)), { refunded: true, at: (BLOCK_TIME - 200) * 1000, payer: PAYER });
  assert.equal((await check(rpc, store, sigOf(unmarked))).verdict, REFUNDABLE);

  // The same refund sent before the mark was written was a hand refund of the oldest unmarked payment.
  const early = memoryStore();
  await early.create(spentKey(sigOf(marked)), { refunded: true, at: (BLOCK_TIME - 50) * 1000, payer: PAYER });
  const report = await check(rpc, early, sigOf(unmarked));
  assert.equal(report.verdict, SENT_BACK);
  assert.equal(report.sentBack, sigOf(afterMark));
});

// SOL payments of the launch versions.
const SYSTEM = "11111111111111111111111111111111";
function solTx({ from, to, lamports, references = [], blockTime = BLOCK_TIME, fee = 5_000, err = null }) {
  const keys = [from, to, ...references, SYSTEM];
  const pre = [10_000_000_000, 5_000_000_000, ...references.map(() => 0), 1];
  const post = [pre[0] - lamports - fee, pre[1] + lamports, ...references.map(() => 0), 1];
  return {
    slot: 300_000_000,
    blockTime,
    meta: { err, fee, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [] },
    transaction: {
      signatures: [newSignature()],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 2, source: "transaction" })),
        instructions: [{ programId: SYSTEM }],
      },
    },
  };
}

test("old-sol-payments lists the launch versions' SOL payments nothing used, with the wallet and the exact SOL to send back", async () => {
  const store = memoryStore();
  const t = (offset) => BLOCK_TIME - 3_600 + offset;
  const usedRef = newAddress();
  const used = solTx({ from: PAYER, to: PAY_TO, lamports: 7_000_000, references: [usedRef], blockTime: t(1) });
  await store.create(usedRef, { status: "consumed", asset: "sol", signature: sigOf(used), at: 1 });
  const paidRef = newAddress();
  const paid = solTx({ from: PAYER, to: PAY_TO, lamports: 6_500_000, references: [paidRef], blockTime: t(2) });
  await store.create(paidRef, { status: "paid", asset: "sol", signature: sigOf(paid), at: 1 });
  const other = newAddress();
  const neverVerified = solTx({ from: other, to: PAY_TO, lamports: 6_400_000, references: [newAddress()], blockTime: t(3) });
  const tip = solTx({ from: other, to: PAY_TO, lamports: 6_400_000, blockTime: t(4) });
  const handRefund = solTx({ from: PAY_TO, to: other, lamports: 6_400_000, blockTime: t(5) });
  const failed = solTx({ from: PAYER, to: PAY_TO, lamports: 6_300_000, references: [newAddress()], blockTime: t(6), err: { InstructionError: [0, "Custom"] } });
  const afterUntil = solTx({ from: PAYER, to: PAY_TO, lamports: 6_000_000, references: [newAddress()], blockTime: BLOCK_TIME + 10 });
  const rpc = datedRpc([used, paid, neverVerified, tip, handRefund, failed, afterUntil]);

  const found = await collect(oldSolPayments({ rpc, store, now: LATER, payTo: PAY_TO, until: PAID_AT }));
  const seen = Object.fromEntries(found.map((r) => [r.signature, [r.verdict, r.payer, r.lamports, r.oldState]]));
  assert.deepEqual(seen, {
    [sigOf(used)]: [USED, PAYER, 7_000_000, "consumed"],
    [sigOf(paid)]: [REFUNDABLE, PAYER, 6_500_000, "paid"],
    [sigOf(neverVerified)]: [SENT_BACK, other, 6_400_000, "none"],
  });
  assert.equal(found.find((r) => r.signature === sigOf(neverVerified)).sentBack, sigOf(handRefund));

  const { code, out } = await runMain(["old-sol-payments", "--until", new Date(PAID_AT).toISOString()], { rpc, store, now: LATER });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`\n${sigOf(paid)}  ${new Date(t(2) * 1000).toISOString()}  ${PAYER}  0\\.006500000  paid  ${REFUNDABLE}\n`));
  assert.match(out, /Listed 2\. Not listed: 1 used for a grind\./);
  assert.ok(!out.includes(sigOf(tip)) && !out.includes(sigOf(afterUntil)) && !out.includes(sigOf(failed)), out);
});
