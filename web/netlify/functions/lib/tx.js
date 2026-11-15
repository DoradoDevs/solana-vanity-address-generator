import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { USDC_BASE_UNITS, USDC_DECIMALS, USDC_MINT } from "./constants.js";

/**
 * Unsigned legacy transaction. The reference is a read-only account so the
 * verifier can find the payment with getSignaturesForAddress.
 */
export function buildUnsignedTransaction({
  asset,
  payer,
  payTo,
  reference,
  lamports,
  blockhash,
}) {
  const payerKey = new PublicKey(payer);
  const payToKey = new PublicKey(payTo);
  const referenceKey = new PublicKey(reference);
  const tx = new Transaction({ feePayer: payerKey, recentBlockhash: blockhash });

  if (asset === "sol") {
    const transfer = SystemProgram.transfer({
      fromPubkey: payerKey,
      toPubkey: payToKey,
      lamports,
    });
    transfer.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
    tx.add(transfer);
  } else if (asset === "usdc") {
    const mint = new PublicKey(USDC_MINT);
    const source = getAssociatedTokenAddressSync(mint, payerKey, true);
    const destination = getAssociatedTokenAddressSync(mint, payToKey, true);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKey,
        destination,
        payToKey,
        mint
      )
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
  } else {
    throw new Error("unknown asset");
  }

  return Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  ).toString("base64");
}
