/* Vanity Wallet Grinder — Web Worker (bundled via esbuild) */
import { ed25519 } from "@noble/curves/ed25519.js";

// ── Inline Base58 encoder ───────────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;

  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let result = "";
  for (let i = 0; i < zeros; i++) result += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) result += ALPHABET[digits[i]];
  return result;
}

// ── Helpers ─────────────────────────────────────────

function zeroOut(arr) {
  if (arr && arr.fill) arr.fill(0);
}

function check(address, target, position) {
  switch (position) {
    case "prefix":           return address.startsWith(target);
    case "suffix":           return address.endsWith(target);
    case "prefix-or-suffix": return address.startsWith(target) || address.endsWith(target);
    case "anywhere":         return address.includes(target);
    default: return false;
  }
}

// ── Signal ready ────────────────────────────────────

self.postMessage({ type: "ready" });

// ── Grinding with setTimeout batching ───────────────

let stopped = false;

self.onmessage = function (e) {
  if (e.data.command === "stop") {
    stopped = true;
    return;
  }

  const { pattern, position, caseSensitive } = e.data;
  const matchTarget = caseSensitive ? pattern : pattern.toLowerCase();

  // Auto-tune: start with a small batch, measure speed, then scale up
  let batchSize = 20;
  let tuned = false;

  function runBatch() {
    if (stopped) return;

    try {
      const t0 = performance.now();

      for (let i = 0; i < batchSize; i++) {
        // @noble/curves: generate random 32-byte private key → derive public key
        const privKey = ed25519.utils.randomSecretKey();
        const pubKey = ed25519.getPublicKey(privKey);
        const address = encodeBase58(pubKey);
        const addr = caseSensitive ? address : address.toLowerCase();

        if (check(addr, matchTarget, position)) {
          // Solana private key = 64 bytes (secret scalar 32 + public key 32)
          const fullKey = new Uint8Array(64);
          fullKey.set(privKey, 0);
          fullKey.set(pubKey, 32);
          const privateKeyB58 = encodeBase58(fullKey);
          zeroOut(privKey);
          zeroOut(pubKey);
          zeroOut(fullKey);

          self.postMessage({
            type: "found",
            address,
            privateKey: privateKeyB58,
            attempts: batchSize,
          });
          return;
        }

        zeroOut(privKey);
        zeroOut(pubKey);
      }

      const elapsed = performance.now() - t0;

      // Auto-tune batch size to target ~200ms per batch
      if (!tuned && elapsed > 0) {
        const keysPerMs = batchSize / elapsed;
        batchSize = Math.max(20, Math.min(5000, Math.round(keysPerMs * 200)));
        tuned = true;
        self.postMessage({
          type: "speed",
          keysPerSec: Math.round(keysPerMs * 1000),
          batchSize,
        });
      }

      self.postMessage({ type: "progress", count: batchSize });

      // Yield so messages flush to main thread
      setTimeout(runBatch, 0);
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err.message || String(err),
      });
    }
  }

  runBatch();
};
