// The page's check of the transfer the server built, attacked: each tampered
// transaction must be refused before a wallet is asked to sign it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
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
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import { buildUnsignedTransaction } from "../netlify/functions/lib/tx.js";
import { PAY_TO, USDC_MINT } from "../../shared/payment.js";
import { checkPreparedTransfer, isOnCurve, referenceOf, usdcAccountOf } from "../src/transfer-check.js";
import { PAYER, newClaim } from "./helpers/chain.js";

const BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const ATTACKER = Keypair.generate().publicKey.toBase58();
const OTHER_MINT = "So11111111111111111111111111111111111111112";

const ata = (owner, mint = USDC_MINT) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);

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
  transfer,
} = {}) {
  const payerKey = new PublicKey(payer);
  const mintKey = new PublicKey(mint);
  const destination = ata(payTo, mint);
  const tx = new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash: BLOCKHASH });
  for (const instruction of before) tx.add(instruction);
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payerKey, destination, new PublicKey(payTo), mintKey));
  const move = transfer ?? createTransferCheckedInstruction(source, mintKey, destination, payerKey, amount, decimals);
  move.keys.push({ pubkey: new PublicKey(reference), isSigner: false, isWritable: referenceWritable }, ...extraTransferKeys);
  tx.add(move);
  for (const instruction of after) tx.add(instruction);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

test("the curve test and the account derivation agree with @solana/web3.js and spl-token", async () => {
  for (let i = 0; i < 300; i++) {
    const bytes = new Uint8Array(randomBytes(32));
    assert.equal(isOnCurve(bytes), PublicKey.isOnCurve(bytes), Buffer.from(bytes).toString("hex"));
  }
  for (let i = 0; i < 50; i++) assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);

  const owners = [PAY_TO, PAYER, ATTACKER];
  for (let i = 0; i < 25; i++) owners.push(new PublicKey(randomBytes(32)).toBase58());
  for (const owner of owners) assert.equal(await usdcAccountOf(owner), ata(owner).toBase58(), owner);

  const { claim } = newClaim();
  assert.equal(await referenceOf(claim), referenceForClaim(claim));
});

test("the transfer prepare builds passes the page's check", async () => {
  const { claim, reference } = newClaim();
  const bytes = bytesOf(buildUnsignedTransaction({ payer: PAYER, payTo: PAY_TO, reference, blockhash: BLOCKHASH }));
  assert.equal(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), null);
  // The same bytes again through the test's own builder, so the variants below differ only where they say.
  assert.equal(await checkPreparedTransfer(tampered({ reference }), { payer: PAYER, claim }), null);
});

test("a transfer to anyone but the pinned payee is refused", async () => {
  const { claim, reference } = newClaim();
  const refused = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  assert.notEqual(await refused(tampered({ reference, payTo: ATTACKER })), null);
  // Created for the payee, paid somewhere else.
  const elsewhere = createTransferCheckedInstruction(
    ata(PAYER),
    new PublicKey(USDC_MINT),
    ata(ATTACKER),
    new PublicKey(PAYER),
    1_000_000n,
    6
  );
  assert.notEqual(await refused(tampered({ reference, transfer: elsewhere })), null);
});

test("any amount but exactly 1.00 USDC, or any other mint, is refused", async () => {
  const { claim, reference } = newClaim();
  const refused = async (options) => checkPreparedTransfer(tampered({ reference, ...options }), { payer: PAYER, claim });
  for (const amount of [0n, 999_999n, 1_000_001n, 100_000_000n, 18_446_744_073_709_551_615n]) {
    assert.equal(await refused({ amount }), "amount", String(amount));
  }
  assert.equal(await refused({ decimals: 0 }), "amount");
  assert.notEqual(await refused({ mint: OTHER_MINT }), null);
  // An unchecked Transfer of the right amount does not name the mint at all.
  const plain = createTransferInstruction(ata(PAYER), ata(PAY_TO), new PublicKey(PAYER), 1_000_000n);
  assert.notEqual(await refused({ transfer: plain }), null);
});

test("an extra instruction of any kind is refused, before or after the payment", async () => {
  const { claim, reference } = newClaim();
  const payer = new PublicKey(PAYER);
  const extras = [
    // Let the attacker spend the whole USDC balance later.
    createApproveInstruction(ata(PAYER), new PublicKey(ATTACKER), payer, 18_446_744_073_709_551_615n),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(ATTACKER), lamports: 1 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ];
  for (const extra of extras) {
    for (const place of ["before", "after"]) {
      const bytes = tampered({ reference, [place]: [extra] });
      assert.notEqual(await checkPreparedTransfer(bytes, { payer: PAYER, claim }), null, `${place} ${extra.programId}`);
    }
  }
});

test("another signer, another fee payer, or another source account is refused", async () => {
  const { claim, reference } = newClaim();
  const refused = async (options) => checkPreparedTransfer(tampered({ reference, ...options }), { payer: PAYER, claim });
  const cosigner = { pubkey: new PublicKey(ATTACKER), isSigner: true, isWritable: false };
  assert.equal(await refused({ extraTransferKeys: [cosigner] }), "signers");
  assert.notEqual(await refused({ feePayer: ATTACKER }), null);
  const otherAccount = new PublicKey(randomBytes(32));
  assert.notEqual(await refused({ source: otherAccount }), null);
});

test("the transfer must name this attempt's reference, read-only", async () => {
  const mine = newClaim();
  const theirs = newClaim();
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim: mine.claim });
  assert.notEqual(await check(tampered({ reference: theirs.reference })), null);
  assert.notEqual(await check(tampered({ reference: mine.reference, referenceWritable: true })), null);
  // A transfer for a different wallet than the one connected.
  const other = Keypair.generate().publicKey.toBase58();
  assert.notEqual(await check(tampered({ reference: mine.reference, payer: other })), null);
});

test("bytes that are not exactly one legacy transaction are refused", async () => {
  const { claim, reference } = newClaim();
  const good = tampered({ reference });
  const check = (bytes) => checkPreparedTransfer(bytes, { payer: PAYER, claim });
  assert.match(await check(good.subarray(0, good.length - 1)), /^unreadable/);
  assert.match(await check(Uint8Array.of(...good, 0)), /^unreadable/);
  assert.match(await check(new Uint8Array(0)), /^unreadable/);

  const legacy = Transaction.from(Buffer.from(good));
  const message = new TransactionMessage({
    payerKey: new PublicKey(PAYER),
    recentBlockhash: BLOCKHASH,
    instructions: legacy.instructions,
  }).compileToV0Message();
  assert.match(await check(new VersionedTransaction(message).serialize()), /^unreadable/);
});
