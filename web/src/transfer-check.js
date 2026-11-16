/**
 * The page's own check of the transfer the server built, made before the
 * wallet is asked to sign it.
 *
 * The server is trusted to build the transaction, not to decide what it
 * does. The bytes are decoded here and must be exactly the payment this page
 * expects: the connected wallet pays the fee and is the only signer, the
 * payee's USDC account is created if missing, and exactly 1.00 USDC moves
 * from the wallet's USDC account to the pinned payee's, naming this
 * attempt's reference. Any other instruction, program, account, signer,
 * mint, amount or destination, and the page refuses to sign. Nothing here
 * talks to the network.
 */
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PAY_TO,
  PRICE_BASE_UNITS,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
  USDC_MINT,
} from "../../shared/payment.js";

const TRANSFER_CHECKED = 12;
const CREATE_IDEMPOTENT = 1;

// ── ed25519: is a 32-byte string a point on the curve? ─────────────────────
// Program-derived addresses are the hashes that are not. Same rule as
// curve25519-dalek's decompress, which the runtime uses.
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function powMod(base, exponent) {
  let result = 1n;
  let b = base % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y %= P;
  const yy = (y * y) % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy + 1n) % P;
  // x² = u / v has a root exactly when u·v is zero or a square (v is never zero).
  const legendre = powMod((u * v) % P, (P - 1n) / 2n);
  return legendre === 0n || legendre === 1n;
}

async function sha256(...parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** The associated USDC token account of an owner: the first bump, from 255 down, that is off the curve. */
export async function usdcAccountOf(owner) {
  const seeds = [decodeBase58(owner), decodeBase58(TOKEN_PROGRAM_ID), decodeBase58(USDC_MINT)];
  const program = decodeBase58(ASSOCIATED_TOKEN_PROGRAM_ID);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = await sha256(...seeds, Uint8Array.of(bump), program, PDA_MARKER);
    if (!isOnCurve(candidate)) return encodeBase58(candidate);
  }
  throw new Error("no associated token account address");
}

/** The reference a transfer names for a claim: Base58 of SHA-256 of the claim's bytes. */
export async function referenceOf(claim) {
  return encodeBase58(await sha256(decodeBase58(claim)));
}

// ── Legacy transaction wire format ────────────────────────────────────────

function reader(bytes) {
  let at = 0;
  const take = (n) => {
    if (at + n > bytes.length) throw new Error("truncated");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const u8 = () => take(1)[0];
  // compact-u16: up to three bytes, seven bits each, low first.
  const length = () => {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = u8();
      value |= (byte & 0x7f) << (7 * i);
      if (!(byte & 0x80)) return value;
    }
    throw new Error("bad length");
  };
  return { take, u8, length, done: () => at === bytes.length };
}

/** Decode a serialized legacy transaction. Throws on anything else. */
export function decodeTransaction(bytes) {
  const r = reader(bytes);
  const signatureCount = r.length();
  for (let i = 0; i < signatureCount; i++) r.take(64);
  const required = r.u8();
  // A versioned message starts with a byte whose top bit is set.
  if (required & 0x80) throw new Error("not a legacy transaction");
  const readonlySigned = r.u8();
  const readonlyUnsigned = r.u8();
  const keyCount = r.length();
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push(encodeBase58(r.take(32)));
  r.take(32); // recent blockhash
  const instructionCount = r.length();
  const instructions = [];
  for (let i = 0; i < instructionCount; i++) {
    const program = r.u8();
    const accountCount = r.length();
    const accounts = Array.from(r.take(accountCount));
    const data = r.take(r.length());
    if (program >= keyCount || accounts.some((index) => index >= keyCount)) throw new Error("bad account index");
    instructions.push({ program: keys[program], accounts: accounts.map((index) => keys[index]), data });
  }
  if (!r.done()) throw new Error("trailing bytes");
  if (required > keyCount || readonlySigned > required || readonlyUnsigned > keyCount - required) {
    throw new Error("bad header");
  }
  const writable = keys.filter((_, i) => (i < required ? i < required - readonlySigned : i < keyCount - readonlyUnsigned));
  return { signatureCount, signers: keys.slice(0, required), writable, keys, instructions };
}

const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

function u64(bytes) {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

/**
 * Check the transaction prepare returned before it goes to the wallet.
 * @param {Uint8Array} bytes the serialized, unsigned transaction
 * @param {{ payer: string, claim: string }} expected the connected wallet and this attempt's claim
 * @returns {Promise<string | null>} null when it is exactly the expected payment, otherwise what is wrong
 */
export async function checkPreparedTransfer(bytes, { payer, claim }) {
  let tx;
  try {
    tx = decodeTransaction(bytes);
  } catch (error) {
    return `unreadable: ${error.message}`;
  }
  const [payerUsdc, payeeUsdc, reference] = await Promise.all([
    usdcAccountOf(payer),
    usdcAccountOf(PAY_TO),
    referenceOf(claim),
  ]);

  if (tx.signatureCount !== 1 || !same(tx.signers, [payer])) return "signers";
  if (tx.keys[0] !== payer) return "fee payer";
  if (new Set(tx.keys).size !== tx.keys.length) return "duplicate account";
  const expectedKeys = [
    payer,
    payerUsdc,
    payeeUsdc,
    PAY_TO,
    USDC_MINT,
    reference,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ];
  if (!same([...tx.keys].sort(), [...expectedKeys].sort())) return "accounts";
  if (!same([...tx.writable].sort(), [payer, payerUsdc, payeeUsdc].sort())) return "writable accounts";
  if (tx.instructions.length !== 2) return "instructions";

  const [create, transfer] = tx.instructions;
  if (
    create.program !== ASSOCIATED_TOKEN_PROGRAM_ID ||
    !same(Array.from(create.data), [CREATE_IDEMPOTENT]) ||
    !same(create.accounts, [payer, payeeUsdc, PAY_TO, USDC_MINT, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID])
  ) {
    return "payee account creation";
  }
  if (transfer.program !== TOKEN_PROGRAM_ID || transfer.data.length !== 10 || transfer.data[0] !== TRANSFER_CHECKED) {
    return "transfer";
  }
  if (u64(transfer.data.subarray(1, 9)) !== PRICE_BASE_UNITS || transfer.data[9] !== USDC_DECIMALS) return "amount";
  if (!same(transfer.accounts, [payerUsdc, USDC_MINT, payeeUsdc, payer, reference])) return "transfer accounts";
  return null;
}
