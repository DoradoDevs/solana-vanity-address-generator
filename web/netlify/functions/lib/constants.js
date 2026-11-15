/** Public receive address. Override with the PAY_TO_ADDRESS env var. */
export const DEFAULT_PAY_TO = "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp";

/** Mainnet USDC (SPL Token, 6 decimals). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const USDC_DECIMALS = 6;
export const USDC_BASE_UNITS = 1_000_000n;

/** Accept a SOL payment that is this much under the quoted $1 price. Overpay is fine. */
export const TOLERANCE_BPS = 300;

export const TOKEN_TTL_MS = 10 * 60 * 1000;

export function payToAddress() {
  return (process.env.PAY_TO_ADDRESS || DEFAULT_PAY_TO).trim();
}

export function unlockSecret() {
  const secret = process.env.UNLOCK_SECRET || "";
  if (secret.length < 16) return null;
  return secret;
}

export function solanaRpcUrl() {
  const url = (process.env.SOLANA_RPC_URL || "").trim();
  return url || null;
}
