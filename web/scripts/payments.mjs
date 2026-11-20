#!/usr/bin/env node
/**
 * Operator tool for refund requests and for payments the old version left
 * unspent. DEPLOY.md, "Refund requests" and "Unspent payments from the old
 * version", says when and how to run it.
 *
 *   node web/scripts/payments.mjs check <signature>
 *   node web/scripts/payments.mjs mark-refunded <signature>
 *   node web/scripts/payments.mjs old-payments --until <ISO time> [--since <ISO time>]
 *   node web/scripts/payments.mjs old-sol-payments [--until <ISO time>] [--since <ISO time>]
 *
 * It runs on the operator's machine with the operator's credentials, and
 * nowhere else. It lives outside netlify/functions, so it is never deployed
 * as an endpoint, and the page imports nothing from it. It moves no money and
 * holds no key. The one thing it writes is the refund mark, and only for a
 * payment it has just found unspent.
 *
 * Every fact comes from the finalized transaction, the chain's history and
 * the ledger, never from whoever asked for the refund: that it is a payment
 * the page built, the wallet that paid it (where a refund goes), its age,
 * whether a grind or an earlier refund used it, and whether the money already
 * went back by hand.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
 * The first moment anything could pay VanityGrinder: 8d35fb7, the launch
 * commit that first took payments, was committed at 2026-11-15T09:37:02-05:00,
 * and a deploy can only follow its commit. Lists go back no further unless
 * told to with --since.
 */
export const LAUNCH_AT = Date.parse("2026-11-15T14:37:02Z");

export const REFUNDABLE = "REFUNDABLE";
/** Unlocked a grind: spent/<signature> in this version, or an old record that says consumed. */
export const USED = "USED";
/** spent/<signature> already holds a refund mark. */
export const REFUNDED = "REFUNDED";
/**
 * Unspent and unmarked, but exactly the price already went back from the
 * payee to the wallet that paid, after the payment: refunded by hand. Send
 * nothing; mark-refunded records it.
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
 * A payment the tool cannot settle: no single wallet paid it, it has no
 * time, or the ledger holds a record under one of its accounts that the old
 * version could not have written. Never marked by this tool.
 */
export const UNCLEAR = "UNCLEAR";

/** A mistake in how the tool was run: wrong arguments or missing settings. Exit code 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const STORE_LOOKUPS_AT_ONCE = 16;
const PROGRAMS = new Set([SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID]);

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
 * not signers, and none of the programs, the mint or the payee. For the
 * report only. The ledger is searched under every account it names.
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

/** A successful transaction that moves exactly the price from the payee to `payer`. */
export function isUsdcRefund(tx, { payTo, payer }) {
  if (tx?.meta?.err !== null) return false;
  const change = usdcChangeByOwner(tx);
  return change !== null && change.get(payTo) === -USDC_BASE_UNITS && change.get(payer) === USDC_BASE_UNITS;
}

/**
 * Pair payments with the transfers that sent their money back. `events` are
 * one wallet's unused payments and its refunds, oldest first; a refund has
 * `at`, its time in ms (null if unknown), and a payment marked refunded has
 * `markedAt` and, when it was marked after a refund by hand, `sentIn`, that
 * refund. A marked payment takes the refund its mark names; otherwise, since
 * the runbook marks first and sends second, the first refund at or after its
 * mark. Every other refund goes to the oldest unmarked payment before it that
 * no refund answered yet. Returns payment signature -> refund signature.
 */
function pairRefunds(events) {
  const paired = new Map();
  const taken = new Set();
  for (const event of events) {
    if (event.kind !== "payment" || !event.sentIn) continue;
    if (!events.some((other) => other.kind === "refund" && other.signature === event.sentIn)) continue;
    taken.add(event.sentIn);
    paired.set(event.signature, event.sentIn);
  }
  events.forEach((event, i) => {
    if (event.kind !== "payment" || event.markedAt == null || paired.has(event.signature)) return;
    const refund = events.find((other, j) => j > i && other.kind === "refund" && !taken.has(other.signature) && other.at !== null && other.at >= event.markedAt);
    if (!refund) return;
    taken.add(refund.signature);
    paired.set(event.signature, refund.signature);
  });
  const waiting = [];
  for (const event of events) {
    if (event.kind === "payment") {
      if (event.markedAt == null) waiting.push(event.signature);
    } else if (!taken.has(event.signature) && waiting.length > 0) {
      paired.set(waiting.shift(), event.signature);
    }
  }
  return paired;
}

/** Every row the node lists for `address`, newest first, down to the first one older than `since`. */
async function* history(rpc, address, since) {
  let before;
  for (;;) {
    const rows = await rpc.getSignaturesForAddress(address, before === undefined ? {} : { before });
    for (const row of rows) {
      if (since !== undefined && Number.isSafeInteger(row.blockTime) && row.blockTime * 1000 < since) return;
      yield row;
    }
    if (rows.length < SIGNATURE_LIMIT) return;
    before = rows[rows.length - 1].signature;
  }
}

/**
 * For one paying wallet: which of its payments already got their money back
 * by hand. Reads the history of the account that paid and of the wallet's
 * USDC associated account (where a transfer to the wallet lands), from
 * `since` on: the wallet's payments that nothing used, and every transfer of
 * exactly the price from the payee to the wallet, paired oldest first. A
 * payment marked refunded takes its refund like any other.
 */
async function refundsSentBack({ rpc, store, payTo, payer, accounts, since }) {
  const seen = new Set();
  const rows = [];
  for (const account of new Set(accounts.filter(Boolean))) {
    for await (const row of history(rpc, account, since)) {
      if (seen.has(row.signature)) continue;
      seen.add(row.signature);
      rows.push(row);
    }
  }
  // Oldest first. Rows of two accounts are ordered by slot; one account's rows keep the node's order.
  rows.reverse();
  rows.sort((a, b) => (Number.isSafeInteger(a.slot) && Number.isSafeInteger(b.slot) ? a.slot - b.slot : 0));
  const events = [];
  for (const row of rows) {
    if (row.err !== null) continue;
    const tx = await rpc.getTransaction(row.signature);
    if (tx === null) continue;
    if (isUsdcRefund(tx, { payTo, payer })) {
      events.push({ kind: "refund", signature: row.signature, at: Number.isSafeInteger(tx.blockTime) ? tx.blockTime * 1000 : null });
      continue;
    }
    if (!assessPayment(tx, { payTo, signature: row.signature }).ok) continue;
    if (referenceCandidates(tx, { payTo }).length === 0) continue;
    if (findPayer(tx, { payTo }).payer !== payer) continue;
    const ledger = await readLedger(store, row.signature, tx.transaction.message.accountKeys.map(pubkeyOf));
    // Used for a grind, or not readable as anything: no refund is owed it, so none is paired with it.
    if (ledger.spent?.state === "used" || ledger.oldState === "consumed" || ledger.oldState === "unreadable") continue;
    const marked = ledger.spent?.state === "refunded";
    events.push({ kind: "payment", signature: row.signature, markedAt: marked ? (ledger.spent.at ?? 0) : null, sentIn: marked ? ledger.spent.sentBack : null });
  }
  return pairRefunds(events);
}

/** A lookup of hand refunds that reads each paying wallet's history once. */
function sentBackLookup({ rpc, store, payTo, since }) {
  const byPayer = new Map();
  return (report) => {
    if (!byPayer.has(report.payer)) {
      const ata = payeeUsdcAccount(report.payer); // the payer's own USDC associated account
      byPayer.set(report.payer, refundsSentBack({ rpc, store, payTo, payer: report.payer, accounts: [report.payerAccount, ata], since }));
    }
    return byPayer.get(report.payer).then((paired) => paired.get(report.signature) ?? null);
  };
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
 * version writes once (a grind, or a refund mark), and every old-version
 * record under any account the transaction names. The old verify accepted
 * any address as a reference, so a record may sit under any of them.
 */
async function readLedger(store, signature, keys) {
  const record = await store.get(spentKey(signature));
  let spent = null;
  if (record !== null) {
    spent = {
      state: record?.refunded === true ? "refunded" : "used",
      at: Number.isSafeInteger(record?.at) ? record.at : null,
      payer: typeof record?.payer === "string" ? record.payer : null,
      sentBack: isSignature(record?.sentBack) ? record.sentBack : null,
    };
  }
  const unique = [...new Set(keys)];
  const old = [];
  for (let start = 0; start < unique.length; start += STORE_LOOKUPS_AT_ONCE) {
    const batch = unique.slice(start, start + STORE_LOOKUPS_AT_ONCE);
    const records = await Promise.all(batch.map((key) => store.get(key)));
    records.forEach((value, i) => {
      if (value !== null) old.push(describeOldRecord(batch[i], value, signature));
    });
  }
  return { spent, old, oldState: oldStateOf(old) };
}

/** The report and verdict for a transaction already read at finalized (null when there is none). */
async function inspect({ tx, signature, store, payTo, now, sentBack = async () => null }) {
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
    sentBack: null,
    blockTime: null,
    spent: null,
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

  if (ledger.spent?.state === "refunded") return settle(REFUNDED, "spent/<signature> already marks it refunded");
  if (ledger.spent) return settle(USED, "spent/<signature> records that it unlocked a grind");
  if (ledger.oldState === "consumed") return settle(USED, "the old version's record says it unlocked a grind");
  if (ledger.oldState === "unreadable") {
    return settle(UNCLEAR, "the ledger has a record under one of its accounts that the old version could not have written");
  }
  if (!payer.payer) return settle(UNCLEAR, `there is no single wallet to refund: ${payer.why}`);
  if (report.blockTime === null) return settle(UNCLEAR, "the node gave no time for it, so its age is unknown");
  report.sentBack = await sentBack(report);
  if (report.sentBack) {
    return settle(
      SENT_BACK,
      `exactly ${formatUsdc(USDC_BASE_UNITS)} USDC already went back from the payee to the wallet that paid, in ${report.sentBack}: it was refunded by hand. Send nothing`
    );
  }
  const eligibleAt = report.blockTime * 1000 + REFUND_MIN_AGE_MS;
  if (now < eligibleAt) {
    return settle(TOO_RECENT, `unspent, but it may be refunded only from ${new Date(eligibleAt).toISOString()}, 24 hours after it was paid`);
  }
  return settle(REFUNDABLE, "a payment nothing has used, at least 24 hours old");
}

/** Read the finalized transaction and the ledger, and give one verdict. Writes nothing. */
export async function checkPayment({ rpc, store, now, payTo, signature }) {
  if (!isSignature(signature)) throw new UsageError("That is not a transaction signature.");
  const tx = await rpc.getTransaction(signature);
  return inspect({ tx, signature, store, payTo, now, sentBack: sentBackLookup({ rpc, store, payTo, since: LAUNCH_AT }) });
}

/**
 * Mark a payment refunded, so nothing can redeem it, and name the wallet to
 * send the refund to. Checks first and refuses anything but REFUNDABLE, and
 * SENT_BACK: a payment already refunded by hand is marked so it cannot be
 * used too, and `alreadySent` names the transfer, so nothing is sent again. The
 * mark is spent/<signature>, written with the same conditional create that
 * spends a payment for a grind: if anything wrote it since the check (a grind,
 * another refund), the create fails and so does this.
 *
 * Marking comes before the refund is sent. Once marked, verify and consume
 * answer 409 "refunded" for the payment, so it cannot be both refunded and
 * used.
 */
export async function markRefunded({ rpc, store, now, payTo, signature }) {
  const report = await checkPayment({ rpc, store, now, payTo, signature });
  if (report.verdict !== REFUNDABLE && report.verdict !== SENT_BACK) {
    return { marked: false, report, why: `the verdict is ${report.verdict}, not ${REFUNDABLE} or ${SENT_BACK}` };
  }
  const mark = { refunded: true, at: now, payer: report.payer, ...(report.sentBack ? { sentBack: report.sentBack } : {}) };
  const created = await store.create(spentKey(signature), mark);
  if (!created) {
    return {
      marked: false,
      report,
      why: "spent/<signature> was written by something else between the check and the mark. Nothing was marked: run check again",
    };
  }
  return { marked: true, report, payer: report.payer, account: report.payerAccount, alreadySent: report.sentBack };
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
  const sentBack = sentBackLookup({ rpc, store, payTo, since });

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
      const tx = await rpc.getTransaction(row.signature);
      const report = await inspect({ tx, signature: row.signature, store, payTo, now, sentBack });
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

const SOL = (lamports) => `${Math.floor(lamports / 1e9)}.${String(lamports % 1e9).padStart(9, "0")}`;

/**
 * SOL payments taken by the launch versions (8d35fb7 to 7ec217c, the morning
 * of 2026-11-15, before 9b2480c charged USDC only), none of which this version
 * can redeem. A SOL payment was a SystemProgram transfer to the payee wallet
 * with a read-only reference account; its old verify wrote
 * `reference -> { status: "paid", asset: "sol", signature }`, its consume
 * changed the status to "consumed".
 *
 * Reads the payee wallet's history from now back to `since` (LAUNCH_AT by
 * default). Yields every successful transaction before `until` after which
 * the payee holds more SOL and that names a reference: the lamports paid, the
 * wallet that paid them (the one account whose SOL fell by exactly that
 * much, fees aside), the old record, and a verdict. USED: the old record
 * says consumed. SENT_BACK: exactly those lamports later went from the payee
 * to that wallet. REFUNDABLE: neither. UNCLEAR: no single wallet paid it.
 * Nothing is marked: no version still running accepts SOL.
 */
export async function* oldSolPayments({ rpc, store, now, payTo, until = now, since = LAUNCH_AT }) {
  if (until > now) throw new UsageError("--until is later than now.");
  if (!(since < until)) throw new UsageError("--since must be earlier than --until.");
  const rows = [];
  for await (const row of history(rpc, payTo, since)) rows.push(row);
  rows.reverse();
  const payments = [];
  const events = new Map(); // payer -> [{ kind, signature, lamports }] oldest first
  const note = (payer, event) => events.set(payer, [...(events.get(payer) ?? []), event]);
  for (const row of rows) {
    if (row.err !== null) continue;
    const tx = await rpc.getTransaction(row.signature);
    if (tx === null || tx.meta?.err !== null) continue;
    const change = lamportChanges(tx);
    const gained = change?.get(payTo) ?? 0;
    if (gained < 0) {
      // Sent out by the payee: a refund to the one account that gained exactly what the payee gave, fee aside.
      const to = [...change.entries()].filter(([address, delta]) => address !== payTo && delta === -gained);
      if (to.length === 1) note(to[0][0], { kind: "refund", signature: row.signature, lamports: -gained });
      continue;
    }
    if (gained === 0) continue;
    const time = Number.isSafeInteger(tx.blockTime) ? tx.blockTime * 1000 : null;
    if (time !== null && time >= until) continue;
    if (referenceCandidates(tx, { payTo }).length === 0) continue;
    const paidBy = [...change.entries()].filter(([address, delta]) => address !== payTo && delta === -gained);
    const payer = paidBy.length === 1 ? paidBy[0][0] : null;
    const ledger = await readLedger(store, row.signature, tx.transaction.message.accountKeys.map(pubkeyOf));
    const report = { signature: row.signature, blockTime: time === null ? null : tx.blockTime, lamports: gained, payer, oldState: ledger.oldState };
    payments.push(report);
    if (payer && ledger.oldState !== "consumed") note(payer, { kind: "payment", signature: row.signature, lamports: gained });
  }
  const paired = new Map();
  for (const list of events.values()) {
    const byAmount = new Map();
    for (const event of list) byAmount.set(event.lamports, [...(byAmount.get(event.lamports) ?? []), event]);
    for (const same of byAmount.values()) for (const [payment, refund] of pairRefunds(same)) paired.set(payment, refund);
  }
  for (const report of payments) {
    if (report.oldState === "consumed") yield { ...report, verdict: USED, why: "the old version's record says it unlocked a grind" };
    else if (report.oldState === "unreadable") {
      yield { ...report, verdict: UNCLEAR, why: "the ledger has a record under one of its accounts that the old version could not have written" };
    } else if (!report.payer) yield { ...report, verdict: UNCLEAR, why: "no single wallet's SOL paid it" };
    else if (paired.has(report.signature)) {
      yield { ...report, sentBack: paired.get(report.signature), verdict: SENT_BACK, why: `the same SOL already went back to that wallet in ${paired.get(report.signature)}` };
    } else yield { ...report, verdict: REFUNDABLE, why: `send ${SOL(report.lamports)} SOL back to the wallet that paid` };
  }
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
  node web/scripts/payments.mjs mark-refunded <signature>
  node web/scripts/payments.mjs old-payments --until <ISO time> [--since <ISO time>]
  node web/scripts/payments.mjs old-sol-payments [--until <ISO time>] [--since <ISO time>]

--since defaults to the launch, 2026-11-15T14:37:02.000Z.
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
  if (command === "check" || command === "mark-refunded") {
    if (rest.length !== 1 || !isSignature(rest[0])) throw new UsageError(`${command} takes one transaction signature.`);
    return { command, signature: rest[0] };
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
  if (report.verdict === REFUNDABLE) out(`  To refund it: mark-refunded ${report.signature}, then send ${price} USDC from ${payTo} to ${report.payer}.`);
  if (report.verdict === SENT_BACK) out(`  Send nothing. To record it so it cannot be used: mark-refunded ${report.signature}.`);
}

async function runOldPayments({ rpc, store, now, until, since = LAUNCH_AT }, out) {
  out(`Payments to ${PAY_TO}'s USDC account before ${msTime(until)}, from ${msTime(since)}.`);
  out("Listed: every one not used for a grind and not already refunded.");
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
  out(`Listed ${counts.listed}. Not listed: ${counts[USED]} used for a grind, ${counts[REFUNDED]} already refunded.`);
  out("Refund a REFUNDABLE payment with mark-refunded <signature>, then send it back. SENT_BACK: send nothing, mark-refunded records it. UNCLEAR ones need a look by hand.");
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
    out([report.signature, timeOf(report.blockTime), report.payer ?? "unknown", SOL(report.lamports), report.oldState, report.verdict].join("  "));
    out(`  ${report.why}`);
  }
  out(`Listed ${counts.listed}. Not listed: ${counts[USED]} used for a grind.`);
  out("Send each REFUNDABLE one exactly the SOL listed, from the payee wallet to the wallet listed. Then run this again: each shows SENT_BACK.");
}

/**
 * The command line. Returns the exit code: 0 done (check and old-payments
 * always, mark-refunded only when it marked), 1 refused or failed, 2 usage.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    print = (line) => process.stdout.write(`${line}\n`),
    printError = (line) => process.stderr.write(`${line}\n`),
    now = Date.now,
    createRpc = defaultCreateRpc,
    getStore = netlifyGetStore,
  } = deps;
  let secrets = [];
  const out = (line) => print(redact(line, secrets));
  let command;
  try {
    const args = parseArgs(argv);
    command = args.command;
    const settings = readEnv(env);
    secrets = secretsOf(settings);
    const rpc = createRpc(settings.rpcUrl);
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
    const result = await markRefunded({ rpc, store, now: at, payTo: PAY_TO, signature: args.signature });
    printReport(result.report, PAY_TO, out);
    if (!result.marked) {
      out(`Not marked: ${result.why}.`);
      return 1;
    }
    out(`Marked spent/${args.signature} refunded. verify and consume now refuse it.`);
    if (result.alreadySent) {
      out(`It was already sent back in ${result.alreadySent}. Send nothing.`);
      return 0;
    }
    out(`Send exactly ${formatUsdc(USDC_BASE_UNITS)} USDC from the payee wallet ${PAY_TO} to:`);
    out(`  ${result.payer}`);
    out("That is the wallet whose USDC paid. Send to no other address, whoever asked.");
    return 0;
  } catch (error) {
    let message;
    if (error instanceof UsageError) message = `${error.message}\n\n${USAGE}`;
    else if (error instanceof RpcError) message = `The Solana RPC did not answer usefully (${error.message}). Try again.`;
    else message = `Stopped: ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
    if (command === "mark-refunded" && !(error instanceof UsageError)) {
      message += "\nThe mark may or may not have been written. Run check before sending anything.";
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
