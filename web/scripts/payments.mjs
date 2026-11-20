#!/usr/bin/env node
/**
 * Operator tool for refund requests and for payments the old version left
 * unspent. DEPLOY.md, "Refund requests" and "Unspent payments from the old
 * version", says when and how to run it.
 *
 *   node web/scripts/payments.mjs check <signature>
 *   node web/scripts/payments.mjs mark-refunded <signature> [--sent <refund signature>]
 *   node web/scripts/payments.mjs old-payments --until <ISO time> [--since <ISO time>]
 *   node web/scripts/payments.mjs old-sol-payments [--until <ISO time>] [--since <ISO time>]
 *
 * It runs on the operator's machine with the operator's credentials, and
 * nowhere else. It lives outside netlify/functions, so it is never deployed
 * as an endpoint, and the page imports nothing from it. It moves no money and
 * holds no key. It writes only refund records: the mark that stops a payment
 * from being used, and which transfer refunded it.
 *
 * Every fact comes from the finalized transaction, the chain's history and
 * the ledger, never from whoever asked for the refund: that it is a payment
 * the page built, the wallet that paid it (where a refund goes), its age, and
 * whether a grind or an earlier refund used it.
 *
 * Where the tool cannot be sure, it says so and asks for a look by hand. It
 * never tells the operator to send money, or to send nothing, on a guess:
 * "send nothing" rests on a refund recorded with --sent (or, for the launch
 * versions' SOL payments, on the one exact pairing the chain allows), and
 * "send" on a payment with no transfer back to its wallet since it was made.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleepFor } from "node:timers/promises";
import { getStore as netlifyGetStore } from "@netlify/blobs";
import { PublicKey } from "@solana/web3.js";
import { isAddress, isSignature } from "../netlify/functions/lib/address.js";
import { assessTransaction } from "../netlify/functions/lib/assess.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PAY_TO,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_BASE_UNITS,
  USDC_DECIMALS,
  USDC_MINT,
} from "../netlify/functions/lib/constants.js";
import { createRpc as defaultCreateRpc, RpcError, SIGNATURE_LIMIT } from "../netlify/functions/lib/rpc.js";
import { blobStore, spentKey } from "../netlify/functions/lib/store.js";
import { associatedTokenAddress } from "../netlify/functions/lib/tx.js";

/**
 * How long a payment must have been on chain, unspent, before it is refunded.
 * Anyone can read a payment's signature off the chain and ask for its refund.
 * The money only ever goes back to the wallet that paid, so the asker gains
 * nothing, but a refund makes the payment unredeemable. Waiting a day gives
 * the customer who is still going to use it the time to do so.
 */
export const REFUND_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Where old-payments and old-sol-payments start unless told otherwise: 63308b0,
 * the first commit on any branch with the payment functions, made at
 * 2026-11-15T14:36:14Z (8d35fb7 merged it 48 seconds later). That is only as
 * early as the repository can see. A deploy from the command line publishes
 * the working tree, committed or not, so it can be older than any commit:
 * DEPLOY.md has the operator check Netlify's deploy list first, and pass an
 * earlier --since if it goes back further.
 */
export const LAUNCH_AT = Date.parse("2026-11-15T14:36:14Z");

export const REFUNDABLE = "REFUNDABLE";
/** Unlocked a grind: spent/<signature> in this version, or an old record that says consumed. */
export const USED = "USED";
/** Marked refunded, and the transfer that refunded it is recorded (--sent). Send nothing. */
export const REFUNDED = "REFUNDED";
/** Marked refunded, but no refund transfer is recorded for it: sent and not recorded, or never sent. */
export const MARKED = "MARKED";
/**
 * Unused and unmarked, but money went from the payee to the wallet that paid
 * after the payment, and no record says which payment that transfer refunded.
 * Never sent anything, never told to send nothing: decided by hand.
 */
export const MAYBE_REFUNDED = "MAYBE_REFUNDED";
/**
 * A launch-day SOL payment whose money went back: the wallet's only SOL
 * payment, and exactly its lamports went from the payee to that wallet after
 * it, once. Send nothing.
 */
export const SENT_BACK = "SENT_BACK";
/**
 * Not a payment the page built: not a finalized, successful transaction that
 * pays the payee exactly 1.00 USDC, or one that names no reference account (a
 * plain transfer, such as a tip to the same address).
 */
export const NOT_A_PAYMENT = "NOT_A_PAYMENT";
/** A payment, unspent, but less than REFUND_MIN_AGE_MS old. */
export const TOO_RECENT = "TOO_RECENT";
/**
 * A payment the tool cannot settle: no single wallet paid it, it has no time
 * or slot, the ledger holds a record under one of its accounts that the old
 * version could not have written, or a transaction it needs is not final yet.
 * Never marked by this tool.
 */
export const UNCLEAR = "UNCLEAR";
/**
 * SOL that reached the payee from someone else, naming a reference, in a
 * transaction that is not exactly what the launch versions built. Maybe a
 * payment, maybe not: decided by hand, never refunded on the tool's word.
 */
export const UNCLASSIFIED = "UNCLASSIFIED";

/** A mistake in how the tool was run: wrong arguments or missing settings. Exit code 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const STORE_LOOKUPS_AT_ONCE = 16;
const PROGRAMS = new Set([SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID]);
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/**
 * $1 in SOL as the launch versions could have asked it: their quote was
 * 1e9 / (SOL price in USD) lamports, and the repository does not hold the
 * day's price. This is $1 at any price from $50 to $1,000 a SOL. A SOL payment
 * outside it is not one they asked for, and is UNCLASSIFIED.
 */
export const LAUNCH_SOL_LAMPORTS = Object.freeze({ min: 1_000_000, max: 20_000_000 });

/** Ledger key of the transfer recorded as a payment's refund: refund-sent/<payment> -> { transfer, at }. */
export const refundSentKey = (payment) => `refund-sent/${payment}`;
/** Ledger key of the payment a transfer refunded: refund-transfer/<transfer> -> { payment, at }. One payment per transfer. */
export const refundTransferKey = (transfer) => `refund-transfer/${transfer}`;

const NOT_A_PAYMENT_WHY = {
  malformed: "the node's record of it is not a readable finalized transaction",
  failed: "it failed on chain, so no USDC moved",
  wrong_amount: "the payee's USDC did not grow by exactly 1.00",
  wrong_mint: "the payee received a token other than USDC",
  no_reference:
    "it names no reference account, so this site's page did not build it: every version adds one, read-only, to the transfer. A plain transfer to the same address, such as a tip, is not a payment",
};

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const pubkeyOf = (key) => (typeof key === "string" ? key : key?.pubkey);

/** The payee's USDC associated token account: where every payment the page builds is sent. */
export function payeeUsdcAccount(payTo) {
  return associatedTokenAddress(new PublicKey(USDC_MINT), new PublicKey(payTo)).toBase58();
}

/** Integer base units as a decimal amount, to the cent. */
export function formatUsdc(units) {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const cents = ((units % scale) * 100n) / scale;
  return `${units / scale}.${String(cents).padStart(2, "0")}`;
}

/**
 * Whether the transaction pays for one grind, by the server's own rule
 * (assess.js): a finalized record of a successful transaction after which the
 * payee's USDC accounts together hold exactly 1.00 USDC more. assessTransaction
 * also checks that the transaction names the reference it is asked about;
 * asking about its first account, which it names by definition, leaves every
 * other check as it is.
 */
function assessPayment(tx, { payTo, signature }) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => isAddress(pubkeyOf(key)))) {
    return { ok: false, reason: "malformed" };
  }
  return assessTransaction(tx, { payTo, reference: pubkeyOf(keys[0]), signature });
}

/** USDC balances by account index from one side of the token balances, or null when the list is unreadable. */
function usdcBalances(rows) {
  if (!Array.isArray(rows)) return null;
  const balances = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (!isPlainObject(row) || !Number.isInteger(row.accountIndex) || seen.has(row.accountIndex)) return null;
    seen.add(row.accountIndex);
    if (row.mint !== USDC_MINT) continue;
    const amount = row.uiTokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d{1,20}$/.test(amount)) return null;
    if (row.programId !== undefined && row.programId !== TOKEN_PROGRAM_ID) return null;
    balances.set(row.accountIndex, { owner: row.owner, amount: BigInt(amount) });
  }
  return balances;
}

/**
 * The wallet a refund goes to: the owner of the one token account, not the
 * payee's, whose USDC balance fell by exactly the price. Not the fee payer
 * and not whoever signed: whoever's USDC paid. When no single account did,
 * or its owner is missing or changed within the transaction, there is nobody
 * the tool can name, so `payer` is null and `why` says which.
 */
export function findPayer(tx, { payTo }) {
  const before = usdcBalances(tx?.meta?.preTokenBalances);
  const after = usdcBalances(tx?.meta?.postTokenBalances);
  if (!before || !after) return { payer: null, account: null, why: "its token balances are unreadable" };
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const debited = [];
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    const pre = before.get(index);
    const post = after.get(index);
    if ((post?.amount ?? 0n) - (pre?.amount ?? 0n) !== -USDC_BASE_UNITS) continue;
    // A balance cannot fall below zero, so a debited account always has a "before" row.
    const owner = pre && (!post || post.owner === pre.owner) ? pre.owner : null;
    if (owner === payTo) continue;
    debited.push({ owner, account: pubkeyOf(keys[index]) ?? null });
  }
  const price = formatUsdc(USDC_BASE_UNITS);
  if (debited.length === 0) return { payer: null, account: null, why: `no account outside the payee's lost exactly ${price} USDC` };
  if (debited.length > 1) return { payer: null, account: null, why: `more than one account lost exactly ${price} USDC` };
  const [{ owner, account }] = debited;
  if (!isAddress(owner)) {
    return { payer: null, account, why: "the owner of the account that paid is missing, or changed within the transaction" };
  }
  return { payer: owner, account, why: null };
}

/**
 * Accounts the transaction names that could be its reference: read-only,
 * not signers, and none of the programs, the mint, a sysvar or the payee.
 * For the report only. The ledger is searched under every account it names.
 */
export function referenceCandidates(tx, { payTo }) {
  const message = tx?.transaction?.message;
  const programs = new Set(PROGRAMS);
  for (const instruction of Array.isArray(message?.instructions) ? message.instructions : []) {
    if (typeof instruction?.programId === "string") programs.add(instruction.programId);
  }
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const readOnly = keys.filter((key) => typeof key === "string" || (key?.signer !== true && key?.writable !== true));
  return [...new Set(readOnly.map(pubkeyOf))].filter(
    (key) => key !== payTo && key !== USDC_MINT && !programs.has(key) && !key?.startsWith("Sysvar")
  );
}

/**
 * USDC base units gained (or, negative, lost) per owner over the
 * transaction, or null when the balances are unreadable or an account
 * changed owner within it.
 */
function usdcChangeByOwner(tx) {
  const before = usdcBalances(tx?.meta?.preTokenBalances);
  const after = usdcBalances(tx?.meta?.postTokenBalances);
  if (!before || !after) return null;
  const change = new Map();
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    const pre = before.get(index);
    const post = after.get(index);
    if (pre && post && pre.owner !== post.owner) return null;
    const owner = (pre ?? post).owner;
    if (!isAddress(owner)) return null;
    change.set(owner, (change.get(owner) ?? 0n) + (post?.amount ?? 0n) - (pre?.amount ?? 0n));
  }
  return change;
}

/**
 * A refund as --sent records it: a successful transaction in which the payee
 * loses exactly the price in USDC, `payer` gains exactly the price, and no
 * other wallet's USDC moves.
 */
export function isUsdcRefund(tx, { payTo, payer }) {
  if (!isPlainObject(tx?.meta) || tx.meta.err !== null) return false;
  const change = usdcChangeByOwner(tx);
  if (change === null || change.get(payTo) !== -USDC_BASE_UNITS || change.get(payer) !== USDC_BASE_UNITS) return false;
  return [...change].every(([owner, delta]) => owner === payTo || owner === payer || delta === 0n);
}

/**
 * Reads the chain for one run of the tool. Each account's history is listed
 * once, newest first, and only as far back as some payment needs; each
 * transaction is fetched once.
 */
function chainReader(rpc) {
  const listings = new Map();
  const transactions = new Map();
  return {
    /** The rows for `account` in `slot` or later, newest first. A row with no slot is kept: it cannot be placed. */
    async rowsFrom(account, slot) {
      let listing = listings.get(account);
      if (!listing) listings.set(account, (listing = { rows: [], before: undefined, done: false }));
      const reached = () => {
        const last = listing.rows.at(-1);
        return last !== undefined && Number.isSafeInteger(last.slot) && last.slot < slot;
      };
      while (!listing.done && !reached()) {
        const page = await rpc.getSignaturesForAddress(account, listing.before === undefined ? {} : { before: listing.before });
        listing.rows.push(...page);
        if (page.length < SIGNATURE_LIMIT) listing.done = true;
        else listing.before = page.at(-1).signature;
      }
      return listing.rows.filter((row) => !(Number.isSafeInteger(row.slot) && row.slot < slot));
    },
    transaction(signature) {
      if (!transactions.has(signature)) transactions.set(signature, rpc.getTransaction(signature));
      return transactions.get(signature);
    },
  };
}

/**
 * Every transfer of USDC, of any amount, from the payee to the wallet that
 * paid, landed in the payment's slot or later, that is not recorded as the
 * refund of some payment. Reads the history of the account that paid and of
 * the wallet's USDC associated account (where a transfer to the wallet lands)
 * from now back to the payment's slot; nothing older is listed or read.
 * `pending`: transactions of those accounts that are not final yet, so cannot
 * be read; `unreadable`: ones whose token balances cannot be read.
 */
async function transfersBack({ reader, store, payTo, report, slot }) {
  const found = { transfers: [], pending: [], unreadable: [] };
  const seen = new Set([report.signature]);
  for (const account of new Set([report.payerAccount, payeeUsdcAccount(report.payer)])) {
    for (const row of await reader.rowsFrom(account, slot)) {
      if (seen.has(row.signature)) continue;
      seen.add(row.signature);
      if (row.err !== null) continue;
      const tx = await reader.transaction(row.signature);
      if (tx === null) {
        found.pending.push(row.signature);
        continue;
      }
      if (tx.meta?.err !== null) continue;
      const change = usdcChangeByOwner(tx);
      if (change === null) {
        found.unreadable.push(row.signature);
        continue;
      }
      const gained = change.get(report.payer) ?? 0n;
      if (!((change.get(payTo) ?? 0n) < 0n && gained > 0n)) continue;
      // Recorded as some payment's refund: that payment's, whichever it is.
      if ((await store.get(refundTransferKey(row.signature))) !== null) continue;
      found.transfers.push({ signature: row.signature, amount: gained });
    }
  }
  return found;
}

/**
 * One top-level record of the old version (34623f1 and before), found under
 * one of the transaction's accounts. The old verify wrote
 * `reference -> { status: "paid", asset, signature, at }` once it had read the
 * payment `signature` naming that reference, and the old consume rewrote it
 * with status "consumed". So a record is about this payment only when its
 * signature is this one: a record under the same account naming another
 * signature is about another payment. A record of any other shape is nothing
 * the old version wrote, and nothing is concluded from it.
 */
function describeOldRecord(key, record, signature) {
  const readable =
    isPlainObject(record) && (record.status === "paid" || record.status === "consumed") && isSignature(record.signature);
  if (!readable) return { key, status: "unreadable", signature: null, ours: false };
  return { key, status: record.status, signature: record.signature, ours: record.signature === signature };
}

/** consumed: this payment unlocked a grind. paid: verified, never spent. unreadable: see UNCLEAR. */
function oldStateOf(records) {
  if (records.some((record) => record.ours && record.status === "consumed")) return "consumed";
  if (records.some((record) => record.status === "unreadable")) return "unreadable";
  if (records.some((record) => record.ours && record.status === "paid")) return "paid";
  return "none";
}

/**
 * What the ledger says about the payment: spent/<signature>, which this
 * version writes once (a grind, or a refund mark); the refund transfer
 * recorded for it, if any; and every old-version record under any account
 * the transaction names. The old verify accepted any address as a reference,
 * so a record may sit under any of them.
 */
async function readLedger(store, signature, keys) {
  const record = await store.get(spentKey(signature));
  let spent = null;
  if (record !== null) {
    spent = {
      state: record?.refunded === true ? "refunded" : "used",
      at: Number.isSafeInteger(record?.at) ? record.at : null,
      payer: typeof record?.payer === "string" ? record.payer : null,
    };
  }
  const sent = await store.get(refundSentKey(signature));
  const recorded = isSignature(sent?.transfer) ? sent.transfer : null;
  const unique = [...new Set(keys)];
  const old = [];
  for (let start = 0; start < unique.length; start += STORE_LOOKUPS_AT_ONCE) {
    const batch = unique.slice(start, start + STORE_LOOKUPS_AT_ONCE);
    const records = await Promise.all(batch.map((key) => store.get(key)));
    records.forEach((value, i) => {
      if (value !== null) old.push(describeOldRecord(batch[i], value, signature));
    });
  }
  return { spent, recorded, old, oldState: oldStateOf(old) };
}

const listTransfers = (transfers) => transfers.map(({ signature, amount }) => `${signature} (${formatUsdc(amount)} USDC)`).join(", ");

/** The report and verdict for a transaction already read at finalized (null when there is none). */
async function inspect({ tx, signature, store, payTo, now, reader }) {
  const report = {
    signature,
    finalized: tx !== null,
    succeeded: null,
    pays: false,
    reason: null,
    payer: null,
    payerAccount: null,
    payerWhy: null,
    references: [],
    blockTime: null,
    slot: null,
    spent: null,
    recorded: null,
    transfersBack: [],
    old: [],
    oldState: null,
    verdict: null,
    why: null,
  };
  const settle = (verdict, why) => Object.assign(report, { verdict, why });
  if (tx === null) {
    return settle(NOT_A_PAYMENT, "no finalized transaction has this signature: it is unknown, it never landed, or it is not final yet");
  }
  report.succeeded = isPlainObject(tx.meta) && "err" in tx.meta ? tx.meta.err === null : null;
  report.blockTime = Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null;
  report.slot = Number.isSafeInteger(tx.slot) ? tx.slot : null;
  const payment = assessPayment(tx, { payTo, signature });
  report.pays = payment.ok;
  if (!payment.ok) {
    report.reason = payment.reason;
    return settle(NOT_A_PAYMENT, NOT_A_PAYMENT_WHY[payment.reason] ?? payment.reason);
  }

  report.references = referenceCandidates(tx, { payTo });
  if (report.references.length === 0) {
    report.pays = false;
    report.reason = "no_reference";
    return settle(NOT_A_PAYMENT, NOT_A_PAYMENT_WHY.no_reference);
  }
  const payer = findPayer(tx, { payTo });
  Object.assign(report, { payer: payer.payer, payerAccount: payer.account, payerWhy: payer.why });
  const ledger = await readLedger(store, signature, tx.transaction.message.accountKeys.map(pubkeyOf));
  Object.assign(report, ledger);
  const lookBack = async () => {
    const found = await transfersBack({ reader, store, payTo, report, slot: report.slot });
    report.transfersBack = found.transfers.map(({ signature: transfer, amount }) => ({ signature: transfer, amount }));
    return found;
  };

  if (ledger.spent?.state === "refunded") {
    if (ledger.recorded) return settle(REFUNDED, `marked refunded, and ${ledger.recorded} is recorded as its refund. Send nothing`);
    const unrecorded = "marked refunded, but no refund transfer is recorded for it";
    if (!payer.payer || report.slot === null) {
      return settle(MARKED, `${unrecorded}, and the tool cannot look for one (${payer.payer ? "the node gave no slot for it" : payer.why}): look by hand`);
    }
    const found = await lookBack();
    if (found.pending.length > 0 || found.unreadable.length > 0) {
      return settle(MARKED, `${unrecorded}, and ${[...found.pending, ...found.unreadable].join(", ")}, of the wallet that paid, cannot be read yet: check again in a minute`);
    }
    if (found.transfers.length > 0) {
      return settle(
        MARKED,
        `${unrecorded}. Since the payment the payee sent the wallet that paid ${listTransfers(found.transfers)}: if one is its refund, record it with --sent; if none is, send the refund and record that`
      );
    }
    return settle(MARKED, `${unrecorded}, and nothing went to the wallet that paid since the payment: send the refund, then record it with --sent`);
  }
  if (ledger.spent) return settle(USED, "spent/<signature> records that it unlocked a grind");
  if (ledger.oldState === "consumed") return settle(USED, "the old version's record says it unlocked a grind");
  if (ledger.oldState === "unreadable") {
    return settle(UNCLEAR, "the ledger has a record under one of its accounts that the old version could not have written");
  }
  if (!payer.payer) return settle(UNCLEAR, `there is no single wallet to refund: ${payer.why}`);
  if (report.blockTime === null) return settle(UNCLEAR, "the node gave no time for it, so its age is unknown");
  if (report.slot === null) return settle(UNCLEAR, "the node gave no slot for it, so nothing can be placed after it");
  const eligibleAt = report.blockTime * 1000 + REFUND_MIN_AGE_MS;
  if (now < eligibleAt) {
    return settle(TOO_RECENT, `unspent, but it may be refunded only from ${new Date(eligibleAt).toISOString()}, 24 hours after it was paid`);
  }
  const found = await lookBack();
  if (found.pending.length > 0) {
    return settle(UNCLEAR, `a transaction of the wallet that paid, after the payment, is not final yet (${found.pending.join(", ")}), so whether money already went back is not known: check again in a minute`);
  }
  if (found.unreadable.length > 0) {
    return settle(UNCLEAR, `the token balances of ${found.unreadable.join(", ")}, a transaction of the wallet that paid after the payment, cannot be read, so whether money already went back is not known`);
  }
  if (found.transfers.length > 0) {
    return settle(
      MAYBE_REFUNDED,
      `nothing used it, but since the payment the payee sent the wallet that paid ${listTransfers(found.transfers)}, and no record says which payment that refunded. Decide by hand: if one is this payment's refund, record it with mark-refunded <signature> --sent <that transfer>; if none is, send the refund and record it the same way`
    );
  }
  return settle(REFUNDABLE, "a payment nothing has used, at least 24 hours old, and nothing went back to its wallet since");
}

/** Read the finalized transaction and the ledger, and give one verdict. Writes nothing. */
export async function checkPayment({ rpc, store, now, payTo, signature, reader = chainReader(rpc) }) {
  if (!isSignature(signature)) throw new UsageError("That is not a transaction signature.");
  const tx = await reader.transaction(signature);
  return inspect({ tx, signature, store, payTo, now, reader });
}

/** Why `transfer` (read at finalized) cannot be recorded as the refund of `report`'s payment, or null if it can. */
function refundProblem(transfer, report, payTo) {
  if (transfer === null) return "no finalized transaction has that signature: if it was just sent, wait a minute and run this again";
  if (!isUsdcRefund(transfer, { payTo, payer: report.payer })) {
    return `it does not move exactly ${formatUsdc(USDC_BASE_UNITS)} USDC from the payee to ${report.payer}, and nothing else`;
  }
  if (!Number.isSafeInteger(transfer.slot) || !(transfer.slot > report.slot)) return "it did not land after the payment";
  return null;
}

/**
 * Mark a payment refunded, so nothing can redeem it, and name the wallet to
 * send the refund to. Checks first and refuses anything but REFUNDABLE. The
 * mark is spent/<signature>, written with the same conditional create that
 * spends a payment for a grind: if anything wrote it since the check (a grind,
 * another refund), the create fails and so does this. Marking comes before the
 * refund is sent: once marked, verify and consume answer 409 "refunded" for
 * the payment, so it cannot be both refunded and used.
 *
 * With `sent`, records that transfer as the payment's refund, once it has
 * been sent: for a payment it marked (MARKED), or one whose money went back
 * by hand (MAYBE_REFUNDED, REFUNDABLE), which it marks first. The transfer
 * must be a finalized refund of exactly the price from the payee to the
 * wallet that paid, landed after the payment, and not already recorded for
 * another payment: refund-transfer/<transfer> is created once, so one transfer
 * answers one payment. That record, never a time or a guess, is what makes a
 * later check say "send nothing".
 */
export async function markRefunded({ rpc, store, now, payTo, signature, sent, reader = chainReader(rpc) }) {
  const report = await checkPayment({ rpc, store, now, payTo, signature, reader });
  const refuse = (why) => ({ marked: false, recorded: null, report, why });
  if (sent === undefined) {
    if (report.verdict !== REFUNDABLE) return refuse(`the verdict is ${report.verdict}, not ${REFUNDABLE}`);
    if (!(await store.create(spentKey(signature), { refunded: true, at: now, payer: report.payer }))) {
      return refuse("spent/<signature> was written by something else between the check and the mark. Nothing was marked: run check again");
    }
    return { marked: true, recorded: null, report, payer: report.payer, account: report.payerAccount };
  }

  if (!isSignature(sent)) throw new UsageError("--sent takes the refund's transaction signature.");
  if (report.verdict === REFUNDED) {
    if (report.recorded === sent) return { marked: false, recorded: sent, already: true, report, why: "that transfer is already recorded as its refund" };
    return refuse(`another transfer, ${report.recorded}, is already recorded as its refund`);
  }
  if (![REFUNDABLE, MAYBE_REFUNDED, MARKED].includes(report.verdict)) {
    return refuse(`the verdict is ${report.verdict}: a refund is recorded only for ${REFUNDABLE}, ${MAYBE_REFUNDED} or ${MARKED}`);
  }
  const problem = refundProblem(await reader.transaction(sent), report, payTo);
  if (problem) return refuse(`${sent} cannot be its refund: ${problem}. Nothing was written`);
  const holder = await store.get(refundTransferKey(sent));
  if (holder !== null && holder?.payment !== signature) {
    return refuse(`${sent} is already recorded as the refund of ${holder?.payment ?? "another payment"}. Nothing was written`);
  }

  let marked = false;
  if (report.verdict !== MARKED) {
    if (!(await store.create(spentKey(signature), { refunded: true, at: now, payer: report.payer }))) {
      return refuse("spent/<signature> was written by something else between the check and the mark. Nothing was written: run check again");
    }
    marked = true;
  }
  if (!(await store.create(refundTransferKey(sent), { payment: signature, at: now }))) {
    const taken = await store.get(refundTransferKey(sent));
    if (taken?.payment !== signature) {
      return { marked, recorded: null, report, why: `${sent} was recorded as the refund of ${taken?.payment ?? "another payment"} meanwhile. The payment is marked; its refund is not recorded: run check` };
    }
  }
  if (!(await store.create(refundSentKey(signature), { transfer: sent, at: now }))) {
    const first = await store.get(refundSentKey(signature));
    if (first?.transfer !== sent) {
      return { marked, recorded: sent, report, why: `${first?.transfer ?? "another transfer"} was recorded as its refund meanwhile, so it was refunded twice: ${sent} is recorded as one of them` };
    }
  }
  return { marked, recorded: sent, report, payer: report.payer, account: report.payerAccount };
}

/**
 * Every payment the old version received, judged as `check` judges it.
 *
 * Lists the payee's USDC account newest first, page by page, skipping what
 * landed at or after `until` (the moment this version was published) and
 * stopping at the first transaction older than `since`. Each successful one
 * in between is read; those that pay exactly 1.00 USDC to the payee are
 * yielded with their verdict. A listed transaction that cannot be read or
 * dated is yielded as UNCLEAR rather than skipped. Holds one page at a time.
 * `since` and `until` choose what is listed, nothing else: each payment's
 * verdict reads the chain from the payment to now, whatever they are.
 *
 * The chain is the list, not the ledger: the old version wrote a record only
 * once its verify succeeded, so a customer whose page gave up, or who closed
 * it, has none. `since` defaults to LAUNCH_AT. A transfer that names no
 * reference (a tip) is not a payment and is not yielded.
 */
export async function* oldPayments({ rpc, store, now, payTo, until, since = LAUNCH_AT, payeeAccount = payeeUsdcAccount(payTo) }) {
  if (!Number.isFinite(until)) throw new UsageError("--until is required.");
  if (until > now) throw new UsageError("--until is later than now. Run this after publishing, with --until set to the publish time.");
  if (!(since < until)) throw new UsageError("--since must be earlier than --until.");
  const unclear = (signature, why) => ({ signature, blockTime: null, payer: null, oldState: null, verdict: UNCLEAR, why });
  const reader = chainReader(rpc);

  let before;
  for (;;) {
    const rows = await rpc.getSignaturesForAddress(payeeAccount, before === undefined ? {} : { before });
    for (const row of rows) {
      if (!Number.isSafeInteger(row.blockTime)) {
        yield unclear(row.signature, "the node gave no time for it, so it cannot be placed before or after --until");
        continue;
      }
      const time = row.blockTime * 1000;
      if (time >= until) continue;
      if (time < since) return;
      if (row.err !== null) continue;
      const tx = await reader.transaction(row.signature);
      const report = await inspect({ tx, signature: row.signature, store, payTo, now, reader });
      if (report.verdict !== NOT_A_PAYMENT) {
        yield report;
      } else if (tx === null || report.reason === "malformed") {
        yield { ...report, verdict: UNCLEAR, why: `listed on the payee's account, but ${report.why}` };
      }
    }
    if (rows.length < SIGNATURE_LIMIT) return;
    before = rows[rows.length - 1].signature;
  }
}

/** Every row the node lists for `address`, newest first, down to the first one older than `since`. */
async function* history(rpc, address, since) {
  let before;
  for (;;) {
    const rows = await rpc.getSignaturesForAddress(address, before === undefined ? {} : { before });
    for (const row of rows) {
      if (Number.isSafeInteger(row.blockTime) && row.blockTime * 1000 < since) return;
      yield row;
    }
    if (rows.length < SIGNATURE_LIMIT) return;
    before = rows[rows.length - 1].signature;
  }
}

/** Lamports gained (or, negative, lost) per account, the fee paid back to the fee payer; null when unreadable. */
function lamportChanges(tx) {
  const keys = tx?.transaction?.message?.accountKeys;
  const pre = tx?.meta?.preBalances;
  const post = tx?.meta?.postBalances;
  const fee = tx?.meta?.fee;
  if (!Array.isArray(keys) || !Array.isArray(pre) || !Array.isArray(post) || pre.length !== keys.length || post.length !== keys.length) {
    return null;
  }
  if (!Number.isSafeInteger(fee) || ![...pre, ...post].every(Number.isSafeInteger)) return null;
  const change = new Map();
  keys.forEach((key, i) => {
    const address = pubkeyOf(key);
    change.set(address, (change.get(address) ?? 0) + post[i] - pre[i] + (i === 0 ? fee : 0));
  });
  return change;
}

/** The top-level SystemProgram transfers of a jsonParsed transaction: { source, destination, lamports }. */
function systemTransfers(tx) {
  const instructions = tx?.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions
    .filter((ix) => ix?.programId === SYSTEM_PROGRAM_ID && ix?.parsed?.type === "transfer")
    .map((ix) => ix.parsed.info)
    .filter((info) => isAddress(info?.source) && isAddress(info?.destination) && Number.isSafeInteger(info?.lamports) && info.lamports > 0)
    .map(({ source, destination, lamports }) => ({ source, destination, lamports }));
}

const SOL = (lamports) => (Number.isSafeInteger(lamports) ? `${Math.floor(lamports / 1e9)}.${String(lamports % 1e9).padStart(9, "0")}` : "unknown");

/**
 * Whether a successful transaction is SOL paid to the payee, measured
 * against what the launch versions built (8d35fb7 tx.js
 * buildUnsignedTransaction, and the wallet a Solana Pay link opened): one
 * SystemProgram transfer from the wallet that signed and paid the fee to the
 * payee, with one read-only reference account added to it, ComputeBudget
 * instructions at most beside it, of about $1.
 *
 * null: not SOL paid by someone else naming a reference, so not listed at
 * all. That is everything the payee signed itself (a swap, an unstake, a
 * transfer of its own), everything with no top-level transfer to the payee,
 * and plain transfers that name no reference (tips). Otherwise
 * `{ payer, lamports, problem }`, where `problem` is null for exactly the
 * launch shape and otherwise says how it differs: UNCLASSIFIED.
 */
export function solPayment(tx, { payTo }) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const payee = keys.find((key) => pubkeyOf(key) === payTo);
  if (!payee || payee.signer !== false) return null;
  const transfers = systemTransfers(tx).filter((transfer) => transfer.destination === payTo);
  if (transfers.length === 0 || transfers.some((transfer) => transfer.source === payTo)) return null;
  const references = referenceCandidates(tx, { payTo });
  if (references.length === 0) return null;

  const [{ source }] = transfers;
  const lamports = transfers.reduce((sum, transfer) => sum + transfer.lamports, 0);
  const result = (problem) => ({ payer: source, lamports, problem });
  if (transfers.length !== 1) return result("it pays the payee in more than one transfer");
  const feePayer = keys[0];
  if (pubkeyOf(feePayer) !== source || feePayer.signer !== true) return result("the SOL did not come from the wallet that signed it and paid its fee");
  const others = tx.transaction.message.instructions.filter(
    (ix) => !(ix?.programId === SYSTEM_PROGRAM_ID && ix?.parsed?.type === "transfer") && ix?.programId !== COMPUTE_BUDGET_PROGRAM_ID
  );
  if (others.length > 0) return result(`it runs more than a transfer: ${[...new Set(others.map((ix) => ix?.programId ?? "unknown"))].join(", ")}`);
  const inner = tx.meta?.innerInstructions;
  if (!Array.isArray(inner) || inner.some((set) => !Array.isArray(set?.instructions) || set.instructions.length > 0)) {
    return result("it calls other programs from within, or its inner instructions are unreadable");
  }
  if (references.length !== 1) return result(`it names ${references.length} accounts that could be its reference; the launch versions named one`);
  const expected = new Set([source, payTo, references[0], SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID]);
  if (keys.some((key) => !expected.has(pubkeyOf(key)))) return result("it names accounts the launch versions never added");
  const change = lamportChanges(tx);
  const moved = change && [...change].every(([address, delta]) => delta === (address === source ? -lamports : address === payTo ? lamports : 0));
  if (!moved) return result("SOL moved other than by the transfer");
  if (lamports < LAUNCH_SOL_LAMPORTS.min || lamports > LAUNCH_SOL_LAMPORTS.max) {
    return result(`${SOL(lamports)} SOL is not about $1, what the launch versions asked`);
  }
  return result(null);
}

/**
 * SOL payments taken by the launch versions (8d35fb7 to 7ec217c, the morning
 * of 2026-11-15, before 9b2480c charged USDC only), none of which this version
 * can redeem. Their old verify wrote
 * `reference -> { status: "paid", asset: "sol", signature }`, and their consume
 * changed the status to "consumed".
 *
 * Reads the payee wallet's history from now back to the earlier of `since`
 * and LAUNCH_AT, and yields each SOL payment (solPayment) made from `since` to
 * before `until`, with the lamports paid, the wallet that paid them, the old
 * record, and a verdict:
 * - UNCLASSIFIED: not exactly what the launch versions built. Look by hand.
 * - USED: the old record says consumed. UNCLEAR: an unreadable record, or no slot.
 * - REFUNDABLE: no SOL went from the payee to that wallet since the payment.
 * - SENT_BACK: it is that wallet's only SOL payment in the whole history read,
 *   and exactly once, after it, exactly its lamports went back to the wallet.
 * - MAYBE_REFUNDED: anything else went back to the wallet since: a different
 *   amount, more than one transfer, or a wallet with more than one SOL payment,
 *   where no transfer says which payment it answered. Look by hand.
 * The money that went back is read from the whole history, so the window
 * changes only what is listed. A transaction not final yet is yielded UNCLEAR.
 * Nothing is marked: no version still running accepts SOL.
 */
export async function* oldSolPayments({ rpc, store, now, payTo, until = now, since = LAUNCH_AT }) {
  if (until > now) throw new UsageError("--until is later than now.");
  if (!(since < until)) throw new UsageError("--since must be earlier than --until.");
  const rows = [];
  for await (const row of history(rpc, payTo, Math.min(since, LAUNCH_AT))) rows.push(row);
  const payments = [];
  const pending = [];
  const sentTo = new Map(); // wallet -> [{ signature, lamports, slot }]
  for (const row of rows.reverse()) {
    if (row.err !== null) continue;
    const tx = await rpc.getTransaction(row.signature);
    if (tx === null) {
      pending.push(row.signature);
      continue;
    }
    if (tx.meta?.err !== null) continue;
    const slot = Number.isSafeInteger(tx.slot) ? tx.slot : null;
    const payeeKey = tx.transaction?.message?.accountKeys?.find?.((key) => pubkeyOf(key) === payTo);
    if (payeeKey?.signer === true) {
      for (const transfer of systemTransfers(tx)) {
        if (transfer.source !== payTo || transfer.destination === payTo) continue;
        sentTo.set(transfer.destination, [...(sentTo.get(transfer.destination) ?? []), { signature: row.signature, lamports: transfer.lamports, slot }]);
      }
      continue;
    }
    const paid = solPayment(tx, { payTo });
    if (!paid) continue;
    const time = Number.isSafeInteger(tx.blockTime) ? tx.blockTime * 1000 : null;
    const ledger = await readLedger(store, row.signature, tx.transaction.message.accountKeys.map(pubkeyOf));
    payments.push({ signature: row.signature, blockTime: time === null ? null : tx.blockTime, time, slot, ...paid, oldState: ledger.oldState });
  }

  const listed = (time) => time === null || (time >= since && time < until);
  for (const signature of pending) {
    yield { signature, blockTime: null, lamports: null, payer: null, oldState: null, verdict: UNCLEAR, why: "not final yet, so it cannot be read: run this again in a minute" };
  }
  for (const { time, slot, problem, ...payment } of payments) {
    if (!listed(time)) continue;
    const report = { signature: payment.signature, blockTime: payment.blockTime, lamports: payment.lamports, payer: payment.payer, oldState: payment.oldState };
    if (problem) {
      yield { ...report, verdict: UNCLASSIFIED, why: `${problem}. It may not be a payment: look by hand, and send nothing on this tool's word` };
      continue;
    }
    if (payment.oldState === "consumed") {
      yield { ...report, verdict: USED, why: "the old version's record says it unlocked a grind" };
      continue;
    }
    if (payment.oldState === "unreadable") {
      yield { ...report, verdict: UNCLEAR, why: "the ledger has a record under one of its accounts that the old version could not have written" };
      continue;
    }
    if (slot === null) {
      yield { ...report, verdict: UNCLEAR, why: "the node gave no slot for it, so nothing can be placed after it" };
      continue;
    }
    const back = (sentTo.get(payment.payer) ?? []).filter((transfer) => transfer.slot === null || transfer.slot >= slot);
    if (back.length === 0) {
      yield { ...report, verdict: REFUNDABLE, why: `send ${SOL(payment.lamports)} SOL back to the wallet that paid` };
      continue;
    }
    const only = payments.filter((other) => other.payer === payment.payer).length === 1;
    const [transfer] = back;
    if (only && back.length === 1 && transfer.lamports === payment.lamports && transfer.slot > slot) {
      yield { ...report, sentBack: transfer.signature, verdict: SENT_BACK, why: `exactly that SOL went back to that wallet in ${transfer.signature}: send nothing` };
      continue;
    }
    const sent = back.map((other) => `${other.signature} (${SOL(other.lamports)} SOL)`).join(", ");
    yield {
      ...report,
      verdict: MAYBE_REFUNDED,
      why: `since this payment the payee sent that wallet ${sent}, and the wallet made ${only ? "only this" : "more than one"} SOL payment: which payment that answered cannot be told from the chain. Look by hand`,
    };
  }
}

/**
 * The same RPC, retrying a call that failed for a reason that passes: a
 * timeout, a dropped connection, HTTP 429 or a 5xx. Waits 1, 2 and 4
 * seconds between tries, then gives up with the last error. Anything else (a
 * bad answer, a refused request) fails at once. The operator's tool only:
 * the site's functions answer at once and let the page back off.
 */
export function retrying(rpc, { attempts = 4, sleep = sleepFor, delayMs = 1_000 } = {}) {
  const wrapped = {};
  for (const [name, method] of Object.entries(rpc)) {
    if (typeof method !== "function") continue;
    wrapped[name] = async (...args) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await method.apply(rpc, args);
        } catch (error) {
          const passing = error instanceof RpcError && /: (timeout|network|http 429|http 5\d\d)$/.test(error.message);
          if (!passing || attempt >= attempts) throw error;
          await sleep(delayMs * 2 ** (attempt - 1));
        }
      }
    };
  }
  return wrapped;
}

/**
 * The ledger, with the operator's site and token. store.js names the store
 * and asks for strong consistency; passing siteID and token also keeps
 * @netlify/blobs from reading either (or an edge URL) from
 * NETLIFY_BLOBS_CONTEXT. With no edge URL the client talks to the Netlify
 * API, which reads and writes the store itself rather than an edge cache.
 */
export function openStore({ siteID, token, getStore = netlifyGetStore }) {
  return blobStore({ getStore: (options) => getStore({ ...options, siteID, token }) });
}

// ---------------------------------------------------------------- command line

const USAGE = `Usage:
  node web/scripts/payments.mjs check <signature>
  node web/scripts/payments.mjs mark-refunded <signature> [--sent <refund signature>]
  node web/scripts/payments.mjs old-payments --until <ISO time> [--since <ISO time>]
  node web/scripts/payments.mjs old-sol-payments [--until <ISO time>] [--since <ISO time>]

--since defaults to ${new Date(LAUNCH_AT).toISOString()}, the first commit with the payment functions.
Reads SOLANA_RPC_URL, NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN from the environment.
See DEPLOY.md, "Refund requests".`;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(flag, value) {
  const ms = typeof value === "string" && ISO_TIME.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new UsageError(`${flag} takes an ISO time with its time zone, like 2026-11-20T15:04:05Z.`);
  return ms;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "check") {
    if (rest.length !== 1 || !isSignature(rest[0])) throw new UsageError(`${command} takes one transaction signature.`);
    return { command, signature: rest[0] };
  }
  if (command === "mark-refunded") {
    const [signature, flag, sent, ...extra] = rest;
    const plain = rest.length === 1;
    const recording = rest.length === 3 && flag === "--sent" && isSignature(sent) && extra.length === 0;
    if (!isSignature(signature) || !(plain || recording)) {
      throw new UsageError("mark-refunded takes one payment signature, and --sent <refund signature> once the refund is sent.");
    }
    return { command, signature, sent: recording ? sent : undefined };
  }
  if (command === "old-payments" || command === "old-sol-payments") {
    const times = {};
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      if ((flag !== "--until" && flag !== "--since") || flag in times || rest[i + 1] === undefined) {
        throw new UsageError(`${command} takes --until <ISO time> and --since <ISO time>.`);
      }
      times[flag] = parseTime(flag, rest[i + 1]);
    }
    if (command === "old-payments" && times["--until"] === undefined) {
      throw new UsageError("old-payments needs --until, the time this version was published.");
    }
    return { command, until: times["--until"], since: times["--since"] };
  }
  throw new UsageError(command === undefined ? "No command given." : "Unknown command.");
}

function readEnv(env) {
  const settings = {
    rpcUrl: (env.SOLANA_RPC_URL ?? "").trim(),
    siteID: (env.NETLIFY_SITE_ID ?? "").trim(),
    token: (env.NETLIFY_AUTH_TOKEN ?? "").trim(),
  };
  const missing = [
    ["SOLANA_RPC_URL", settings.rpcUrl],
    ["NETLIFY_SITE_ID", settings.siteID],
    ["NETLIFY_AUTH_TOKEN", settings.token],
  ]
    .filter(([, value]) => value === "")
    .map(([name]) => name);
  if (missing.length > 0) throw new UsageError(`Set ${missing.join(", ")} in this shell first.`);
  return settings;
}

/**
 * Everything printed passes through here. The token and the RPC URL, and
 * every part of the URL that may carry a key (path, query, host, user), are
 * replaced, whatever printed them: an error from a library included.
 */
function secretsOf({ rpcUrl, token }) {
  const parts = [rpcUrl, token];
  try {
    const url = new URL(rpcUrl);
    parts.push(url.host, url.hostname, url.username, url.password, url.pathname, url.search, url.hash);
    parts.push(...url.pathname.split("/"), ...url.searchParams.values(), ...url.searchParams.keys());
  } catch {
    // Not a URL: the whole value is already listed.
  }
  return [...new Set(parts.filter((part) => typeof part === "string" && part.length >= 6))].sort((a, b) => b.length - a.length);
}

function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets) result = result.split(secret).join("[redacted]");
  return result;
}

const timeOf = (blockTime) => (blockTime === null ? "unknown" : new Date(blockTime * 1000).toISOString());
const msTime = (ms) => (ms === null ? "an unknown time" : new Date(ms).toISOString());
const yesNo = (value) => (value === null ? "unknown" : value ? "yes" : "no");

function printReport(report, payTo, out) {
  const price = formatUsdc(USDC_BASE_UNITS);
  out(`Transaction ${report.signature}`);
  out(`  finalized:            ${yesNo(report.finalized)}`);
  if (report.finalized) {
    out(`  succeeded:            ${yesNo(report.succeeded)}`);
    out(`  pays ${price} USDC to the payee: ${report.pays ? "yes" : `no (${report.reason})`}`);
    out(`  time:                 ${timeOf(report.blockTime)}`);
  }
  if (report.pays) {
    out(`  paid by:              ${report.payer ? `${report.payer} (its USDC account ${report.payerAccount})` : `unknown: ${report.payerWhy}`}`);
    out(`  possible references:  ${report.references.length > 0 ? report.references.join(", ") : "none"}`);
    out("Ledger");
    let spent = "none";
    if (report.spent?.state === "used") spent = `used for a grind at ${msTime(report.spent.at)}`;
    if (report.spent?.state === "refunded") {
      spent = `marked refunded at ${msTime(report.spent.at)}, to ${report.spent.payer ?? "an unrecorded wallet"}`;
    }
    out(`  spent/<signature>:    ${spent}`);
    out(`  refund recorded:      ${report.recorded ?? "none"}`);
    if (report.old.length === 0) out("  old-version records:  none");
    for (const record of report.old) {
      const about =
        record.status === "unreadable"
          ? "a record the old version could not have written"
          : `${record.status}, ${record.ours ? "this payment" : `another payment (${record.signature})`}`;
      out(`  old-version record under ${record.key}: ${about}`);
    }
  }
  out(`Verdict: ${report.verdict}`);
  out(`  ${report.why}`);
  if (report.verdict === REFUNDABLE) {
    out(`  To refund it: mark-refunded ${report.signature}, send ${price} USDC from ${payTo} to ${report.payer}, then mark-refunded ${report.signature} --sent <that transfer's signature>.`);
  }
}

async function runOldPayments({ rpc, store, now, until, since = LAUNCH_AT }, out) {
  out(`Payments to ${PAY_TO}'s USDC account before ${msTime(until)}, from ${msTime(since)}.`);
  out("Listed: every one not used for a grind and not refunded with its refund recorded.");
  out("signature  time  paid-by  old-record  verdict");
  const counts = { listed: 0, [USED]: 0, [REFUNDED]: 0 };
  for await (const report of oldPayments({ rpc, store, now, payTo: PAY_TO, until, since })) {
    if (report.verdict === USED || report.verdict === REFUNDED) {
      counts[report.verdict] += 1;
      continue;
    }
    counts.listed += 1;
    out(
      [report.signature, timeOf(report.blockTime), report.payer ?? "unknown", report.oldState ?? "unknown", report.verdict].join("  ")
    );
    if (report.verdict !== REFUNDABLE) out(`  ${report.why}`);
  }
  out(`Listed ${counts.listed}. Not listed: ${counts[USED]} used for a grind, ${counts[REFUNDED]} refunded.`);
  out("REFUNDABLE: mark-refunded <signature>, send the refund, then mark-refunded <signature> --sent <its signature>. MARKED and MAYBE_REFUNDED: decide by hand, as each line says. UNCLEAR: look by hand.");
}

async function runOldSolPayments({ rpc, store, now, until = now, since = LAUNCH_AT }, out) {
  out(`SOL payments to ${PAY_TO} from ${msTime(since)} to ${msTime(until)} (the launch versions only took SOL).`);
  out("signature  time  paid-by  SOL  old-record  verdict");
  const counts = { listed: 0, [USED]: 0 };
  for await (const report of oldSolPayments({ rpc, store, now, payTo: PAY_TO, until, since })) {
    if (report.verdict === USED) {
      counts[USED] += 1;
      continue;
    }
    counts.listed += 1;
    out([report.signature, timeOf(report.blockTime), report.payer ?? "unknown", SOL(report.lamports), report.oldState ?? "unknown", report.verdict].join("  "));
    out(`  ${report.why}`);
  }
  out(`Listed ${counts.listed}. Not listed: ${counts[USED]} used for a grind.`);
  out("REFUNDABLE: send exactly the SOL listed, from the payee wallet to the wallet listed, then run this again. Send nothing for any other verdict without looking at it by hand.");
}

/**
 * The command line. Returns the exit code: 0 done (check and the lists
 * always; mark-refunded only when it marked or recorded), 1 refused or
 * failed, 2 usage.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    print = (line) => process.stdout.write(`${line}\n`),
    printError = (line) => process.stderr.write(`${line}\n`),
    now = Date.now,
    createRpc = defaultCreateRpc,
    getStore = netlifyGetStore,
    sleep = sleepFor,
  } = deps;
  let secrets = [];
  const out = (line) => print(redact(line, secrets));
  let command;
  try {
    const args = parseArgs(argv);
    command = args.command;
    const settings = readEnv(env);
    secrets = secretsOf(settings);
    const rpc = retrying(createRpc(settings.rpcUrl), { sleep });
    const store = openStore({ siteID: settings.siteID, token: settings.token, getStore });
    const at = now();

    if (command === "old-payments") {
      await runOldPayments({ rpc, store, now: at, until: args.until, since: args.since }, out);
      return 0;
    }
    if (command === "old-sol-payments") {
      await runOldSolPayments({ rpc, store, now: at, until: args.until, since: args.since }, out);
      return 0;
    }
    if (command === "check") {
      printReport(await checkPayment({ rpc, store, now: at, payTo: PAY_TO, signature: args.signature }), PAY_TO, out);
      return 0;
    }
    const result = await markRefunded({ rpc, store, now: at, payTo: PAY_TO, signature: args.signature, sent: args.sent });
    printReport(result.report, PAY_TO, out);
    if (result.already) {
      out(`${args.sent} is already recorded as its refund. Send nothing.`);
      return 0;
    }
    if (args.sent !== undefined) {
      if (result.recorded === null) {
        out(`Not recorded: ${result.why}.`);
        return 1;
      }
      if (result.why) out(`Note: ${result.why}.`);
      out(`Recorded ${result.recorded} as the refund of ${args.signature}${result.marked ? ", and marked it refunded" : ""}. Send nothing more for it.`);
      return 0;
    }
    if (!result.marked) {
      out(`Not marked: ${result.why}.`);
      return 1;
    }
    out(`Marked spent/${args.signature} refunded. verify and consume now refuse it.`);
    out(`Send exactly ${formatUsdc(USDC_BASE_UNITS)} USDC from the payee wallet ${PAY_TO} to:`);
    out(`  ${result.payer}`);
    out("That is the wallet whose USDC paid. Send to no other address, whoever asked.");
    out(`Then record it: mark-refunded ${args.signature} --sent <the transfer's signature>.`);
    return 0;
  } catch (error) {
    let message;
    if (error instanceof UsageError) message = `${error.message}\n\n${USAGE}`;
    else if (error instanceof RpcError) message = `The Solana RPC did not answer usefully (${error.message}), after retrying. Try again later.`;
    else message = `Stopped: ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
    if (command === "mark-refunded" && !(error instanceof UsageError)) {
      message += "\nThe mark or the refund record may or may not have been written. Run check before sending anything.";
    }
    printError(redact(message, secrets));
    return error instanceof UsageError ? 2 : 1;
  }
}

function invokedDirectly() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
