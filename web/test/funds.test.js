import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, USDC_MINT } from "../netlify/functions/lib/constants.js";
import { assessFunds, readTokenAmount } from "../netlify/functions/lib/funds.js";
import { NETWORK_FEE_NOTE, PAY_ERRORS, classifyWalletError } from "../../shared/pay-copy.js";

const OTHER_MINT = "So11111111111111111111111111111111111111112";

test("funds check requires 1.00 USDC and SOL for the fee or the payee account's rent", () => {
  assert.equal(ACCOUNT_SIZE, 165);
  const rent = 2_039_280;
  assert.deepEqual(
    assessFunds({ solLamports: 5_000 + rent, usdcBaseUnits: 1_000_000n, destinationExists: false, rentLamports: rent }),
    { ok: true, lamportsRequired: 5_000n + BigInt(rent) }
  );
  assert.equal(
    assessFunds({ solLamports: 5_000, usdcBaseUnits: 1_000_000n, destinationExists: true, rentLamports: rent }).ok,
    true
  );
  assert.equal(
    assessFunds({ solLamports: rent, usdcBaseUnits: 999_999n, destinationExists: false, rentLamports: rent }).reason,
    "insufficient_usdc"
  );
  assert.equal(
    assessFunds({ solLamports: 4_999, usdcBaseUnits: 1_000_000n, destinationExists: true, rentLamports: rent }).reason,
    "insufficient_sol"
  );
  assert.equal(
    assessFunds({ solLamports: 5_000, usdcBaseUnits: 1_000_000n, destinationExists: false, rentLamports: rent }).reason,
    "insufficient_sol"
  );
});

test("token amount reads the mint-checked balance at offset 64", () => {
  const mint = new PublicKey(USDC_MINT).toBytes();
  const data = new Uint8Array(165);
  data.set(mint, 0);
  const amount = 18_446_744_073_709_551_615n;
  for (let i = 0; i < 8; i++) data[64 + i] = Number((amount >> (8n * BigInt(i))) & 0xffn);
  assert.equal(readTokenAmount(data, mint), amount);
  assert.equal(readTokenAmount(null, mint), 0n);
  assert.equal(readTokenAmount(new Uint8Array(71), mint), 0n);
  assert.equal(readTokenAmount(data, new PublicKey(OTHER_MINT).toBytes()), 0n);
});

test("wallet errors map to friendly messages that mention the network fee", () => {
  for (const message of Object.values(PAY_ERRORS)) {
    assert.match(message, /a little SOL for the network fee/);
    assert.ok(message.includes(NETWORK_FEE_NOTE));
  }
  assert.equal(classifyWalletError({ code: 4001, message: "User rejected the request." }), "rejected");
  assert.equal(classifyWalletError(new Error("User rejected the request.")), "rejected");
  assert.equal(
    classifyWalletError({
      message: "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1",
      logs: ["Program log: Error: insufficient funds"],
    }),
    "insufficient_usdc"
  );
  assert.equal(classifyWalletError(new Error("Transfer: insufficient lamports 1000, need 2039280")), "insufficient_sol");
  assert.equal(
    classifyWalletError(
      new Error("Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.")
    ),
    "insufficient_sol"
  );
  assert.equal(classifyWalletError(new Error("Unexpected error")), null);
  // A failed preflight is no proof that nothing was sent: a wallet's resend of a transfer that
  // already landed fails it too. Each of these keeps the claim and the payment is looked for.
  for (const error of [
    new Error("Transaction simulation failed: This transaction has already been processed"),
    new Error("Simulation failed. \nMessage: Transaction simulation failed: This transaction has already been processed. \nLogs: []"),
    new Error("failed to send transaction: Transaction simulation failed: This transaction has already been processed"),
    { code: -32002, message: "Transaction simulation failed: This transaction has already been processed", data: { err: "AlreadyProcessed" } },
    new Error("AlreadyProcessed"),
    new Error("Transaction simulation failed: Blockhash not found"),
    { code: -32002, message: "Blockhash not found" },
    new Error("BlockhashNotFound"),
    new Error("Transaction simulation failed: Error processing Instruction 1: invalid account data for instruction"),
    new Error("Simulation failed."),
  ]) {
    assert.equal(classifyWalletError(error), null, String(error?.message));
  }
  assert.equal(PAY_ERRORS.not_sent, undefined);
  // Sent, then not seen in time: it may still land, so it is not "not sent".
  assert.equal(
    classifyWalletError(new Error("Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.")),
    null
  );
  assert.equal(classifyWalletError(new Error("Signature 5x has expired: block height exceeded.")), null);
  assert.match(PAY_ERRORS.no_wallet, /Phantom, Solflare, or Backpack/);
});
