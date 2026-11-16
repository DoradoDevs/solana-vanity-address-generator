/** Public receive address. Override with the PAY_TO_ADDRESS env var. */
export const DEFAULT_PAY_TO = "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp";

/** Mainnet USDC (SPL Token, 6 decimals). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The classic SPL Token program, which owns the USDC mint. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const USDC_DECIMALS = 6;
export const USDC_BASE_UNITS = 1_000_000n;

export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** UNLOCK_SECRET shorter than this is treated as not set. */
export const MIN_SECRET_LENGTH = 16;

export function payToAddress() {
  return (process.env.PAY_TO_ADDRESS || DEFAULT_PAY_TO).trim();
}

/** Null when the secret is unset or too short. Every caller then refuses to issue or accept a token. */
export function unlockSecret() {
  const secret = process.env.UNLOCK_SECRET || "";
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

export function solanaRpcUrl() {
  const url = (process.env.SOLANA_RPC_URL || "").trim();
  return url || null;
}
