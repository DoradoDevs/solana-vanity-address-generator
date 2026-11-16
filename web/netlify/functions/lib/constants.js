import { PAY_TO, PRICE_BASE_UNITS } from "../../../../shared/payment.js";

// The payee, the mint and the price are pinned in shared/payment.js, which the page uses too.
export { PAY_TO, TOKEN_PROGRAM_ID, USDC_DECIMALS, USDC_MINT } from "../../../../shared/payment.js";

export const USDC_BASE_UNITS = PRICE_BASE_UNITS;

export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** UNLOCK_SECRET shorter than this is treated as not set. */
export const MIN_SECRET_LENGTH = 16;

/**
 * The payee, or null. PAY_TO_ADDRESS may be left unset or set to the pinned
 * payee; any other value means the environment does not match the code the
 * page was built from, and every function that would use it refuses to run
 * rather than send payments, or the page, somewhere else.
 */
export function payToAddress() {
  const configured = (process.env.PAY_TO_ADDRESS || "").trim();
  return configured === "" || configured === PAY_TO ? PAY_TO : null;
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
