import { decodeBase58 } from "../../../../shared/base58.js";

/** A Solana address is 32 bytes of Base58. No curve or RPC lookup. */
export function isAddress(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}
