import { BASE58_ALPHABET } from "./base58.js";

const UNSET_TIP = new Set([
  "",
  "REPLACE_WITH_YOUR_SOL_ADDRESS",
  "YOUR_SOL_ADDRESS",
  "TODO",
]);

/**
 * A tip target must be a public Solana address (32–44 Base58 chars).
 * Secret keys are longer (~87–88 chars) and are rejected so they cannot
 * be rendered as a "donation" target.
 */
export function isPublishableTipAddress(address) {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (UNSET_TIP.has(trimmed)) return false;
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  for (const ch of trimmed) {
    if (!BASE58_ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function isLongPattern(pattern, pro) {
  const max = pro?.freeMaxPatternLength ?? 5;
  return typeof pattern === "string" && pattern.length > max;
}

/**
 * Batch generation is the Pro path. When the flag is off, every run
 * grinds a single address. No payment is involved either way.
 */
export function resolveBatch(requested, pro) {
  const enabled = pro?.enabled === true;
  const cap =
    Number.isInteger(pro?.maxBatch) && pro.maxBatch >= 1 ? pro.maxBatch : 1;
  if (!Number.isFinite(requested)) {
    return { enabled, batch: 1, rejected: true };
  }
  const n = Math.floor(requested);
  if (!enabled) {
    return { enabled: false, batch: 1, rejected: n > 1 };
  }
  if (n < 1) return { enabled: true, batch: 1, rejected: true };
  if (n > cap) return { enabled: true, batch: cap, rejected: true };
  return { enabled: true, batch: n, rejected: false };
}
