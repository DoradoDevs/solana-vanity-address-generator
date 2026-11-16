// Test doubles for the chain: jsonParsed transactions shaped like the ones a
// Solana RPC node returns, and a tiny RPC that answers from a list of them.
import { randomBytes } from "node:crypto";
import { encodeBase58 } from "../../../shared/base58.js";
import { referenceForClaim } from "../../netlify/functions/lib/claim.js";
import { DEFAULT_PAY_TO, TOKEN_PROGRAM_ID, USDC_MINT } from "../../netlify/functions/lib/constants.js";
import { SIGNATURE_LIMIT } from "../../netlify/functions/lib/rpc.js";

export const PAY_TO = DEFAULT_PAY_TO;
export const PAYER = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";
export const PAYER_ATA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const PAYEE_ATA = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const STRANGER = "Vote111111111111111111111111111111111111111";
export const OTHER_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export function newClaim() {
  const claim = encodeBase58(new Uint8Array(randomBytes(32)));
  return { claim, reference: referenceForClaim(claim) };
}

export function newSignature() {
  return encodeBase58(new Uint8Array(randomBytes(64)));
}

/** One row of pre/postTokenBalances. */
export function balance(accountIndex, amount, overrides = {}) {
  return {
    accountIndex,
    mint: USDC_MINT,
    owner: PAY_TO,
    programId: TOKEN_PROGRAM_ID,
    uiTokenAmount: { amount: String(amount), decimals: 6 },
    ...overrides,
  };
}

/**
 * A finalized transaction. By default it is the payment our own prepare
 * function builds: the payer's USDC account loses 1.00, the payee's gains 1.00.
 * Account indexes: 0 payer, 1 payer's USDC account, 2 payee's USDC account.
 */
export function paymentTx({
  references = [],
  signature = newSignature(),
  pre = [balance(1, 5_000_000, { owner: PAYER }), balance(2, 7_000_000)],
  post = [balance(1, 4_000_000, { owner: PAYER }), balance(2, 8_000_000)],
  err = null,
  extraKeys = [],
} = {}) {
  const keys = [PAYER, PAYER_ATA, PAYEE_ATA, PAY_TO, USDC_MINT, TOKEN_PROGRAM_ID, ...extraKeys, ...references];
  return {
    slot: 300_000_000,
    blockTime: 1_700_000_000,
    meta: { err, fee: 5000, preTokenBalances: pre, postTokenBalances: post },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3, source: "transaction" })),
      },
    },
  };
}

/**
 * An RPC over a list of transactions, oldest first. Like a real node it
 * returns signatures for any address a transaction names, newest first, and
 * hands out a transaction only once it is finalized.
 */
export function chainRpc(entries = []) {
  const chain = entries.map((entry) => (entry.tx ? entry : { tx: entry }));
  const calls = { getSignaturesForAddress: 0, getTransaction: 0, getSignatureStatuses: 0 };
  return {
    calls,
    async getSignaturesForAddress(address) {
      calls.getSignaturesForAddress += 1;
      return chain
        .filter(({ tx, status }) => status !== "unseen" && tx.transaction.message.accountKeys.some((key) => key.pubkey === address))
        .map(({ tx, status = "finalized" }) => ({
          signature: tx.transaction.signatures[0],
          err: tx.meta.err,
          confirmationStatus: status,
        }))
        .reverse()
        .slice(0, SIGNATURE_LIMIT);
    },
    async getSignatureStatuses(signatures) {
      calls.getSignatureStatuses += 1;
      return signatures.map((signature) => {
        const found = chain.find(({ tx }) => tx.transaction.signatures[0] === signature);
        if (!found || found.status === "unseen") return null;
        return { err: found.tx.meta.err, confirmationStatus: found.status ?? "finalized" };
      });
    },
    async getTransaction(signature) {
      calls.getTransaction += 1;
      const found = chain.find(({ tx }) => tx.transaction.signatures[0] === signature);
      if (!found || (found.status ?? "finalized") !== "finalized") return null;
      return found.served ?? found.tx;
    },
  };
}
