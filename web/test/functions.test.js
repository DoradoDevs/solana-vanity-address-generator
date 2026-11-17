// The four functions, called the way Netlify calls them, against a mock RPC
// node over HTTP and Netlify's own local Blobs server. The real Blobs client
// and the real RPC client run; only the far ends are local.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../../shared/payment.js";
import consume, { config as consumeConfig } from "../netlify/functions/consume.mjs";
import prepare, { config as prepareConfig } from "../netlify/functions/prepare.mjs";
import quote, { config as quoteConfig } from "../netlify/functions/quote.mjs";
import verify, { config as verifyConfig } from "../netlify/functions/verify.mjs";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import { PAY_TO, USDC_MINT } from "../netlify/functions/lib/constants.js";
import { checkPreparedTransfer } from "../src/transfer-check.js";
import { blobStore, spentKey } from "../netlify/functions/lib/store.js";
import { NETWORK_FEE_NOTE } from "../../shared/pay-copy.js";
import { PAYER, balance, newClaim, newSignature } from "./helpers/chain.js";
import { ataOf, post, startBlobs, startRpc } from "./helpers/servers.js";

const SECRET = "integration-unlock-secret-0123456789";
let rpc;
let blobs;
let logs;
const realLog = console.log;

before(async () => {
  rpc = await startRpc();
  blobs = await startBlobs();
  console.log = (...parts) => logs.push(parts.join(" "));
});

after(async () => {
  console.log = realLog;
  await rpc.stop();
  await blobs.stop();
});

beforeEach(() => {
  logs = [];
  rpc.mode = "ok";
  rpc.txs.length = 0;
  rpc.lamports.clear();
  rpc.usdc.clear();
  rpc.lamports.set(PAYER, 50_000_000);
  rpc.usdc.set(PAYER, 5_000_000n);
  rpc.usdc.set(PAY_TO, 7_000_000n);
  rpc.resetCalls();
  blobs.connect();
  process.env.SOLANA_RPC_URL = rpc.url;
  process.env.UNLOCK_SECRET = SECRET;
  delete process.env.PAY_TO_ADDRESS;
});

const read = async (response) => ({ status: response.status, body: await response.json(), headers: response.headers });

/** Nothing a caller or a log reader sees may contain any part of the RPC URL. */
function assertNoRpcUrl(...texts) {
  const { host, pathname, search } = new URL(rpc.url);
  for (const text of [...texts, ...logs]) {
    const value = typeof text === "string" ? text : JSON.stringify(text);
    for (const secret of [host, pathname, search, "RPC-PATH-KEY", "RPC-QUERY-KEY", "api-key"]) {
      assert.equal(value.includes(secret), false, `leaked "${secret}" in: ${value}`);
    }
  }
}

/** Put the transaction that prepare built on the mock chain, as the wallet would by sending it. */
function land(transactionBase64, status = "finalized") {
  const tx = Transaction.from(Buffer.from(transactionBase64, "base64"));
  const keys = tx.compileMessage().accountKeys.map((key) => key.toBase58());
  const transfer = tx.instructions.find((ix) => ix.programId.toBase58() === TOKEN_PROGRAM_ID);
  const amount = Buffer.from(transfer.data).readBigUInt64LE(1);
  const [source, , destination, payer] = transfer.keys.map((key) => key.pubkey.toBase58());
  const payee = tx.instructions[0].keys[2].pubkey.toBase58();
  const payerHas = rpc.usdc.get(payer);
  const payeeHas = rpc.usdc.get(payee);
  const entry = {
    status,
    tx: {
      slot: 1,
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        fee: 5000,
        preTokenBalances: [
          balance(keys.indexOf(source), payerHas, { owner: payer }),
          ...(payeeHas === undefined ? [] : [balance(keys.indexOf(destination), payeeHas, { owner: payee })]),
        ],
        postTokenBalances: [
          balance(keys.indexOf(source), payerHas - amount, { owner: payer }),
          balance(keys.indexOf(destination), (payeeHas ?? 0n) + amount, { owner: payee }),
        ],
      },
      transaction: {
        signatures: [newSignature()],
        message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })) },
      },
    },
  };
  rpc.usdc.set(payer, payerHas - amount);
  rpc.usdc.set(payee, (payeeHas ?? 0n) + amount);
  rpc.txs.push(entry);
  return entry;
}

async function preparePayment(claim = newClaim().claim) {
  const prepared = await read(await prepare(post("/api/prepare", { payer: PAYER, claim })));
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  return { claim, transaction: prepared.body.transaction };
}

// ── Routing and limits ───────────────────────────────────────────────────────

test("every function has its own /api path, and the two that spend RPC calls are rate limited per visitor", () => {
  assert.equal(quoteConfig.path, "/api/quote");
  assert.equal(prepareConfig.path, "/api/prepare");
  assert.equal(verifyConfig.path, "/api/verify");
  assert.equal(consumeConfig.path, "/api/consume");
  for (const config of [prepareConfig, verifyConfig]) {
    assert.deepEqual(config.rateLimit.aggregateBy, ["ip", "domain"]);
    assert.ok(config.rateLimit.windowLimit > 0 && config.rateLimit.windowLimit <= 60);
    assert.ok(config.rateLimit.windowSize > 0 && config.rateLimit.windowSize <= 180);
  }
  // The free plan allows two code-based rules per project.
  const limited = [quoteConfig, prepareConfig, verifyConfig, consumeConfig].filter((config) => config.rateLimit);
  assert.equal(limited.length, 2);
});

test("quote states the fixed price without touching the chain", async () => {
  const { status, body, headers } = await read(await quote());
  assert.equal(status, 200);
  assert.deepEqual(body.usdc, { mint: USDC_MINT, amount: "1.00", baseUnits: "1000000" });
  assert.equal(body.payTo, PAY_TO);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(rpc.totalCalls(), 0);
});

// ── prepare ──────────────────────────────────────────────────────────────────

test("prepare builds a 1.00 USDC transfer to the payee that names the claim's reference", async () => {
  const { claim, reference } = newClaim();
  const { status, body } = await read(await prepare(post("/api/prepare", { payer: PAYER, claim })));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["amount", "payTo", "transaction", "usdcMint"]);

  const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
  assert.equal(tx.feePayer.toBase58(), PAYER);
  assert.equal(tx.signatures.every((s) => s.signature === null), true);
  assert.equal(tx.instructions.length, 2);
  const [createAta, transfer] = tx.instructions;
  assert.equal(createAta.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID);
  assert.equal(Buffer.from(createAta.data)[0], 1); // CreateIdempotent
  assert.equal(transfer.programId.toBase58(), TOKEN_PROGRAM_ID);
  const data = Buffer.from(transfer.data);
  assert.equal(data[0], 12); // TransferChecked
  assert.equal(data.readBigUInt64LE(1), 1_000_000n);
  assert.equal(data[9], 6);
  const keys = transfer.keys.map((key) => ({ ...key, pubkey: key.pubkey.toBase58() }));
  assert.deepEqual(
    keys.map((key) => key.pubkey),
    [ataOf(PAYER), USDC_MINT, ataOf(PAY_TO), PAYER, reference]
  );
  assert.deepEqual(keys[4], { pubkey: reference, isSigner: false, isWritable: false });
  assert.equal(keys.filter((key) => key.isSigner).length, 1);

  // Two RPC requests, no more: this is what an anonymous caller can make us spend.
  assert.deepEqual(rpc.calls, { getMultipleAccounts: 1, getLatestBlockhash: 1 });
  assertNoRpcUrl(body);
});

test("prepare refuses a wallet that cannot pay, with a reason the page can explain", async () => {
  rpc.usdc.set(PAYER, 999_999n);
  let result = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
  assert.equal(result.status, 402);
  assert.equal(result.body.reason, "insufficient_usdc");
  assert.ok(result.body.error.includes(NETWORK_FEE_NOTE));
  assert.equal(result.body.transaction, undefined);

  rpc.usdc.set(PAYER, 1_000_000n);
  rpc.lamports.set(PAYER, 4_999);
  result = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
  assert.equal(result.status, 402);
  assert.equal(result.body.reason, "insufficient_sol");

  // A wallet that has never held SOL or USDC does not exist on chain at all.
  rpc.lamports.delete(PAYER);
  rpc.usdc.delete(PAYER);
  result = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
  assert.equal(result.status, 402);
  assert.equal(result.body.reason, "insufficient_usdc");
});

test("before the payee's USDC account exists, the payer needs its rent as well as the fee", async () => {
  rpc.usdc.delete(PAY_TO);
  rpc.lamports.set(PAYER, 5_000 + 2_039_280 - 1);
  let result = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
  assert.equal(result.status, 402);
  assert.equal(result.body.reason, "insufficient_sol");
  assert.equal(rpc.calls.getMinimumBalanceForRentExemption, 1);

  rpc.lamports.set(PAYER, 5_000 + 2_039_280);
  result = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
  assert.equal(result.status, 200);
});

test("the payee cannot pay itself: prepare says to use another wallet, before any RPC call", async () => {
  // A transfer from the payee's USDC account to itself moves nothing, so it could never verify.
  rpc.lamports.set(PAY_TO, 50_000_000);
  const { status, body } = await read(await prepare(post("/api/prepare", { payer: PAY_TO, claim: newClaim().claim })));
  assert.equal(status, 400);
  assert.equal(body.reason, "payee");
  assert.match(body.error, /another wallet/);
  assert.equal(body.transaction, undefined);
  assert.equal(rpc.totalCalls(), 0);
});

test("prepare rejects malformed requests without spending an RPC call", async () => {
  const claim = newClaim().claim;
  const requests = [
    post("/api/prepare", { payer: PAYER }),
    post("/api/prepare", { claim }),
    post("/api/prepare", { payer: "not-an-address", claim }),
    post("/api/prepare", { payer: PAYER, claim: "short" }),
    post("/api/prepare", { payer: PAYER, reference: newClaim().reference }), // what the page sent before this change
    post("/api/prepare", [PAYER, claim]),
    post("/api/prepare", "{ not json"),
    post("/api/prepare", { payer: PAYER, claim, padding: "x".repeat(5000) }),
    // A cross-site form or text post carries no JSON content type.
    post("/api/prepare", { payer: PAYER, claim }, { "content-type": "text/plain" }),
    post("/api/prepare", { payer: PAYER, claim }, {}),
  ];
  for (const request of requests) {
    const { status, body } = await read(await prepare(request));
    assert.equal(status, 400);
    assert.equal(body.transaction, undefined);
  }
  const get = await prepare(new Request("https://vanitygrinder.com/api/prepare"));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal(rpc.totalCalls(), 0);
});

test("when the RPC node fails, prepare says so and never echoes the RPC URL", async () => {
  for (const mode of ["http500", "rpcError", "garbage"]) {
    rpc.mode = mode;
    const { status, body } = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
    assert.equal(status, 503, mode);
    assert.equal(body.transaction, undefined);
    assertNoRpcUrl(body);
  }
  assert.ok(logs.some((line) => line.startsWith("prepare failure ")));
});

test("with no RPC URL, prepare is a 500 and nothing else", async () => {
  delete process.env.SOLANA_RPC_URL;
  const result = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
  assert.equal(result.status, 500);
  assert.equal(result.body.transaction, undefined);
  assert.equal(rpc.totalCalls(), 0);
  assertNoRpcUrl(result.body);
});

test("a PAY_TO_ADDRESS other than the pinned payee closes quote, prepare and verify", async () => {
  const { claim, transaction } = await preparePayment();
  land(transaction);
  rpc.resetCalls();
  // A tampered or mistyped environment cannot send payments, or the page, anywhere else.
  for (const value of [PAYER, "not-an-address", `${PAY_TO}x`]) {
    process.env.PAY_TO_ADDRESS = value;
    const q = await read(await quote());
    assert.equal(q.status, 503, value);
    assert.equal(q.body.payTo, undefined);
    const p = await read(await prepare(post("/api/prepare", { payer: PAYER, claim: newClaim().claim })));
    assert.equal(p.status, 503, value);
    assert.equal(p.body.transaction, undefined);
    const v = await read(await verify(post("/api/verify", { claim })));
    assert.equal(v.status, 503, value);
    assert.equal(v.body.reason, "config");
    assert.equal(v.body.token, undefined);
  }
  assert.equal(rpc.totalCalls(), 0);

  // Set to the pinned payee itself, stray whitespace and all, everything works.
  process.env.PAY_TO_ADDRESS = ` ${PAY_TO}\n`;
  assert.equal((await read(await quote())).body.payTo, PAY_TO);
  assert.equal((await read(await verify(post("/api/verify", { claim })))).status, 200);
});

test("the transfer prepare returns passes the page's own check, so the page and the functions agree", async () => {
  for (const payeeAccountExists of [true, false]) {
    if (!payeeAccountExists) rpc.usdc.delete(PAY_TO);
    rpc.lamports.set(PAYER, 50_000_000);
    const { claim, transaction } = await preparePayment();
    const bytes = new Uint8Array(Buffer.from(transaction, "base64"));
    assert.equal(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), null);
    // And not for another wallet or another attempt.
    assert.notEqual(await checkPreparedTransfer(bytes, { payer: newClaim().reference, claim }), null);
    assert.notEqual(await checkPreparedTransfer(bytes, { payer: PAYER, claim: newClaim().claim }), null);
  }
});

// ── prepare → pay → verify → consume ─────────────────────────────────────────

test("a payment goes from unseen to pending to paid, unlocks once, and is then spent for good", async () => {
  const { claim, transaction } = await preparePayment();
  const check = async () => read(await verify(post("/api/verify", { claim })));

  // The wallet has the transaction; the chain has not shown it yet.
  let result = await check();
  assert.equal(result.status, 202);
  assert.equal(result.body.reason, "not_found");
  assert.equal(result.body.token, undefined);

  const entry = land(transaction, "confirmed");
  result = await check();
  assert.equal(result.status, 202);
  assert.equal(result.body.reason, "pending");
  assert.equal(result.body.token, undefined);

  entry.status = "finalized";
  const first = await check();
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.ok(first.body.token);
  const second = await check();
  assert.equal(second.status, 200);
  assert.notEqual(second.body.token, first.body.token);

  const spent = await read(await consume(post("/api/consume", { token: first.body.token })));
  assert.equal(spent.status, 200);
  assert.equal(spent.body.ok, true);
  // The ledger record went through the real Blobs client, keyed by the transaction.
  const record = await blobStore().get(spentKey(entry.tx.transaction.signatures[0]));
  assert.equal(typeof record.at, "number");

  const replay = await read(await consume(post("/api/consume", { token: first.body.token })));
  assert.equal(replay.status, 200);
  const otherToken = await read(await consume(post("/api/consume", { token: second.body.token })));
  assert.equal(otherToken.status, 409);
  assert.equal(otherToken.body.reason, "reused");

  result = await check();
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, "reused");
  assert.equal(result.body.token, undefined);
  assertNoRpcUrl(first.body, spent.body, result.body);
  assert.equal(logs.some((line) => line.includes(claim) || line.includes(first.body.token)), false);
});

test("with the signature the wallet returned, verify reads that transaction and not the reference's history", async () => {
  const { claim, transaction } = await preparePayment();
  const entry = land(transaction, "confirmed");
  const signature = entry.tx.transaction.signatures[0];
  const check = async (body = { claim, signature }) => read(await verify(post("/api/verify", body)));

  let result = await check();
  assert.equal(result.status, 202);
  assert.equal(result.body.reason, "pending");

  entry.status = "finalized";
  rpc.resetCalls();
  result = await check();
  assert.equal(result.status, 200);
  assert.ok(result.body.token);
  assert.deepEqual(rpc.calls, { getSignatureStatuses: 1, getTransaction: 1 });

  rpc.resetCalls();
  const malformed = await check({ claim, signature: "not-a-signature" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.reason, "invalid");
  assert.equal(rpc.totalCalls(), 0);
});

test("a stranger who reads the payment off the chain cannot verify it", async () => {
  const { claim, transaction } = await preparePayment();
  const entry = land(transaction);
  const publicFacts = [
    referenceForClaim(claim),
    entry.tx.transaction.signatures[0],
    ...entry.tx.transaction.message.accountKeys.map((key) => key.pubkey),
  ];
  for (const guess of publicFacts) {
    const { status, body } = await read(await verify(post("/api/verify", { claim: guess })));
    assert.notEqual(status, 200, guess);
    assert.equal(body.token, undefined);
  }
  // The legacy request shape, a bare reference, is not accepted either.
  const legacy = await read(await verify(post("/api/verify", { reference: referenceForClaim(claim) })));
  assert.equal(legacy.status, 400);
  assert.equal((await read(await verify(post("/api/verify", { claim })))).status, 200);
});

test("verify and consume ignore posts that are not JSON, before any RPC or ledger work", async () => {
  const { claim, transaction } = await preparePayment();
  land(transaction);
  rpc.resetCalls();
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, {}]) {
    const v = await read(await verify(post("/api/verify", { claim }, headers)));
    assert.equal(v.status, 400);
    assert.equal(v.body.token, undefined);
    const c = await read(await consume(post("/api/consume", { token: "x.y" }, headers)));
    assert.equal(c.status, 400);
  }
  assert.equal((await verify(new Request("https://vanitygrinder.com/api/verify"))).status, 405);
  assert.equal((await consume(new Request("https://vanitygrinder.com/api/consume"))).status, 405);
  assert.equal(rpc.totalCalls(), 0);
});

test("an unset or short UNLOCK_SECRET closes verify and consume instead of weakening them", async () => {
  const { claim, transaction } = await preparePayment();
  land(transaction);
  const good = await read(await verify(post("/api/verify", { claim })));
  assert.equal(good.status, 200);

  for (const secret of [undefined, "", "fifteen-chars-x"]) {
    if (secret === undefined) delete process.env.UNLOCK_SECRET;
    else process.env.UNLOCK_SECRET = secret;
    rpc.resetCalls();
    const v = await read(await verify(post("/api/verify", { claim })));
    assert.equal(v.status, 500);
    assert.equal(v.body.reason, "config");
    assert.equal(v.body.token, undefined);
    const c = await read(await consume(post("/api/consume", { token: good.body.token })));
    assert.equal(c.status, 500);
    assert.equal(c.body.ok, false);
    assert.equal(rpc.totalCalls(), 0);
  }
  // Sixteen characters is the floor, and a token signed with one secret is void under another.
  process.env.UNLOCK_SECRET = "sixteen-chars-xx";
  const other = await read(await verify(post("/api/verify", { claim })));
  assert.equal(other.status, 200);
  process.env.UNLOCK_SECRET = SECRET;
  const crossed = await read(await consume(post("/api/consume", { token: other.body.token })));
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.reason, "bad");
});

test("when the RPC node fails, verify grants nothing, says try again, and leaks nothing", async () => {
  const { claim, transaction } = await preparePayment();
  land(transaction);
  for (const mode of ["http500", "rpcError", "garbage"]) {
    rpc.mode = mode;
    const { status, body } = await read(await verify(post("/api/verify", { claim })));
    assert.equal(status, 503, mode);
    assert.equal(body.reason, "unavailable");
    assert.equal(body.token, undefined);
    assertNoRpcUrl(body);
  }
  assert.ok(logs.some((line) => line.startsWith("verify failure getSignaturesForAddress: ")));
  rpc.mode = "ok";
  assert.equal((await read(await verify(post("/api/verify", { claim })))).status, 200);
});

test("with no ledger there is no unlock: verify and consume answer 503 and spend nothing", async () => {
  const { claim, transaction } = await preparePayment();
  land(transaction);
  const good = await read(await verify(post("/api/verify", { claim })));
  blobs.disconnect();
  const v = await read(await verify(post("/api/verify", { claim })));
  assert.equal(v.status, 503);
  assert.equal(v.body.token, undefined);
  const c = await read(await consume(post("/api/consume", { token: good.body.token })));
  assert.equal(c.status, 503);
  assert.equal(c.body.ok, false);
  blobs.connect();
  assert.equal((await read(await consume(post("/api/consume", { token: good.body.token })))).status, 200);
});
