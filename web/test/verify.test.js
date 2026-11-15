import assert from "node:assert/strict";
import { test } from "node:test";
import { Transaction } from "@solana/web3.js";
import { DEFAULT_PAY_TO, USDC_MINT } from "../netlify/functions/lib/constants.js";
import { memoryStore } from "../netlify/functions/lib/store.js";
import { readUnlockToken } from "../netlify/functions/lib/token.js";
import { buildUnsignedTransaction } from "../netlify/functions/lib/tx.js";
import { consumeUnlock, verifyPayment } from "../netlify/functions/lib/verify.js";

const PAY_TO = DEFAULT_PAY_TO;
const PAYER = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";
const REFERENCE = "11111111111111111111111111111111";
const WRONG_MINT = "So11111111111111111111111111111111111111112";
const SECRET = "test-unlock-secret-value";
const PRICE = 100;

function rpcReturning(tx, confirmationStatus = "finalized") {
  return {
    async getSignaturesForAddress() {
      return [{ signature: "sig-test", confirmationStatus, err: null }];
    },
    async getTransaction() {
      return tx;
    },
  };
}

function solTx(received) {
  return {
    meta: {
      err: null,
      preBalances: [2_000_000_000, 0, 0],
      postBalances: [2_000_000_000 - received - 5000, received, 0],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: PAYER, signer: true, writable: true },
          { pubkey: PAY_TO, signer: false, writable: true },
          { pubkey: REFERENCE, signer: false, writable: false },
        ],
      },
    },
  };
}

function tokenTx(mint, amount) {
  return {
    meta: {
      err: null,
      preBalances: [1, 0, 0],
      postBalances: [1, 0, 0],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint,
          owner: PAY_TO,
          uiTokenAmount: { amount: String(amount), decimals: 6 },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: PAYER },
          { pubkey: "AtaAccount11111111111111111111111111111111" },
          { pubkey: REFERENCE },
        ],
      },
    },
  };
}

function paymentArgs(overrides) {
  return {
    reference: REFERENCE,
    rpc: rpcReturning(solTx(10_000_000)),
    store: memoryStore(),
    payTo: PAY_TO,
    secret: SECRET,
    priceUsd: PRICE,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

test("verify accepts an exact 1.00 USDC payment and returns an unlock token", async () => {
  const store = memoryStore();
  const result = await verifyPayment(
    paymentArgs({
      asset: "usdc",
      store,
      rpc: rpcReturning(tokenTx(USDC_MINT, 1_000_000)),
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  const parsed = readUnlockToken(result.token, SECRET, result.expiresAt - 1000);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ref, REFERENCE);
  assert.equal((await store.get(REFERENCE)).status, "paid");
});

test("verify rejects a SOL payment below the priced amount", async () => {
  const result = await verifyPayment(
    paymentArgs({
      asset: "sol",
      rpc: rpcReturning(solTx(1_000_000)),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_amount");
  assert.equal(result.status, 400);
});

test("verify rejects a token payment that is not USDC", async () => {
  const result = await verifyPayment(
    paymentArgs({
      asset: "usdc",
      rpc: rpcReturning(tokenTx(WRONG_MINT, 1_000_000)),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_mint");
});

test("a consumed reference cannot unlock a second grind", async () => {
  const store = memoryStore();
  const now = 1_700_000_000_000;
  const first = await verifyPayment(
    paymentArgs({
      asset: "usdc",
      store,
      now,
      rpc: rpcReturning(tokenTx(USDC_MINT, 1_000_000)),
    })
  );
  assert.equal(first.ok, true);
  const spent = await consumeUnlock({ token: first.token, store, secret: SECRET, now });
  assert.equal(spent.ok, true);

  const again = await verifyPayment(
    paymentArgs({
      asset: "usdc",
      store,
      now,
      rpc: rpcReturning(tokenTx(USDC_MINT, 1_000_000)),
    })
  );
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.reason, "reused");

  const secondSpend = await consumeUnlock({ token: first.token, store, secret: SECRET, now });
  assert.equal(secondSpend.reason, "reused");
});

test("an unsigned payment transaction includes the reference and recipient", () => {
  const blockhash = REFERENCE;
  const sol = buildUnsignedTransaction({
    asset: "sol",
    payer: PAYER,
    payTo: PAY_TO,
    reference: REFERENCE,
    lamports: 10_000_000,
    blockhash,
  });
  const tx = Transaction.from(Buffer.from(sol, "base64"));
  const keys = tx.instructions.flatMap((ix) => ix.keys.map((key) => key.pubkey.toBase58()));
  assert.ok(keys.includes(PAY_TO));
  assert.ok(keys.includes(REFERENCE));
});
