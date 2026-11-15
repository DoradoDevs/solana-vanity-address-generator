// Bitcoin/Solana Base58 alphabet. 0, O, I, and l are intentionally absent.
export const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  DECODE[BASE58_ALPHABET.charCodeAt(i)] = i;
}

/** Encode bytes to Base58. Leading zero bytes become leading "1"s. */
export function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("encodeBase58 expected Uint8Array");
  }

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

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

  const out = new Array(zeros + digits.length);
  for (let i = 0; i < zeros; i++) out[i] = "1";
  for (let i = 0; i < digits.length; i++) {
    out[zeros + i] = BASE58_ALPHABET[digits[digits.length - 1 - i]];
  }
  return out.join("");
}

/** Decode a Base58 string. Throws on characters outside the alphabet. */
export function decodeBase58(str) {
  if (typeof str !== "string") throw new TypeError("decodeBase58 expected string");
  if (str.length === 0) return new Uint8Array();

  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;

  const size = (((str.length - zeros) * 733) / 1000 + 1) | 0;
  const b256 = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let carry = code < 128 ? DECODE[code] : -1;
    if (carry < 0) throw new Error(`Invalid Base58 character: ${str[i]}`);
    let j = 0;
    for (let k = size - 1; (carry > 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * b256[k];
      b256[k] = carry & 0xff;
      carry >>= 8;
    }
    length = j;
  }

  let it = size - length;
  while (it < size && b256[it] === 0) it++;
  const out = new Uint8Array(zeros + (size - it));
  out.set(b256.subarray(it), zeros);
  return out;
}
