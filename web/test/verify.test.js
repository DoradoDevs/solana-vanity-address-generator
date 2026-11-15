import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { DEFAULT_PAY_TO, USDC_MINT } from "../netlify/functions/lib/constants.js";
import { assessFunds, readTokenAmount } from "../netlify/functions/lib/funds.js";
import { memoryStore } from "../netlify/functions/lib/store.js";
import { readUnlockToken } from "../netlify/functions/lib/token.js";
import { buildUnsignedTransaction } from "../netlify/functions/lib/tx.js";
import prepare from "../netlify/functions/prepare.mjs";
import { consumeUnlock, verifyPayment } from "../netlify/functions/lib/verify.js";
import { NETWORK_FEE_NOTE, PAY_ERRORS, classifyWalletError } from "../../shared/pay-copy.js";

const PAY_TO = DEFAULT_PAY_TO;
const PAYER = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";
const REFERENCE = "11111111111111111111111111111111";
const WRONG_MINT = "So11111111111111111111111111111111111111112";
const SECRET = "test-unlock-secret-value";

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
    rpc: rpcReturning(tokenTx(USDC_MINT, 1_000_000)),
    store: memoryStore(),
    payTo: PAY_TO,
    secret: SECRET,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

test("prepare loads and its shared pay-copy import resolves", () => {
  assert.equal(typeof prepare, "function");
});

test("verify accepts an exact 1.00 USDC payment and returns an unlock token", async () => {
  const store = memoryStore();
  const result = await verifyPayment(paymentArgs({ store }));
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.asset, "usdc");
  const parsed = readUnlockToken(result.token, SECRET, result.expiresAt - 1000);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ref, REFERENCE);
  assert.equal((await store.get(REFERENCE)).status, "paid");
  assert.equal((await store.get(REFERENCE)).asset, "usdc");
});

test("verify rejects a USDC transfer that is not exactly 1.00", async () => {
  for (const amount of [999_999, 1_000_001, 0]) {
    const result = await verifyPayment(
      paymentArgs({ rpc: rpcReturning(tokenTx(USDC_MINT, amount)) })
    );
    assert.equal(result.ok, false, String(amount));
    assert.equal(result.reason, "wrong_amount");
    assert.equal(result.status, 400);
  }
});

test("verify rejects a SOL transfer and a SOL asset", async () => {
  const asSol = await verifyPayment(
    paymentArgs({
      asset: "sol",
      rpc: rpcReturning(solTx(10_000_000)),
    })
  );
  assert.equal(asSol.ok, false);
  assert.equal(asSol.reason, "invalid");
  assert.equal(asSol.status, 400);

  const lamportsOnly = await verifyPayment(
    paymentArgs({ rpc: rpcReturning(solTx(10_000_000)) })
  );
  assert.equal(lamportsOnly.ok, false);
  assert.equal(lamportsOnly.reason, "wrong_amount");
});

test("verify rejects a token payment that is not USDC", async () => {
  const result = await verifyPayment(
    paymentArgs({ rpc: rpcReturning(tokenTx(WRONG_MINT, 1_000_000)) })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_mint");
});

test("a consumed reference cannot unlock a second grind", async () => {
  const store = memoryStore();
  const now = 1_700_000_000_000;
  const first = await verifyPayment(paymentArgs({ store, now }));
  assert.equal(first.ok, true);
  const spent = await consumeUnlock({ token: first.token, store, secret: SECRET, now });
  assert.equal(spent.ok, true);

  const again = await verifyPayment(paymentArgs({ store, now }));
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.reason, "reused");

  const secondSpend = await consumeUnlock({ token: first.token, store, secret: SECRET, now });
  assert.equal(secondSpend.reason, "reused");
});

test("an unsigned payment is a 1.00 USDC transfer with an idempotent ATA and a reference", () => {
  const raw = buildUnsignedTransaction({
    payer: PAYER,
    payTo: PAY_TO,
    reference: REFERENCE,
    blockhash: REFERENCE,
  });
  const tx = Transaction.from(Buffer.from(raw, "base64"));
  assert.equal(tx.feePayer.toBase58(), PAYER);
  assert.equal(tx.instructions.length, 2);

  const [createIx, transferIx] = tx.instructions;
  assert.equal(createIx.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(Buffer.from(createIx.data)[0], 1);

  assert.equal(transferIx.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  const data = Buffer.from(transferIx.data);
  assert.equal(data[0], 12);
  assert.equal(data.readBigUInt64LE(1), 1_000_000n);
  assert.equal(data[9], 6);

  const refKey = transferIx.keys.find((key) => key.pubkey.toBase58() === REFERENCE);
  assert.ok(refKey);
  assert.equal(refKey.isSigner, false);
  assert.equal(refKey.isWritable, false);

  const mint = new PublicKey(USDC_MINT);
  const source = getAssociatedTokenAddressSync(mint, new PublicKey(PAYER), true);
  const destination = getAssociatedTokenAddressSync(mint, new PublicKey(PAY_TO), true);
  const keys = tx.instructions.flatMap((ix) => ix.keys.map((key) => key.pubkey.toBase58()));
  assert.ok(keys.includes(PAY_TO));
  assert.ok(keys.includes(USDC_MINT));
  assert.ok(keys.includes(source.toBase58()));
  assert.ok(keys.includes(destination.toBase58()));
  assert.equal(
    tx.instructions.some((ix) => ix.programId.toBase58() === "11111111111111111111111111111111"),
    false
  );
});

test("funds check requires 1.00 USDC and SOL for the fee or ATA rent", () => {
  assert.equal(ACCOUNT_SIZE, 165);
  const rent = 2_039_280;
  assert.deepEqual(
    assessFunds({
      solLamports: 5_000 + rent,
      usdcBaseUnits: 1_000_000n,
      destinationExists: false,
      rentLamports: rent,
    }),
    { ok: true, lamportsRequired: 5_000n + BigInt(rent) }
  );
  assert.equal(
    assessFunds({
      solLamports: 5_000,
      usdcBaseUnits: 1_000_000n,
      destinationExists: true,
      rentLamports: rent,
    }).ok,
    true
  );
  assert.equal(
    assessFunds({
      solLamports: rent,
      usdcBaseUnits: 999_999n,
      destinationExists: false,
      rentLamports: rent,
    }).reason,
    "insufficient_usdc"
  );
  assert.equal(
    assessFunds({
      solLamports: 4_999,
      usdcBaseUnits: 1_000_000n,
      destinationExists: true,
      rentLamports: rent,
    }).reason,
    "insufficient_sol"
  );
  assert.equal(
    assessFunds({
      solLamports: 5_000,
      usdcBaseUnits: 1_000_000n,
      destinationExists: false,
      rentLamports: rent,
    }).reason,
    "insufficient_sol"
  );
});

test("token amount reads the mint-checked balance at offset 64", () => {
  const mint = new PublicKey(USDC_MINT).toBytes();
  const data = new Uint8Array(165);
  data.set(mint, 0);
  const amount = 1_000_000n;
  for (let i = 0; i < 8; i++) data[64 + i] = Number((amount >> (8n * BigInt(i))) & 0xffn);
  assert.equal(readTokenAmount(data, mint), amount);
  assert.equal(readTokenAmount(null, mint), 0n);
  const other = new PublicKey(WRONG_MINT).toBytes();
  assert.equal(readTokenAmount(data, other), 0n);
});

test("wallet errors map to friendly messages that mention the network fee", () => {
  for (const message of Object.values(PAY_ERRORS)) {
    assert.match(message, /a little SOL for the network fee/);
    assert.ok(message.includes(NETWORK_FEE_NOTE));
  }
  assert.equal(classifyWalletError({ code: 4001, message: "User rejected the request." }), "rejected");
  assert.equal(
    classifyWalletError(new Error("User rejected the request.")),
    "rejected"
  );
  assert.equal(
    classifyWalletError({
      message: "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1",
      logs: ["Program log: Error: insufficient funds"],
    }),
    "insufficient_usdc"
  );
  assert.equal(
    classifyWalletError(
      new Error("Transfer: insufficient lamports 1000, need 2039280")
    ),
    "insufficient_sol"
  );
  assert.equal(
    classifyWalletError(
      new Error(
        "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit."
      )
    ),
    "insufficient_sol"
  );
  assert.match(PAY_ERRORS.no_wallet, /Phantom, Solflare, or Backpack/);
});
