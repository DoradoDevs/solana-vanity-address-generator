import { PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { USDC_BASE_UNITS, USDC_DECIMALS, USDC_MINT } from "./constants.js";

/**
 * Unsigned legacy transaction for exactly 1.00 USDC.
 * The connected wallet is the fee payer and the token-account owner.
 * The payee ATA is created idempotently so a missing account does not fail the transfer.
 * The reference is a read-only account so verify can find the payment with
 * getSignaturesForAddress, the same lookup the payment check already uses.
 */
export function buildUnsignedTransaction({ payer, payTo, reference, blockhash }) {
  const payerKey = new PublicKey(payer);
  const payToKey = new PublicKey(payTo);
  const referenceKey = new PublicKey(reference);
  const mint = new PublicKey(USDC_MINT);
  const source = getAssociatedTokenAddressSync(mint, payerKey, true);
  const destination = getAssociatedTokenAddressSync(mint, payToKey, true);
  const tx = new Transaction({ feePayer: payerKey, recentBlockhash: blockhash });

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(payerKey, destination, payToKey, mint)
  );
  const transfer = createTransferCheckedInstruction(
    source,
    mint,
    destination,
    payerKey,
    USDC_BASE_UNITS,
    USDC_DECIMALS
  );
  transfer.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
  tx.add(transfer);

  return Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  ).toString("base64");
}
