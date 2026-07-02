import { parentPort, workerData } from "node:worker_threads";
import { ed25519 } from "@noble/curves/ed25519.js";

// Inline Base58 encoder (Bitcoin/Solana alphabet) — avoids a runtime dependency.
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

const { pattern, position, caseSensitive } = workerData;
const target = caseSensitive ? pattern : pattern.toLowerCase();

function matches(address) {
  const addr = caseSensitive ? address : address.toLowerCase();
  switch (position) {
    case "prefix":
      return addr.startsWith(target);
    case "suffix":
      return addr.endsWith(target);
    case "anywhere":
      return addr.includes(target);
    default:
      return false;
  }
}

let attempts = 0;
let reported = 0;

for (;;) {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const address = encodeBase58(pub);
  attempts++;

  if (matches(address)) {
    // A Solana secret key is the 32-byte seed followed by the 32-byte public key.
    const secret = new Uint8Array(64);
    secret.set(priv, 0);
    secret.set(pub, 32);
    const privateKey = encodeBase58(secret);
    priv.fill(0);
    secret.fill(0);
    parentPort.postMessage({
      type: "found",
      address,
      privateKey,
      attempts: attempts - reported,
    });
    break;
  }

  priv.fill(0);

  if (attempts % 5000 === 0) {
    parentPort.postMessage({ type: "progress", count: attempts - reported });
    reported = attempts;
  }
}
