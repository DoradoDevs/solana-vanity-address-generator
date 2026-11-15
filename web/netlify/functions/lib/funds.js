import { USDC_BASE_UNITS } from "./constants.js";

/** One signature on a legacy transaction. The wallet may add a priority fee on top. */
export const BASE_FEE_LAMPORTS = 5_000n;

function toBytes(data) {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data;
  return Uint8Array.from(data);
}

/**
 * SPL token account amount at byte offset 64.
 * Returns 0 when the account is missing, short, or for a different mint.
 */
export function readTokenAmount(data, mintBytes) {
  const bytes = toBytes(data);
  if (!bytes || bytes.length < 72) return 0n;
  if (mintBytes) {
    const mint = toBytes(mintBytes);
    if (!mint || mint.length < 32) return 0n;
    for (let i = 0; i < 32; i++) {
      if (bytes[i] !== mint[i]) return 0n;
    }
  }
  let amount = 0n;
  for (let i = 0; i < 8; i++) {
    amount += BigInt(bytes[64 + i]) << (8n * BigInt(i));
  }
  return amount;
}

export function lamportsRequired({ destinationExists, rentLamports }) {
  const rent = destinationExists ? 0n : BigInt(rentLamports);
  return BASE_FEE_LAMPORTS + rent;
}

/**
 * The payer must hold exactly enough USDC (1.00) and enough SOL to be the fee payer.
 * Rent is included only when the payee's USDC account does not exist yet.
 */
export function assessFunds({ solLamports, usdcBaseUnits, destinationExists, rentLamports }) {
  if (BigInt(usdcBaseUnits) < USDC_BASE_UNITS) {
    return { ok: false, reason: "insufficient_usdc" };
  }
  const needed = lamportsRequired({ destinationExists, rentLamports });
  if (BigInt(solLamports) < needed) {
    return { ok: false, reason: "insufficient_sol" };
  }
  return { ok: true, lamportsRequired: needed };
}
