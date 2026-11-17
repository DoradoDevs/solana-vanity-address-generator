import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_BASE_UNITS,
  USDC_DECIMALS,
  USDC_MINT,
} from "./constants.js";

// The account derivation and the two instructions, written out with the
// names and argument order @solana/spl-token gives them. Using the library
// for them pulled in bigint-buffer. test/spl-token-vectors.test.js checks
// the bytes against ones spl-token produced.
const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const SYSTEM_PROGRAM = new PublicKey(SYSTEM_PROGRAM_ID);
const TRANSFER_CHECKED = 12;
const CREATE_IDEMPOTENT = 1;

/** The owner's associated token account for the mint. The owner may be off the curve (a program address). */
export function associatedTokenAddress(mint, owner) {
  const seeds = [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()];
  return PublicKey.findProgramAddressSync(seeds, ASSOCIATED_TOKEN_PROGRAM)[0];
}

/** Associated Token program CreateIdempotent: creates the account unless it exists. The payer funds it. */
export function createAssociatedTokenAccountIdempotentInstruction(payer, associatedToken, owner, mint) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([CREATE_IDEMPOTENT]),
  });
}

/** Token program TransferChecked: the amount as a little-endian u64, then the mint's decimals. */
export function createTransferCheckedInstruction(source, mint, destination, owner, amount, decimals) {
  const data = Buffer.alloc(10);
  data.writeUInt8(TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

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
  const source = associatedTokenAddress(mint, payerKey);
  const destination = associatedTokenAddress(mint, payToKey);
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
