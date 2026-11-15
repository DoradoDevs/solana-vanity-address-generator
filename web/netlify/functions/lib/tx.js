import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { USDC_BASE_UNITS, USDC_DECIMALS, USDC_MINT } from "./constants.js";

function pubkeyOf(key) {
  return typeof key === "string" ? key : key?.pubkey;
}

function accountIndex(accountKeys, address) {
  for (let i = 0; i < accountKeys.length; i++) {
    if (pubkeyOf(accountKeys[i]) === address) return i;
  }
  return -1;
}

function tokenDelta(meta, owner, mint) {
  const before = new Map();
  for (const row of meta?.preTokenBalances || []) {
    if (row.owner === owner && row.mint === mint) {
      before.set(row.accountIndex, BigInt(row.uiTokenAmount.amount));
    }
  }
  let delta = 0n;
  for (const row of meta?.postTokenBalances || []) {
    if (row.owner !== owner || row.mint !== mint) continue;
    const prior = before.get(row.accountIndex) ?? 0n;
    delta += BigInt(row.uiTokenAmount.amount) - prior;
  }
  return delta;
}

function mintsReceived(meta, owner) {
  const before = new Map();
  for (const row of meta?.preTokenBalances || []) {
    if (row.owner !== owner) continue;
    before.set(`${row.mint}:${row.accountIndex}`, BigInt(row.uiTokenAmount.amount));
  }
  const totals = new Map();
  for (const row of meta?.postTokenBalances || []) {
    if (row.owner !== owner) continue;
    const prior = before.get(`${row.mint}:${row.accountIndex}`) ?? 0n;
    const delta = BigInt(row.uiTokenAmount.amount) - prior;
    totals.set(row.mint, (totals.get(row.mint) ?? 0n) + delta);
  }
  return totals;
}

/**
 * Decide whether a finalized jsonParsed transaction pays for one grind.
 * `minLamports` is the smallest SOL payment accepted at the current price.
 */
export function assessTransaction(tx, { payTo, reference, asset, minLamports }) {
  if (!tx || tx.meta?.err) return { ok: false, reason: "invalid" };
  const keys = tx.transaction?.message?.accountKeys || [];
  if (!keys.some((key) => pubkeyOf(key) === reference)) {
    return { ok: false, reason: "invalid" };
  }

  if (asset === "sol") {
    const index = accountIndex(keys, payTo);
    if (index < 0) return { ok: false, reason: "wrong_amount" };
    const pre = BigInt(tx.meta.preBalances?.[index] ?? 0);
    const post = BigInt(tx.meta.postBalances?.[index] ?? 0);
    const received = post - pre;
    if (received >= BigInt(minLamports)) return { ok: true, asset: "sol" };
    return { ok: false, reason: "wrong_amount" };
  }

  if (asset === "usdc") {
    const received = tokenDelta(tx.meta, payTo, USDC_MINT);
    if (received === USDC_BASE_UNITS) return { ok: true, asset: "usdc" };
    const totals = mintsReceived(tx.meta, payTo);
    for (const [mint, amount] of totals) {
      if (mint !== USDC_MINT && amount > 0n) return { ok: false, reason: "wrong_mint" };
    }
    return { ok: false, reason: "wrong_amount" };
  }

  return { ok: false, reason: "invalid" };
}

/** Any 32-byte base58 key, including off-curve addresses. */
export function isAddress(value) {
  try {
    if (typeof value !== "string") return false;
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

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
