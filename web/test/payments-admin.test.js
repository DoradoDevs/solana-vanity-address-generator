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
import { RpcError } from "../netlify/functions/lib/rpc.js";
import {
  LAUNCH_AT,
  LAUNCH_SOL_LAMPORTS,
  MARKED,
  MAYBE_REFUNDED,
  NOT_A_PAYMENT,
  REFUNDABLE,
  REFUNDED,
  REFUND_MIN_AGE_MS,
  SENT_BACK,
  TOO_RECENT,
  UNCLASSIFIED,
  UNCLEAR,
  USED,
  checkPayment,
  findPayer,
  isUsdcRefund,
  main,
  markRefunded,
  oldPayments,
  oldSolPayments,
  payeeUsdcAccount,
  refundSentKey,
  refundTransferKey,
  retrying,
  solPayment,
} from "../scripts/payments.mjs";
import {
  OTHER_MINT,
  PAYEE_ATA,
  PAYER,
  PAYER_ATA,
  PAY_TO,
  STRANGER,
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
 * A slot for a transaction landed at `blockTime`: later times get later
 * slots, and of two made for the same time the one made second is later, as
 * on chain.
 */
let slotsMade = 0;
const slotAt = (blockTime) => (blockTime ?? BLOCK_TIME) * 100_000 + (slotsMade++ % 100_000);

/**
 * paymentTx with a block time and slot (chain.js gives every transaction the
 * same ones) and, like every payment the page builds, a reference account of
 * its own.
 */
function payment({ blockTime = BLOCK_TIME, references = [newClaim().reference], ...options } = {}) {
  const tx = paymentTx({ references, ...options });
  tx.blockTime = blockTime;
  tx.slot = slotAt(blockTime);
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

test("check: a marked payment is MARKED until its refund transfer is recorded, then REFUNDED", async () => {
  const tx = payment({ references: [newAddress()] });
  const store = memoryStore();
  await store.create(spentKey(sigOf(tx)), { refunded: true, at: LATER, payer: PAYER });

  const marked = await check(datedRpc([tx]), store, sigOf(tx));
  assert.equal(marked.verdict, MARKED);
  assert.deepEqual(marked.spent, { state: "refunded", at: LATER, payer: PAYER });
  assert.equal(marked.recorded, null);
  assert.match(marked.why, /no refund transfer is recorded.*send the refund, then record it with --sent/);

  const transfer = newSignature();
  await store.create(refundSentKey(sigOf(tx)), { transfer, at: LATER });
  const refunded = await check(datedRpc([tx]), store, sigOf(tx));
  assert.equal(refunded.verdict, REFUNDED);
  assert.equal(refunded.recorded, transfer);
  assert.match(refunded.why, /Send nothing/);
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
  assert.equal(again.report.verdict, MARKED);
  assert.deepEqual(await store.get(spentKey(sigOf(tx))), { refunded: true, at: LATER + 1, payer: PAYER });
});

test("mark-refunded refuses USED, MARKED, REFUNDED, TOO_RECENT, NOT_A_PAYMENT and UNCLEAR, and writes nothing", async () => {
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
    [MARKED]: async () => {
      const tx = payment();
      const store = memoryStore();
      await store.create(spentKey(sigOf(tx)), { refunded: true, at: LATER, payer: PAYER });
      return { rpc: datedRpc([tx]), store, signature: sigOf(tx) };
    },
    [REFUNDED]: async () => {
      const tx = payment();
      const store = memoryStore();
      await store.create(spentKey(sigOf(tx)), { refunded: true, at: LATER, payer: PAYER });
      await store.create(refundSentKey(sigOf(tx)), { transfer: newSignature(), at: LATER });
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
  await store.create(refundSentKey(sigOf(refunded)), { transfer: newSignature(), at: until + 30 });

  const marked = payment({ references: [newAddress()], blockTime: t(5) });
  await store.create(spentKey(sigOf(marked)), { refunded: true, at: until + 20, payer: PAYER });

  const strangeRef = newAddress();
  const strange = payment({ references: [strangeRef], blockTime: t(6) });
  await store.create(strangeRef, { status: "consumed" });

  // Not payments: a refund sent from the payee (to another wallet), a short payment, a failed one.
  const someoneElse = newAddress();
  const refundSent = payment({
    blockTime: t(7),
    pre: [balance(1, 0, { owner: someoneElse }), balance(2, 9_000_000)],
    post: [balance(1, 1_000_000, { owner: someoneElse }), balance(2, 8_000_000)],
  });
  const short = payment({
    blockTime: t(8),
    pre: [balance(1, 5_000_000, { owner: PAYER }), balance(2, 0)],
    post: [balance(1, 4_500_000, { owner: PAYER }), balance(2, 500_000)],
  });
  const failed = payment({ blockTime: t(9), err: { InstructionError: [1, "Custom"] } });

  // A minute before --until, so less than a day before now: listed, but not yet refundable.
  const recent = payment({ references: [newAddress()], blockTime: BLOCK_TIME - 60 });
  const rpc = datedRpc([consumed, paid, neverVerified, spent, refunded, marked, strange, refundSent, short, failed, recent]);

  const found = await collect(oldPayments({ rpc, store, now, payTo: PAY_TO, until, payeeAccount: PAYEE_ATA }));
  const seen = Object.fromEntries(found.map((report) => [report.signature, [report.verdict, report.oldState]]));
  assert.deepEqual(seen, {
    [sigOf(recent)]: [TOO_RECENT, "none"],
    [sigOf(strange)]: [UNCLEAR, "unreadable"],
    [sigOf(marked)]: [MARKED, "none"],
    [sigOf(refunded)]: [REFUNDED, "none"],
    [sigOf(spent)]: [USED, "paid"],
    [sigOf(neverVerified)]: [REFUNDABLE, "none"],
    [sigOf(paid)]: [REFUNDABLE, "paid"],
    [sigOf(consumed)]: [USED, "consumed"],
  });
  assert.ok(found.filter((report) => report.verdict === REFUNDABLE).every((report) => report.payer === PAYER));
});

test("old-payments through the command line lists unspent payments and leaves out used and refunded ones", async () => {
  const store = memoryStore();
  const usedRef = newAddress();
  const used = payment({ references: [usedRef], blockTime: BLOCK_TIME - 30 });
  await oldConsumed(store, usedRef, sigOf(used));
  const refunded = payment({ blockTime: BLOCK_TIME - 20 });
  await store.create(spentKey(sigOf(refunded)), { refunded: true, at: PAID_AT, payer: PAYER });
  await store.create(refundSentKey(sigOf(refunded)), { transfer: newSignature(), at: PAID_AT });
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
  assert.match(out, /Listed 1\. Not listed: 1 used for a grind, 1 refunded\./);
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
  assert.match(marked.out, new RegExp(`Then record it: mark-refunded ${sigOf(tx)} --sent <the transfer's signature>\\.`));
  assert.deepEqual(await store.get(spentKey(sigOf(tx))), { refunded: true, at: LATER, payer: PAYER });

  const again = await runMain(["mark-refunded", sigOf(tx)], { rpc: datedRpc([tx]), store });
  assert.equal(again.code, 1);
  assert.match(again.out, /Verdict: MARKED/);
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
    ["mark-refunded", newSignature(), "--sent"],
    ["mark-refunded", newSignature(), "--sent", PAYER],
    ["mark-refunded", newSignature(), "--sent", newSignature(), "x"],
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

// ── Refunds: what went back to a wallet, and the record of which payment it refunded ──

/**
 * USDC from the payee back to a wallet, as an operator sends a refund: by
 * default exactly 1.00 to PAYER, landing in PAYER's associated account.
 * `account` puts it in another token account instead.
 */
function transferBack({ blockTime = BLOCK_TIME - 100, to = PAYER, units = 1_000_000, account, ...options } = {}) {
  const tx = payment({
    references: [],
    blockTime,
    pre: [balance(1, 0, { owner: to }), balance(2, 9_000_000)],
    post: [balance(1, units, { owner: to }), balance(2, 9_000_000 - units)],
    ...options,
  });
  if (account) tx.transaction.message.accountKeys[1].pubkey = account;
  return tx;
}

/** A payment from `account`, a USDC account of PAYER's that is not its associated one. */
function paymentFrom(account, options = {}) {
  const tx = payment(options);
  tx.transaction.message.accountKeys[1].pubkey = account;
  return tx;
}

const record = (rpc, store, signature, sent, now = LATER) => markRefunded({ rpc, store, now, payTo: PAY_TO, signature, sent });

/** Every ledger key a refund could have written for `payment` and `transfer`. */
async function refundWrites(store, payment, transfer) {
  return {
    spent: await store.get(spentKey(payment)),
    sent: await store.get(refundSentKey(payment)),
    transfer: await store.get(refundTransferKey(transfer)),
  };
}

test("a refund is exactly 1.00 USDC from the payee to the wallet that paid, with no other wallet's USDC moving", () => {
  const ok = transferBack();
  assert.equal(isUsdcRefund(ok, { payTo: PAY_TO, payer: PAYER }), true);
  assert.equal(isUsdcRefund(ok, { payTo: PAY_TO, payer: STRANGER }), false);
  for (const units of [500_000, 999_999, 1_000_001, 2_000_000]) {
    assert.equal(isUsdcRefund(transferBack({ units }), { payTo: PAY_TO, payer: PAYER }), false, String(units));
  }
  // Each side on its own: the payee lost 2.00 while the wallet got 1.00, and the payee lost 1.00
  // while the wallet got 2.00 (tokens burned or minted alongside, so nobody else's balance moved).
  const payeeLostMore = transferBack({ post: [balance(1, 1_000_000, { owner: PAYER }), balance(2, 7_000_000)] });
  const walletGotMore = transferBack({ post: [balance(1, 2_000_000, { owner: PAYER }), balance(2, 8_000_000)] });
  assert.equal(isUsdcRefund(payeeLostMore, { payTo: PAY_TO, payer: PAYER }), false);
  assert.equal(isUsdcRefund(walletGotMore, { payTo: PAY_TO, payer: PAYER }), false);
  // 1.00 out of the payee and 1.00 into the wallet, but a third wallet's USDC moved too.
  const third = newAddress();
  const crowded = transferBack({
    extraKeys: [newAddress()],
    pre: [balance(1, 0, { owner: PAYER }), balance(2, 9_000_000), balance(6, 500_000, { owner: third })],
    post: [balance(1, 1_000_000, { owner: PAYER }), balance(2, 8_000_000), balance(6, 400_000, { owner: third })],
  });
  assert.equal(isUsdcRefund(crowded, { payTo: PAY_TO, payer: PAYER }), false);
  assert.equal(isUsdcRefund(transferBack({ err: { InstructionError: [0, "Custom"] } }), { payTo: PAY_TO, payer: PAYER }), false);
});

test("any USDC the payee sent the wallet after its payment makes it MAYBE_REFUNDED: a look by hand, never 'send' and never 'send nothing'", async () => {
  for (const units of [1_000_000, 500_000, 2_000_000]) {
    const paid = payment({ blockTime: BLOCK_TIME - 600 });
    const back = transferBack({ units });
    const rpc = datedRpc([paid, back]);
    const store = memoryStore();
    const report = await check(rpc, store, sigOf(paid));
    assert.equal(report.verdict, MAYBE_REFUNDED, String(units));
    assert.deepEqual(report.transfersBack, [{ signature: sigOf(back), amount: BigInt(units) }]);
    assert.match(report.why, /Decide by hand/);

    // mark-refunded alone, which tells the operator to send, refuses it.
    const marked = await mark(rpc, store, sigOf(paid));
    assert.equal(marked.marked, false, String(units));
    assert.deepEqual(await refundWrites(store, sigOf(paid), sigOf(back)), { spent: null, sent: null, transfer: null });
    const { code, out } = await runMain(["check", sigOf(paid)], { rpc, store });
    assert.equal(code, 0);
    assert.doesNotMatch(out, /Send exactly|To refund it|Send nothing/);
  }
});

test("USDC sent back before the payment, or to another wallet, is no refund of it: REFUNDABLE", async () => {
  const before = transferBack({ blockTime: BLOCK_TIME - 900 });
  const paid = payment({ blockTime: BLOCK_TIME - 600 });
  // 1.00 from the payee to a stranger, in a transaction that names PAYER's account.
  const elsewhere = transferBack({ to: STRANGER });
  const report = await check(datedRpc([before, paid, elsewhere]), memoryStore(), sigOf(paid));
  assert.equal(report.verdict, REFUNDABLE);
  assert.deepEqual(report.transfersBack, []);
});

test("a refund recorded with --sent belongs to its payment whatever the clocks say, and the wallet's other payment stays owed", async () => {
  // PAYER paid twice, A then B, and used neither. The operator refunds A: mark, send, record.
  const A = payment({ blockTime: BLOCK_TIME - 900 });
  const B = payment({ blockTime: BLOCK_TIME - 800 });
  const store = memoryStore();
  // The operator's clock runs an hour fast: the mark's time is later than the refund's block time.
  const fastClock = LATER + 3_600_000;
  assert.equal((await mark(datedRpc([A, B]), store, sigOf(A), fastClock)).marked, true);
  const R = transferBack({ blockTime: BLOCK_TIME - 100 });
  const rpc = datedRpc([A, B, R]);

  // Sent but not recorded yet: A says which transfer may be its refund, and B is for a look by hand.
  const markedA = await check(rpc, store, sigOf(A));
  assert.equal(markedA.verdict, MARKED);
  assert.deepEqual(markedA.transfersBack.map((t) => t.signature), [sigOf(R)]);
  assert.equal((await check(rpc, store, sigOf(B))).verdict, MAYBE_REFUNDED);

  const recorded = await record(rpc, store, sigOf(A), sigOf(R), fastClock);
  assert.equal(recorded.recorded, sigOf(R));
  assert.equal(recorded.marked, false, "A was marked already");
  assert.deepEqual(await store.get(refundTransferKey(sigOf(R))), { payment: sigOf(A), at: fastClock });
  assert.deepEqual(await store.get(refundSentKey(sigOf(A))), { transfer: sigOf(R), at: fastClock });

  assert.equal((await check(rpc, store, sigOf(A))).verdict, REFUNDED);
  const owed = await check(rpc, store, sigOf(B));
  assert.equal(owed.verdict, REFUNDABLE);
  const listed = await collect(oldPayments({ rpc, store, now: LATER, payTo: PAY_TO, until: PAID_AT, payeeAccount: PAYEE_ATA }));
  assert.deepEqual(listed.map((r) => [r.signature, r.verdict]), [[sigOf(B), REFUNDABLE], [sigOf(A), REFUNDED]]);
});

test("--sent records only a finalized refund of exactly 1.00 to the wallet that paid, landed after the payment, and not another payment's", async () => {
  const P = payment({ blockTime: BLOCK_TIME - 600 });
  const Q = payment({ blockTime: BLOCK_TIME - 500 });
  const store = memoryStore();
  assert.equal((await mark(datedRpc([P, Q]), store, sigOf(P))).marked, true);
  const third = newAddress();
  const wrong = {
    "0.50": transferBack({ units: 500_000 }),
    "2.00": transferBack({ units: 2_000_000 }),
    "to a stranger": transferBack({ to: STRANGER }),
    "a third wallet's USDC moved too": transferBack({
      extraKeys: [newAddress()],
      pre: [balance(1, 0, { owner: PAYER }), balance(2, 9_000_000), balance(6, 500_000, { owner: third })],
      post: [balance(1, 1_000_000, { owner: PAYER }), balance(2, 8_000_000), balance(6, 400_000, { owner: third })],
    }),
    "before the payment": transferBack({ blockTime: BLOCK_TIME - 700 }),
    failed: transferBack({ err: { InstructionError: [0, "Custom"] } }),
  };
  const notFinal = transferBack();
  const good = transferBack();
  const bySlot = (a, b) => (a.tx ?? a).slot - (b.tx ?? b).slot;
  const rpc = datedRpc([...Object.values(wrong), P, Q, { tx: notFinal, status: "confirmed" }, good].sort(bySlot));

  for (const [name, tx] of [...Object.entries(wrong), ["not final", notFinal], ["unknown", { transaction: { signatures: [newSignature()] } }]]) {
    const result = await record(rpc, store, sigOf(P), sigOf(tx));
    assert.equal(result.recorded, null, name);
    assert.match(result.why, /cannot be its refund.*Nothing was written/, name);
    assert.deepEqual(await refundWrites(store, sigOf(P), sigOf(tx)), { spent: { refunded: true, at: LATER, payer: PAYER }, sent: null, transfer: null }, name);
  }
  assert.equal((await record(rpc, store, sigOf(P), sigOf(good))).recorded, sigOf(good));
  assert.equal((await check(rpc, store, sigOf(P))).verdict, REFUNDED);

  // Again with the same transfer: already done. With another: refused.
  const again = await record(rpc, store, sigOf(P), sigOf(good));
  assert.deepEqual([again.already, again.recorded], [true, sigOf(good)]);
  const other = transferBack();
  const twice = await record(datedRpc([P, Q, good, other]), store, sigOf(P), sigOf(other));
  assert.equal(twice.recorded, null);
  assert.match(twice.why, new RegExp(`another transfer, ${sigOf(good)}, is already recorded`));
  // One transfer answers one payment: Q cannot claim P's refund.
  const stolen = await record(datedRpc([P, Q, good]), store, sigOf(Q), sigOf(good));
  assert.equal(stolen.recorded, null);
  assert.match(stolen.why, new RegExp(`already recorded as the refund of ${sigOf(P)}`));
  assert.deepEqual(await refundWrites(store, sigOf(Q), sigOf(good)), { spent: null, sent: null, transfer: { payment: sigOf(P), at: LATER } });
});

test("--sent for a payment refunded by hand marks it and records the transfer; for TOO_RECENT, USED, NOT_A_PAYMENT or UNCLEAR it writes nothing", async () => {
  const P = payment({ blockTime: BLOCK_TIME - 600 });
  const R = transferBack();
  const rpc = datedRpc([P, R]);
  const store = memoryStore();
  assert.equal((await check(rpc, store, sigOf(P))).verdict, MAYBE_REFUNDED);

  const { code, out } = await runMain(["mark-refunded", sigOf(P), "--sent", sigOf(R)], { rpc, store });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`Recorded ${sigOf(R)} as the refund of ${sigOf(P)}, and marked it refunded\\. Send nothing more for it\\.`));
  assert.deepEqual(await refundWrites(store, sigOf(P), sigOf(R)), {
    spent: { refunded: true, at: LATER, payer: PAYER },
    sent: { transfer: sigOf(R), at: LATER },
    transfer: { payment: sigOf(P), at: LATER },
  });
  const again = await runMain(["mark-refunded", sigOf(P), "--sent", sigOf(R)], { rpc, store });
  assert.equal(again.code, 0);
  assert.match(again.out, /already recorded as its refund\. Send nothing\./);

  const refused = {
    [TOO_RECENT]: async () => {
      const tx = payment({ blockTime: BLOCK_TIME });
      return { tx, rpc: datedRpc([tx, transferBack({ blockTime: BLOCK_TIME + 10 })]), store: memoryStore(), now: PAID_AT + 60_000 };
    },
    [USED]: async () => {
      const { claim, reference } = newClaim();
      const tx = payment({ references: [reference], blockTime: BLOCK_TIME - 600 });
      const used = memoryStore();
      await spendForGrind({ claim, signature: sigOf(tx), rpc: datedRpc([tx]), store: used });
      return { tx, rpc: datedRpc([tx, transferBack()]), store: used, now: LATER };
    },
    [NOT_A_PAYMENT]: async () => {
      const tx = payment({ blockTime: BLOCK_TIME - 600, references: [] });
      return { tx, rpc: datedRpc([tx, transferBack()]), store: memoryStore(), now: LATER };
    },
    [UNCLEAR]: async () => {
      const tx = payment({ blockTime: BLOCK_TIME - 600 });
      const odd = memoryStore();
      await odd.create(tx.transaction.message.accountKeys.at(-1).pubkey, { status: "spent" });
      return { tx, rpc: datedRpc([tx, transferBack()]), store: odd, now: LATER };
    },
  };
  for (const [verdict, setup] of Object.entries(refused)) {
    const { tx, rpc: chain, store: ledger, now } = await setup();
    const back = (await chain.getSignaturesForAddress(PAYER_ATA))[0].signature;
    const before = await refundWrites(ledger, sigOf(tx), back);
    const result = await record(chain, ledger, sigOf(tx), back, now);
    assert.equal(result.report.verdict, verdict);
    assert.equal(result.recorded, null, verdict);
    assert.deepEqual(await refundWrites(ledger, sigOf(tx), back), before, verdict);
  }
});

test("a transfer back is looked for in the account that paid and in the wallet's associated account, for each payment on its own", async () => {
  // PAYER_ATA in the fixtures is just a USDC account of PAYER's; its associated account is another.
  const walletAta = payeeUsdcAccount(PAYER);
  assert.notEqual(walletAta, PAYER_ATA);
  const X = newAddress();
  // Paid from X; the refund landed in the wallet's associated account, as a wallet sends it.
  const fromX = paymentFrom(X, { blockTime: BLOCK_TIME - 600 });
  const intoAta = transferBack({ account: walletAta });
  assert.equal((await check(datedRpc([fromX, intoAta]), memoryStore(), sigOf(fromX))).verdict, MAYBE_REFUNDED);

  // Two payments of one wallet from two accounts: the older from X, the newer from the associated
  // account, and USDC sent back to X after both. old-payments reads the newer first, and the older
  // one's own account is still read for it.
  const older = paymentFrom(X, { blockTime: BLOCK_TIME - 600 });
  const newer = payment({ blockTime: BLOCK_TIME - 500 });
  const intoX = transferBack({ account: X });
  const rpc = datedRpc([older, newer, intoX]);
  const listed = await collect(oldPayments({ rpc, store: memoryStore(), now: LATER, payTo: PAY_TO, until: PAID_AT, payeeAccount: PAYEE_ATA }));
  assert.equal(listed.find((r) => r.signature === sigOf(older)).verdict, MAYBE_REFUNDED);
});

test("check reads the wallet's history back to the payment's slot and no further: nothing older is listed or read", async () => {
  const older = Array.from({ length: SIGNATURE_LIMIT + 500 }, () => payment({ blockTime: BLOCK_TIME - 2_000 }));
  const P = payment({ blockTime: BLOCK_TIME - 600 });
  const newer = Array.from({ length: 10 }, () => payment({ blockTime: BLOCK_TIME - 300 }));
  const rpc = datedRpc([...older, P, ...newer]);
  const seen = watched(rpc);
  assert.equal((await check(rpc, memoryStore(), sigOf(P))).verdict, REFUNDABLE);
  // One page of the associated account reaches past the payment, so no second page is asked for.
  assert.deepEqual(seen.of(PAYER_ATA), [undefined]);
  const olderSigs = new Set(older.map(sigOf));
  assert.equal(seen.read.filter((signature) => olderSigs.has(signature)).length, 0);
  assert.equal(new Set(seen.read).size, seen.read.length, "each transaction is read once");
});

test("a transaction of the wallet after the payment that is not final yet, or cannot be read, makes it UNCLEAR, never REFUNDABLE", async () => {
  const P = payment({ blockTime: BLOCK_TIME - 600 });
  const later = transferBack({ to: STRANGER });
  const pending = await check(datedRpc([P, { tx: later, status: "confirmed" }]), memoryStore(), sigOf(P));
  assert.equal(pending.verdict, UNCLEAR);
  assert.match(pending.why, /not final yet.*check again in a minute/);
  const unreadable = await check(datedRpc([P, { tx: later, served: { ...later, meta: { ...later.meta, postTokenBalances: undefined } } }]), memoryStore(), sigOf(P));
  assert.equal(unreadable.verdict, UNCLEAR);
  assert.match(unreadable.why, /cannot be read/);
});

test("the RPC is retried after a timeout, a dropped connection, 429 or a 5xx, and after nothing else", async () => {
  const flaky = (causes) => {
    const calls = [];
    return {
      calls,
      async getTransaction(signature) {
        calls.push(signature);
        const cause = causes[calls.length - 1];
        if (cause) throw new RpcError("getTransaction", cause);
        return { ok: signature };
      },
    };
  };
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);

  const passing = flaky(["timeout", "network", "http 429", "http 503"]);
  assert.deepEqual(await retrying(passing, { sleep, attempts: 5 }).getTransaction("s"), { ok: "s" });
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000]);

  for (const cause of ["bad response", "http 400", "http 401", "rpc error -32602", "not json"]) {
    sleeps.length = 0;
    const lasting = flaky([cause, cause]);
    await assert.rejects(retrying(lasting, { sleep }).getTransaction("s"), new RegExp(cause));
    assert.deepEqual([lasting.calls.length, sleeps.length], [1, 0], cause);
  }
  sleeps.length = 0;
  const down = flaky(Array(10).fill("network"));
  await assert.rejects(retrying(down, { sleep }).getTransaction("s"), /network/);
  assert.deepEqual([down.calls.length, sleeps], [4, [1_000, 2_000, 4_000]]);

  // The command line retries: a 429 on the way does not stop a check.
  const tx = payment({ blockTime: BLOCK_TIME - 600 });
  const rpc = datedRpc([tx]);
  const get = rpc.getTransaction;
  let failures = 2;
  rpc.getTransaction = async (signature) => {
    if (failures-- > 0) throw new RpcError("getTransaction", "http 429");
    return get(signature);
  };
  const lines = [];
  const code = await main(["check", sigOf(tx)], {
    env: ENV,
    now: () => LATER,
    print: (line) => lines.push(line),
    printError: (line) => lines.push(line),
    createRpc: () => rpc,
    getStore: () => blobsLike(memoryStore()),
    sleep: async () => {},
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /Verdict: REFUNDABLE/);
});

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

test("old-payments starts at the first commit with the payment functions unless told otherwise", async () => {
  assert.equal(new Date(LAUNCH_AT).toISOString(), "2026-11-15T14:36:14.000Z");
  const launch = Math.floor(LAUNCH_AT / 1000);
  const beforeLaunch = payment({ blockTime: launch - 60 });
  const afterLaunch = payment({ blockTime: launch + 60 });
  const rpc = datedRpc([beforeLaunch, afterLaunch]);
  const args = { rpc, store: memoryStore(), now: LATER, payTo: PAY_TO, until: PAID_AT, payeeAccount: PAYEE_ATA };
  assert.deepEqual((await collect(oldPayments(args))).map((report) => report.signature), [sigOf(afterLaunch)]);
  const all = await collect(oldPayments({ ...args, since: (launch - 3_600) * 1000 }));
  assert.deepEqual(all.map((report) => report.signature), [sigOf(afterLaunch), sigOf(beforeLaunch)]);
});

// ── SOL payments of the launch versions ───────────────────────────────────────

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * A transaction moving SOL with one top-level SystemProgram transfer, jsonParsed,
 * as the launch versions built a SOL payment: the wallet that pays signs and
 * pays the fee, and the reference is added, read-only, to the transfer.
 * `feePayer` signs too when it is not `from`; `programs` adds top-level
 * instructions of other programs; `extraKeys` adds writable accounts.
 */
function solTx({ from, to = PAY_TO, lamports, references = [], blockTime = BLOCK_TIME, fee = 5_000, err = null, feePayer = from, programs = [], extraKeys = [], inner = [] }) {
  const keys = [
    { pubkey: feePayer, signer: true, writable: true },
    ...(from === feePayer ? [] : [{ pubkey: from, signer: true, writable: true }]),
    { pubkey: to, signer: false, writable: true },
    ...extraKeys.map((pubkey) => ({ pubkey, signer: false, writable: true })),
    ...references.map((pubkey) => ({ pubkey, signer: false, writable: false })),
    ...[SYSTEM, ...programs].map((pubkey) => ({ pubkey, signer: false, writable: false })),
  ];
  const pre = keys.map(() => 10_000_000_000);
  const post = keys.map((key, i) => pre[i] - (i === 0 ? fee : 0) - (key.pubkey === from ? lamports : 0) + (key.pubkey === to ? lamports : 0));
  return {
    slot: slotAt(blockTime),
    blockTime,
    meta: { err, fee, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [], innerInstructions: inner },
    transaction: {
      signatures: [newSignature()],
      message: {
        accountKeys: keys.map((key) => ({ ...key, source: "transaction" })),
        instructions: [
          ...programs.map((programId) => ({ programId, accounts: [], data: "" })),
          { programId: SYSTEM, program: "system", parsed: { type: "transfer", info: { source: from, destination: to, lamports } } },
        ],
      },
    },
  };
}

test("old-sol-payments lists the launch versions' SOL payments nothing used, with the wallet and the exact SOL to send back", async () => {
  const store = memoryStore();
  const t = (offset) => BLOCK_TIME - 3_600 + offset;
  const usedRef = newAddress();
  const used = solTx({ from: PAYER, lamports: 7_000_000, references: [usedRef], blockTime: t(1) });
  await store.create(usedRef, { status: "consumed", asset: "sol", signature: sigOf(used), at: 1 });
  const paidRef = newAddress();
  const paid = solTx({ from: PAYER, lamports: 6_500_000, references: [paidRef], blockTime: t(2) });
  await store.create(paidRef, { status: "paid", asset: "sol", signature: sigOf(paid), at: 1 });
  const other = newAddress();
  const neverVerified = solTx({ from: other, lamports: 6_400_000, references: [newAddress()], blockTime: t(3) });
  const tip = solTx({ from: other, lamports: 6_400_000, blockTime: t(4) });
  const handRefund = solTx({ from: PAY_TO, to: other, lamports: 6_400_000, blockTime: t(5) });
  const failed = solTx({ from: newAddress(), lamports: 6_300_000, references: [newAddress()], blockTime: t(6), err: { InstructionError: [0, "Custom"] } });
  const afterUntil = solTx({ from: newAddress(), lamports: 6_000_000, references: [newAddress()], blockTime: BLOCK_TIME + 10 });
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
  assert.match(out, new RegExp(`\n${sigOf(paid)}  ${new Date(t(2) * 1000).toISOString()}  ${PAYER}  0\\.006500000  paid  ${REFUNDABLE}\n  send 0\\.006500000 SOL back`));
  assert.match(out, /Listed 2\. Not listed: 1 used for a grind\./);
  assert.ok(!out.includes(sigOf(tip)) && !out.includes(sigOf(afterUntil)) && !out.includes(sigOf(failed)), out);
});

test("old-sol-payments lists nothing the payee signed (a swap, an unstake) and no SOL that came other than by a top-level transfer", async () => {
  const vault = newAddress();
  const wsolAccount = newAddress();
  const router = newAddress();
  const amm = newAddress();
  const poolConfig = newAddress();
  // The payee sells USDC for SOL through a router: it signs, a pool vault pays it 0.25 SOL exactly.
  const swapKeys = [
    { pubkey: PAY_TO, signer: true, writable: true },
    { pubkey: wsolAccount, signer: false, writable: true },
    { pubkey: vault, signer: false, writable: true },
    { pubkey: poolConfig, signer: false, writable: false },
    { pubkey: OTHER_MINT, signer: false, writable: false },
    { pubkey: amm, signer: false, writable: false },
    { pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", signer: false, writable: false },
    { pubkey: router, signer: false, writable: false },
  ];
  const swap = {
    slot: slotAt(BLOCK_TIME - 500),
    blockTime: BLOCK_TIME - 500,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000, 0, 900_000_000_000, 1, 1, 1, 1, 1],
      postBalances: [1_000_000_000 + 250_000_000 - 5_000, 0, 900_000_000_000 - 250_000_000, 1, 1, 1, 1, 1],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [{ index: 0, instructions: [{ programId: amm }] }],
    },
    transaction: { signatures: [newSignature()], message: { accountKeys: swapKeys, instructions: [{ programId: router, accounts: [], data: "" }] } },
  };
  // Someone else's transaction in which a program pays the payee from a vault, with no transfer of its own.
  const claimed = solTx({ from: newAddress(), lamports: 6_000_000, references: [poolConfig], blockTime: BLOCK_TIME - 400 });
  claimed.transaction.message.instructions = [{ programId: amm, accounts: [], data: "" }];
  // The payee moving its own SOL, and a tip naming no reference.
  const own = solTx({ from: PAY_TO, to: newAddress(), lamports: 6_000_000, blockTime: BLOCK_TIME - 300 });
  const tip = solTx({ from: newAddress(), lamports: 6_000_000, blockTime: BLOCK_TIME - 200 });
  const rpc = datedRpc([swap, claimed, own, tip]);

  assert.deepEqual(await collect(oldSolPayments({ rpc, store: memoryStore(), now: LATER, payTo: PAY_TO })), []);
  // Signed by the payee: never a payment, even with the shape of one.
  assert.equal(solPayment(swap, { payTo: PAY_TO }), null);
  const selfShaped = solTx({ from: newAddress(), lamports: 6_000_000, references: [newAddress()] });
  selfShaped.transaction.message.accountKeys[1].signer = true;
  assert.equal(solPayment(selfShaped, { payTo: PAY_TO }), null);
  assert.notEqual(solPayment(solTx({ from: newAddress(), lamports: 6_000_000, references: [newAddress()] }), { payTo: PAY_TO }), null);
  const { code, out } = await runMain(["old-sol-payments"], { rpc, now: LATER });
  assert.equal(code, 0, out);
  assert.match(out, /Listed 0\./);
  assert.ok(!out.includes(vault), out);
});

test("SOL paid to the payee in anything but the launch shape is UNCLASSIFIED, for a look by hand: the tool never says to send for it", async () => {
  const ref = () => [newAddress()];
  // Each case, and the one rule that says why: the reason is what the operator reads.
  const cases = {
    "another program beside the transfer": [solTx({ from: newAddress(), lamports: 6_000_000, references: ref(), programs: [MEMO] }), new RegExp(`runs more than a transfer: ${MEMO}`)],
    "inner instructions": [solTx({ from: newAddress(), lamports: 6_000_000, references: ref(), inner: [{ index: 0, instructions: [{ programId: SYSTEM }] }] }), /calls other programs/],
    "paid by a wallet that did not pay the fee": [solTx({ from: newAddress(), feePayer: newAddress(), lamports: 6_000_000, references: ref() }), /did not come from the wallet that signed it and paid its fee/],
    "two possible references": [solTx({ from: newAddress(), lamports: 6_000_000, references: [newAddress(), newAddress()] }), /names 2 accounts that could be its reference/],
    "an account the launch never added": [solTx({ from: newAddress(), lamports: 6_000_000, references: ref(), extraKeys: [newAddress()] }), /accounts the launch versions never added/],
    "0.25 SOL": [solTx({ from: newAddress(), lamports: 250_000_000, references: ref() }), /0\.250000000 SOL is not about \$1/],
    "just over the most": [solTx({ from: newAddress(), lamports: LAUNCH_SOL_LAMPORTS.max + 1, references: ref() }), /is not about \$1/],
    "just under the least": [solTx({ from: newAddress(), lamports: LAUNCH_SOL_LAMPORTS.min - 1, references: ref() }), /is not about \$1/],
  };
  // 6_000_000 lamports moved, paid in two transfers of half each.
  const twoTransfers = solTx({ from: newAddress(), lamports: 6_000_000, references: ref() });
  const [transfer] = twoTransfers.transaction.message.instructions;
  transfer.parsed.info.lamports = 3_000_000;
  twoTransfers.transaction.message.instructions.push(structuredClone(transfer));
  cases["two transfers"] = [twoTransfers, /more than one transfer/];
  const moved = solTx({ from: newAddress(), lamports: 6_000_000, references: ref() });
  moved.meta.postBalances[1] += 1;
  cases["SOL moved other than by the transfer"] = [moved, /SOL moved other than by the transfer/];
  // ComputeBudget beside the transfer is what a wallet adds: still the launch shape.
  const budgeted = solTx({ from: newAddress(), lamports: 6_000_000, references: ref(), programs: [COMPUTE_BUDGET] });
  const rpc = datedRpc([...Object.values(cases).map(([tx]) => tx), budgeted]);

  const found = await collect(oldSolPayments({ rpc, store: memoryStore(), now: LATER, payTo: PAY_TO }));
  const bySignature = new Map(found.map((r) => [r.signature, r]));
  for (const [name, [tx, why]] of Object.entries(cases)) {
    assert.equal(bySignature.get(sigOf(tx))?.verdict, UNCLASSIFIED, name);
    assert.match(bySignature.get(sigOf(tx)).why, why, name);
  }
  assert.equal(bySignature.get(sigOf(budgeted)).verdict, REFUNDABLE);
  assert.equal(found.length, Object.keys(cases).length + 1);

  const { out } = await runMain(["old-sol-payments"], { rpc, now: LATER });
  for (const [tx] of Object.values(cases)) {
    const line = out.split("\n").findIndex((l) => l.startsWith(sigOf(tx)));
    assert.match(out.split("\n")[line + 1], /look by hand, and send nothing on this tool's word/);
  }
  assert.equal(out.match(/SOL back to the wallet that paid/g)?.length, 1);
});

test("SOL that went back: SENT_BACK only for a wallet's only payment and exactly its lamports, once, after it; anything else is MAYBE_REFUNDED", async () => {
  const store = memoryStore();
  const t = (offset) => BLOCK_TIME - 3_600 + offset;
  const wallets = Array.from({ length: 6 }, newAddress);
  const pay = (from, lamports, offset) => solTx({ from, lamports, references: [newAddress()], blockTime: t(offset) });
  const back = (to, lamports, offset) => solTx({ from: PAY_TO, to, lamports, blockTime: t(offset) });
  const [exact, otherAmount, early, consumedFirst, twice, two] = wallets;
  const entries = [];
  const add = (tx) => (entries.push(tx), tx);

  const p1 = add(pay(exact, 6_400_000, 1));
  add(back(exact, 6_400_000, 2));
  const p2 = add(pay(otherAmount, 6_400_000, 3));
  add(back(otherAmount, 6_300_000, 4));
  add(back(early, 6_400_000, 5));
  const p3 = add(pay(early, 6_400_000, 6));
  const usedRef = newAddress();
  const consumed = add(solTx({ from: consumedFirst, lamports: 6_400_000, references: [usedRef], blockTime: t(7) }));
  await store.create(usedRef, { status: "consumed", asset: "sol", signature: sigOf(consumed), at: 1 });
  const p4 = add(pay(consumedFirst, 6_400_000, 8));
  add(back(consumedFirst, 6_400_000, 9));
  const p5 = add(pay(twice, 6_400_000, 10));
  add(back(twice, 6_400_000, 11));
  add(back(twice, 6_400_000, 12));
  const p6 = add(pay(two, 6_400_000, 13));
  const p7 = add(pay(two, 6_600_000, 14));
  add(back(two, 6_400_000, 15));

  const found = await collect(oldSolPayments({ rpc: datedRpc(entries), store, now: LATER, payTo: PAY_TO }));
  const verdict = (tx) => found.find((r) => r.signature === sigOf(tx)).verdict;
  assert.equal(verdict(p1), SENT_BACK);
  assert.equal(verdict(p2), MAYBE_REFUNDED, "a different amount went back");
  assert.equal(verdict(p3), REFUNDABLE, "the SOL went back before the payment");
  assert.equal(verdict(consumed), USED);
  assert.equal(verdict(p4), MAYBE_REFUNDED, "the wallet also made a payment that was used");
  assert.equal(verdict(p5), MAYBE_REFUNDED, "two transfers went back");
  assert.equal(verdict(p6), MAYBE_REFUNDED, "two payments, one transfer back");
  assert.equal(verdict(p7), MAYBE_REFUNDED, "two payments, one transfer back");
});

test("what went back is read from the whole history: --since and --until choose only what is listed", async () => {
  const t = (offset) => BLOCK_TIME - 3_600 + offset;
  const W = newAddress();
  const V = newAddress();
  const p0 = solTx({ from: W, lamports: 6_400_000, references: [newAddress()], blockTime: t(10) });
  const p1 = solTx({ from: W, lamports: 6_400_000, references: [newAddress()], blockTime: t(20) });
  const q = solTx({ from: V, lamports: 6_100_000, references: [newAddress()], blockTime: t(25) });
  const r = solTx({ from: PAY_TO, to: W, lamports: 6_400_000, blockTime: t(30) });
  const s = solTx({ from: PAY_TO, to: V, lamports: 6_100_000, blockTime: t(40) });
  const rpc = datedRpc([p0, p1, q, r, s]);
  const run = async (window) => Object.fromEntries((await collect(oldSolPayments({ rpc, store: memoryStore(), now: LATER, payTo: PAY_TO, ...window }))).map((x) => [x.signature, x.verdict]));

  const all = await run({});
  assert.deepEqual(all, { [sigOf(p0)]: MAYBE_REFUNDED, [sigOf(p1)]: MAYBE_REFUNDED, [sigOf(q)]: SENT_BACK });
  // From between p0 and p1: p0 is not listed, and p1 still counts it.
  assert.deepEqual(await run({ since: t(15) * 1000 }), { [sigOf(p1)]: MAYBE_REFUNDED, [sigOf(q)]: SENT_BACK });
  // Until before the transfers back: they are still read.
  assert.deepEqual(await run({ until: t(26) * 1000 }), all);
  assert.deepEqual(await run({ until: t(15) * 1000 }), { [sigOf(p0)]: MAYBE_REFUNDED });
});
