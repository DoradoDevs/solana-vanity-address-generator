// The page's check of the transfer the server built, attacked: each tampered
// transaction must be refused before a wallet is asked to sign it, and for the
// reason that names the rule it breaks, so that deleting any one rule fails a
// test here. Where a rule could hide behind another, the variant keeps the
// nine expected accounts and the expected writable set, so only that rule can
// refuse it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  createApproveInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
} from "./helpers/token-program.js";
import { ASSOCIATED_ACCOUNTS } from "./helpers/spl-token-vectors.js";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import {
  associatedTokenAddress,
  buildUnsignedTransaction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "../netlify/functions/lib/tx.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PAY_TO, TOKEN_PROGRAM_ID, USDC_MINT } from "../../shared/payment.js";
import { checkPreparedTransfer, isOnCurve, referenceOf, usdcAccountOf } from "../src/transfer-check.js";
import { PAYER, newClaim } from "./helpers/chain.js";

const BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const ATTACKER = Keypair.generate().publicKey.toBase58();
const OTHER_MINT = "So11111111111111111111111111111111111111112";
const MAX_U64 = 18_446_744_073_709_551_615n;
const SYSTEM = SystemProgram.programId.toBase58();
const TOKEN = TOKEN_PROGRAM_ID;
const ATA_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID;

const ata = (owner, mint = USDC_MINT) => associatedTokenAddress(new PublicKey(mint), new PublicKey(owner));

const readOnly = (address) => ({ pubkey: new PublicKey(address), isSigner: false, isWritable: false });

function bytesOf(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** The transfer prepare builds, with one part swapped out. */
function tampered({
  payer = PAYER,
  feePayer = payer,
  payTo = PAY_TO,
  mint = USDC_MINT,
  amount = 1_000_000n,
  decimals = 6,
  reference,
  referenceWritable = false,
  source = ata(payer, mint),
  before = [],
  after = [],
  extraTransferKeys = [],
  create,
  transfer,
} = {}) {
  const payerKey = new PublicKey(payer);
  const mintKey = new PublicKey(mint);
  const destination = ata(payTo, mint);
  const tx = new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash: BLOCKHASH });
  for (const instruction of before) tx.add(instruction);
  tx.add(create ?? createAssociatedTokenAccountIdempotentInstruction(payerKey, destination, new PublicKey(payTo), mintKey));
  const move = transfer ?? createTransferCheckedInstruction(source, mintKey, destination, payerKey, amount, decimals);
  move.keys.push({ pubkey: new PublicKey(reference), isSigner: false, isWritable: referenceWritable }, ...extraTransferKeys);
  tx.add(move);
  for (const instruction of after) tx.add(instruction);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** An amount as instruction data carries it: u64, little-endian. */
const u64le = (value) => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

/** A compact-u16 in its one canonical spelling. */
function compactU16(value) {
  const out = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  out.push(value);
  return out;
}

/** The expected payment as plain keys and instructions, for raw() to write with one thing changed. */
function expected(reference) {
  const payerUsdc = ata(PAYER).toBase58();
  const payeeUsdc = ata(PAY_TO).toBase58();
  return {
    payerUsdc,
    payeeUsdc,
    keys: [PAYER, payerUsdc, payeeUsdc, PAY_TO, USDC_MINT, reference, SYSTEM, TOKEN, ATA_PROGRAM],
    create: { program: ATA_PROGRAM, accounts: [PAYER, payeeUsdc, PAY_TO, USDC_MINT, SYSTEM, TOKEN], data: [1] },
    transfer: {
      program: TOKEN,
      accounts: [payerUsdc, USDC_MINT, payeeUsdc, PAYER, reference],
      data: [12, ...u64le(1_000_000n), 6],
    },
  };
}

/**
 * A legacy transaction written byte by byte, for shapes @solana/web3.js will
 * not build: an unused or repeated key, an index past the keys, another
 * header or signature count. Instructions name their program and accounts by
 * address, or by raw index. By default the first three keys are the writable
 * ones and only the first signs.
 */
function raw({ keys, header = [1, 0, keys.length - 3], signatures = 1, instructions }) {
  const index = (key) => {
    if (typeof key === "number") return key;
    assert.ok(keys.includes(key), `${key} is not among the keys`);
    return keys.indexOf(key);
  };
  const parts = [compactU16(signatures), new Uint8Array(64 * signatures), header, compactU16(keys.length)];
  for (const key of keys) parts.push(new PublicKey(key).toBytes());
  parts.push(new PublicKey(BLOCKHASH).toBytes(), compactU16(instructions.length));
  for (const { program, accounts, data } of instructions) {
    parts.push([index(program)], compactU16(accounts.length), accounts.map(index), compactU16(data.length), data);
  }
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

/** The same reason for every named case, so a failure shows what each one got. */
const all = (cases, reason) => Object.fromEntries(Object.keys(cases).map((name) => [name, reason]));

test("the curve test and the account derivation agree with @solana/web3.js and spl-token", async () => {
  for (let i = 0; i < 300; i++) {
    const bytes = new Uint8Array(randomBytes(32));
    assert.equal(isOnCurve(bytes), PublicKey.isOnCurve(bytes), Buffer.from(bytes).toString("hex"));
  }
  for (let i = 0; i < 50; i++) assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);

  const owners = [PAY_TO, PAYER, ATTACKER];
  for (let i = 0; i < 25; i++) owners.push(new PublicKey(randomBytes(32)).toBase58());
  for (const owner of owners) assert.equal(await usdcAccountOf(owner), ata(owner).toBase58(), owner);
  // And spl-token's own answers, recorded before it was removed, owners off the curve among them.
  const recorded = ASSOCIATED_ACCOUNTS.filter(({ mint }) => mint === USDC_MINT);
  assert.ok(recorded.some(({ owner }) => !PublicKey.isOnCurve(new PublicKey(owner).toBytes())));
  for (const { owner, address } of recorded) assert.equal(await usdcAccountOf(owner), address, owner);

  const { claim } = newClaim();
  assert.equal(await referenceOf(claim), referenceForClaim(claim));
});

test("on edge encodings the curve test follows the runtime's decompress (noble zip215), not web3.js", () => {
  // curve25519-dalek's decompress, which the runtime uses, reads y modulo p
  // and accepts x = 0 with the sign bit set. @noble/curves v2 with zip215 does
  // the same; web3.js's PublicKey.isOnCurve refuses both (RFC 8032 rules).
  const P = 2n ** 255n - 19n;
  const encoded = (y, signBit) => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Number((y >> BigInt(8 * i)) & 0xffn);
    if (signBit) bytes[31] |= 0x80;
    return bytes;
  };
  const zip215 = (bytes) => {
    try {
      ed25519.Point.fromBytes(bytes, true);
      return true;
    } catch {
      return false;
    }
  };
  // y near 0 and near p, and every y >= p that fits in 255 bits, each with the sign bit clear and set.
  const ys = [];
  for (let k = 0n; k < 20n; k++) ys.push(k, P - 1n - k);
  for (let y = P; y < 2n ** 255n; y++) ys.push(y);
  const seen = new Set();
  for (const y of ys) {
    for (const signBit of [false, true]) {
      const bytes = encoded(y, signBit);
      const hex = Buffer.from(bytes).toString("hex");
      const onCurve = zip215(bytes);
      seen.add(onCurve);
      assert.equal(isOnCurve(bytes), onCurve, hex);
      const xIsZero = y === 1n || y === P - 1n;
      assert.equal(PublicKey.isOnCurve(bytes), onCurve && y < P && !(xIsZero && signBit), `web3.js ${hex}`);
    }
  }
  assert.deepEqual([...seen].sort(), [false, true]);
  // The named cases: x = 0 with the sign bit set, and y = p, p + 1 read as 0 and 1.
  for (const [y, signBit] of [[1n, true], [P - 1n, true], [P, false], [P + 1n, false], [P + 1n, true]]) {
    assert.equal(isOnCurve(encoded(y, signBit)), true, `${y} ${signBit}`);
  }
});

test("the transfer prepare builds passes the page's check", async () => {
  const { claim, reference } = newClaim();
  const bytes = bytesOf(buildUnsignedTransaction({ payer: PAYER, payTo: PAY_TO, reference, blockhash: BLOCKHASH }));
  assert.equal(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), null);
  // The same bytes again through the test's own builder, so the variants below differ only where they say.
  assert.equal(await checkPreparedTransfer(tampered({ reference }), { payer: PAYER, claim }), null);
  // And written byte by byte, for the variants web3.js will not build.
  const { keys, create, transfer } = expected(reference);
  assert.equal(await checkPreparedTransfer(raw({ keys, instructions: [create, transfer] }), { payer: PAYER, claim }), null);
});

test("a transfer to anyone but the pinned payee is refused", async () => {
  const { claim, reference } = newClaim();
  const refused = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  assert.equal(await refused(tampered({ reference, payTo: ATTACKER })), "accounts");
  // Created for the payee, paid somewhere else.
  const elsewhere = createTransferCheckedInstruction(
    ata(PAYER),
    new PublicKey(USDC_MINT),
    ata(ATTACKER),
    new PublicKey(PAYER),
    1_000_000n,
    6
  );
  assert.equal(await refused(tampered({ reference, transfer: elsewhere })), "accounts");
  // Over the expected accounts only, so just the transfer's account list can tell.
  const payer = new PublicKey(PAYER);
  const mint = new PublicKey(USDC_MINT);
  const moves = {
    "the payer's USDC account to itself": createTransferCheckedInstruction(ata(PAYER), mint, ata(PAYER), payer, 1_000_000n, 6),
    "the payee's USDC account to the payer's": createTransferCheckedInstruction(ata(PAY_TO), mint, ata(PAYER), payer, 1_000_000n, 6),
  };
  const reasons = {};
  for (const [name, transfer] of Object.entries(moves)) reasons[name] = await refused(tampered({ reference, transfer }));
  assert.deepEqual(reasons, all(moves, "transfer accounts"));
});

test("any amount but exactly 1.00 USDC, or any other mint, is refused", async () => {
  const { claim, reference } = newClaim();
  const refused = async (options) => checkPreparedTransfer(tampered({ reference, ...options }), { payer: PAYER, claim });
  for (const amount of [0n, 999_999n, 1_000_001n, 100_000_000n, MAX_U64]) {
    assert.equal(await refused({ amount }), "amount", String(amount));
  }
  assert.equal(await refused({ decimals: 0 }), "amount");
  assert.equal(await refused({ mint: OTHER_MINT }), "accounts");
  // An unchecked Transfer of the right amount does not name the mint at all.
  const plain = createTransferInstruction(ata(PAYER), ata(PAY_TO), new PublicKey(PAYER), 1_000_000n);
  assert.equal(await refused({ transfer: plain }), "transfer");
});

test("the money moves only by a TransferChecked of the Token program", async () => {
  const { claim, reference } = newClaim();
  const { keys, create, transfer } = expected(reference);
  const check = (moved) => checkPreparedTransfer(raw({ keys, instructions: [create, moved] }), { payer: PAYER, claim });
  // Each keeps the transfer's accounts and the amount and decimals where TransferChecked carries them.
  const moves = {
    "the same accounts and data under the ATA program": { ...transfer, program: ATA_PROGRAM },
    "the Transfer opcode (3) in TransferChecked's layout": { ...transfer, data: [3, ...transfer.data.slice(1)] },
    "a byte after the decimals": { ...transfer, data: [...transfer.data, 0] },
  };
  const reasons = {};
  for (const [name, moved] of Object.entries(moves)) reasons[name] = await check(moved);
  assert.deepEqual(reasons, all(moves, "transfer"));
});

test("an extra instruction of any kind is refused, before or after the payment", async () => {
  const { claim, reference } = newClaim();
  const payer = new PublicKey(PAYER);
  // Each of these brings an account outside the expected nine.
  const extras = [
    // Let the attacker spend the whole USDC balance later.
    createApproveInstruction(ata(PAYER), new PublicKey(ATTACKER), payer, MAX_U64),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(ATTACKER), lamports: 1 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ];
  for (const extra of extras) {
    for (const place of ["before", "after"]) {
      const bytes = tampered({ reference, [place]: [extra] });
      assert.equal(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), "accounts", `${place} ${extra.programId}`);
    }
  }
});

test("a third instruction over only the expected accounts is refused by the instruction count", async () => {
  const { claim, reference } = newClaim();
  const payer = new PublicKey(PAYER);
  // The attacker's address rides in instruction data, never among the account keys.
  const extras = {
    "SetAuthority of the payer's USDC account to the attacker": createSetAuthorityInstruction(
      ata(PAYER),
      payer,
      AuthorityType.AccountOwner,
      new PublicKey(ATTACKER)
    ),
    "a second TransferChecked, of 1,000 USDC to the payee": createTransferCheckedInstruction(
      ata(PAYER),
      new PublicKey(USDC_MINT),
      ata(PAY_TO),
      payer,
      1_000_000_000n,
      6
    ),
    "a SOL transfer from the payer to the payee's USDC account": SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: ata(PAY_TO),
      lamports: 1_000_000_000,
    }),
  };
  const reasons = {};
  for (const [name, extra] of Object.entries(extras)) {
    reasons[name] = await checkPreparedTransfer(tampered({ reference, after: [extra] }), { payer: PAYER, claim });
  }
  assert.deepEqual(reasons, all(extras, "instructions"));
});

test("the first instruction must be exactly the payee's CreateIdempotent, even over only the expected accounts", async () => {
  const { claim, reference } = newClaim();
  const payer = new PublicKey(PAYER);
  const mint = new PublicKey(USDC_MINT);
  // Stand-ins for the create. Where one lacks PAY_TO or a program the create
  // would bring, it is appended read-only, so the account set still matches.
  const padded = (instruction, ...addresses) => {
    instruction.keys.push(...addresses.map(readOnly));
    return instruction;
  };
  const payeeCreateWith = (data) => {
    const instruction = createAssociatedTokenAccountIdempotentInstruction(payer, ata(PAY_TO), new PublicKey(PAY_TO), mint);
    instruction.data = Buffer.from(data);
    return instruction;
  };
  const standIns = {
    "TransferChecked of 1,000 USDC to the payee": padded(
      createTransferCheckedInstruction(ata(PAYER), mint, ata(PAY_TO), payer, 1_000_000_000n, 6),
      PAY_TO,
      SYSTEM,
      ATA_PROGRAM
    ),
    "Approve of the payer's USDC to PAY_TO, unlimited": padded(
      createApproveInstruction(ata(PAYER), new PublicKey(PAY_TO), payer, MAX_U64),
      SYSTEM,
      ATA_PROGRAM
    ),
    "CreateIdempotent of the payer's own USDC account": padded(
      createAssociatedTokenAccountIdempotentInstruction(payer, ata(PAYER), payer, mint),
      PAY_TO
    ),
    "Create (data [0]) of the payee's USDC account": payeeCreateWith([0]),
    "Create (no data) of the payee's USDC account": payeeCreateWith([]),
    "System Assign of the payer to the attacker's program": padded(
      SystemProgram.assign({ accountPubkey: payer, programId: new PublicKey(ATTACKER) }),
      PAY_TO,
      ATA_PROGRAM
    ),
  };
  const reasons = {};
  for (const [name, create] of Object.entries(standIns)) {
    reasons[name] = await checkPreparedTransfer(tampered({ reference, create }), { payer: PAYER, claim });
  }
  // The create's accounts and data, under the Token program (InitializeAccount), with the ATA program left unused.
  const { keys, create, transfer } = expected(reference);
  const underToken = raw({ keys, instructions: [{ ...create, program: TOKEN }, transfer] });
  reasons["the create's accounts and data under the Token program"] = await checkPreparedTransfer(underToken, {
    payer: PAYER,
    claim,
  });
  assert.deepEqual(reasons, {
    ...all(standIns, "payee account creation"),
    "the create's accounts and data under the Token program": "payee account creation",
  });
});

test("another signer, another fee payer, or another source account is refused", async () => {
  const { claim, reference } = newClaim();
  const refused = async (options) => checkPreparedTransfer(tampered({ reference, ...options }), { payer: PAYER, claim });
  const cosigner = { pubkey: new PublicKey(ATTACKER), isSigner: true, isWritable: false };
  assert.equal(await refused({ extraTransferKeys: [cosigner] }), "signers");
  // The fee payer is the first signer, so another fee payer is another signer.
  // Once the signers are exactly [payer] the first key is the payer, which
  // leaves the separate fee-payer rule nothing of its own to refuse.
  assert.equal(await refused({ feePayer: ATTACKER }), "signers");
  const otherAccount = new PublicKey(randomBytes(32));
  assert.equal(await refused({ source: otherAccount }), "accounts");
  // One required signer, but a signature slot count other than one.
  const { keys, create, transfer } = expected(reference);
  for (const signatures of [0, 2]) {
    const bytes = raw({ keys, signatures, instructions: [create, transfer] });
    assert.equal(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), "signers", String(signatures));
  }
});

test("the transfer must name this attempt's reference, read-only", async () => {
  const mine = newClaim();
  const theirs = newClaim();
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim: mine.claim });
  assert.equal(await check(tampered({ reference: theirs.reference })), "accounts");
  assert.equal(await check(tampered({ reference: mine.reference, referenceWritable: true })), "writable accounts");
  // A transfer for a different wallet than the one connected.
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(await check(tampered({ reference: mine.reference, payer: other })), "signers");
  // The reference among the keys, but not on the transfer.
  const { keys, create, transfer } = expected(mine.reference);
  const unnamed = { ...transfer, accounts: transfer.accounts.slice(0, 4) };
  assert.equal(await check(raw({ keys, instructions: [create, unnamed] })), "transfer accounts");
});

test("the account keys must be exactly the expected nine, each once", async () => {
  const { claim, reference } = newClaim();
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  const { keys, payerUsdc, create, transfer } = expected(reference);
  const instructions = [create, transfer];
  // A tenth key no instruction uses.
  assert.equal(await check(raw({ keys: [...keys, ATTACKER], instructions })), "accounts");
  // An expected key listed twice: read-only at the end, or writable among the writable ones.
  assert.equal(await check(raw({ keys: [...keys, USDC_MINT], instructions })), "duplicate account");
  const writableTwice = [...keys.slice(0, 3), payerUsdc, ...keys.slice(3)];
  assert.equal(await check(raw({ keys: writableTwice, header: [1, 0, 6], instructions })), "duplicate account");
});

test("bytes that are not exactly one legacy transaction are refused", async () => {
  const { claim, reference } = newClaim();
  const good = tampered({ reference });
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  assert.equal(await check(good.subarray(0, good.length - 1)), "unreadable: truncated");
  assert.equal(await check(Uint8Array.of(...good, 0)), "unreadable: trailing bytes");
  assert.equal(await check(new Uint8Array(0)), "unreadable: truncated");

  const legacy = Transaction.from(Buffer.from(good));
  const message = new TransactionMessage({
    payerKey: new PublicKey(PAYER),
    recentBlockhash: BLOCKHASH,
    instructions: legacy.instructions,
  }).compileToV0Message();
  assert.equal(await check(new VersionedTransaction(message).serialize()), "unreadable: not a legacy transaction");
});

test("a header that does not fit the keys, or an index past them, is unreadable", async () => {
  const { claim, reference } = newClaim();
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  const { keys, create, transfer } = expected(reference);
  const instructions = [create, transfer];
  // [required signers, read-only signers, read-only others] for nine keys.
  const headers = {
    "more signers than keys": [10, 0, 6],
    "more read-only signers than signers": [1, 2, 6],
    "more read-only others than other keys": [1, 0, 9],
  };
  const reasons = {};
  for (const [name, header] of Object.entries(headers)) reasons[name] = await check(raw({ keys, header, instructions }));
  assert.deepEqual(reasons, all(headers, "unreadable: bad header"));

  const outOfRange = {
    "the transfer's program": [create, { ...transfer, program: keys.length }],
    "the transfer's last account": [create, { ...transfer, accounts: [...transfer.accounts.slice(0, 4), keys.length] }],
  };
  const indexReasons = {};
  for (const [name, edited] of Object.entries(outOfRange)) indexReasons[name] = await check(raw({ keys, instructions: edited }));
  assert.deepEqual(indexReasons, all(outOfRange, "unreadable: bad account index"));
});

test("a length the runtime would not read is unreadable, in every length field", async () => {
  const { claim, reference } = newClaim();
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  const good = bytesOf(buildUnsignedTransaction({ payer: PAYER, payTo: PAY_TO, reference, blockhash: BLOCKHASH }));
  assert.equal(await check(good), null);
  // Where each compact-u16 sits: the signature count, the key count, the
  // instruction count, then each instruction's account count and data length.
  const at = { signatures: 0, keys: 1 + 64 + 3 };
  at.instructions = at.keys + 1 + 32 * good[at.keys] + 32;
  at.createAccounts = at.instructions + 2;
  at.createData = at.createAccounts + 1 + good[at.createAccounts];
  at.transferAccounts = at.createData + 1 + good[at.createData] + 1;
  at.transferData = at.transferAccounts + 1 + good[at.transferAccounts];
  const values = Object.fromEntries(Object.entries(at).map(([field, i]) => [field, good[i]]));
  assert.deepEqual(values, {
    signatures: 1,
    keys: 9,
    instructions: 2,
    createAccounts: 6,
    createData: 1,
    transferAccounts: 5,
    transferData: 10,
  });
  // The same value spelled another way, as the runtime's short_vec refuses it.
  const spellings = {
    "a zero second byte": [(n) => [n | 0x80, 0x00], "unreadable: non-canonical length"],
    "a zero third byte": [(n) => [n | 0x80, 0x80, 0x00], "unreadable: non-canonical length"],
    "a third byte above 3": [(n) => [n | 0x80, 0x80, 0x04], "unreadable: length out of range"],
    "a third byte that continues": [(n) => [n | 0x80, 0x80, 0x80], "unreadable: bad length"],
  };
  const reasons = {};
  const wanted = {};
  for (const [field, i] of Object.entries(at)) {
    for (const [name, [spell, reason]] of Object.entries(spellings)) {
      const respelled = Uint8Array.of(...good.subarray(0, i), ...spell(good[i]), ...good.subarray(i + 1));
      reasons[`${field}: ${name}`] = await check(respelled);
      wanted[`${field}: ${name}`] = reason;
    }
  }
  assert.deepEqual(reasons, wanted);
});

test("canonical two- and three-byte lengths still read, up to u16", async () => {
  const { claim, reference } = newClaim();
  const { keys, create, transfer } = expected(reference);
  for (const size of [128, 16_383, 16_384, 65_535]) {
    const long = { ...transfer, data: [...transfer.data, ...new Array(size - transfer.data.length).fill(0)] };
    const bytes = raw({ keys, instructions: [create, long] });
    assert.equal(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), "transfer", String(size));
  }
});
