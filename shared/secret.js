import { encodeBase58 } from "./base58.js";

/**
 * Solana secret-key export: 32-byte seed followed by the 32-byte public key,
 * Base58-encoded. The temporary 64-byte buffer is wiped before return.
 * Callers should wipe `seed` themselves; this function copies it first.
 */
export function assembleSecretKey(seed, pub) {
  if (!seed || seed.byteLength < 32 || !pub || pub.byteLength < 32) {
    throw new Error("Expected 32-byte seed and public key");
  }
  const secret = new Uint8Array(64);
  secret.set(seed.subarray(0, 32), 0);
  secret.set(pub.subarray(0, 32), 32);
  const encoded = encodeBase58(secret);
  secret.fill(0);
  return encoded;
}
