#!/usr/bin/env node
/**
 * Operator tool for refund requests and for payments the old version left
 * unspent. DEPLOY.md, "Refund requests" and "Unspent payments from the old
 * version", says when and how to run it.
 *
 *   node web/scripts/payments.mjs check <signature>
 *   node web/scripts/payments.mjs mark-refunded <signature>
 *   node web/scripts/payments.mjs old-payments --until <ISO time> [--since <ISO time>]
 *
 * It runs on the operator's machine with the operator's credentials, and
 * nowhere else. It lives outside netlify/functions, so it is never deployed
 * as an endpoint, and the page imports nothing from it. It moves no money and
 * holds no key. The one thing it writes is the refund mark, and only for a
 * payment it has just found unspent.
 *
 * Every fact comes from the finalized transaction and the ledger, never from
 * whoever asked for the refund: that it is a payment, the wallet that paid it
 * (where a refund goes), its age, and whether a grind or an earlier refund
 * used it.
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

export const REFUNDABLE = "REFUNDABLE";
/** Unlocked a grind: spent/<signature> in this version, or an old record that says consumed. */
export const USED = "USED";
/** spent/<signature> already holds a refund mark. */
export const REFUNDED = "REFUNDED";
/** Not a finalized, successful transaction that pays the payee exactly 1.00 USDC. */
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
  return [...new Set(readOnly.map(pubkeyOf))].filter((key) => key !== payTo && key !== USDC_MINT && !programs.has(key));
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
async function inspect({ tx, signature, store, payTo, now }) {
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

  const payer = findPayer(tx, { payTo });
  Object.assign(report, { payer: payer.payer, payerAccount: payer.account, payerWhy: payer.why });
  report.references = referenceCandidates(tx, { payTo });
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
  return inspect({ tx, signature, store, payTo, now });
}

/**
 * Mark a payment refunded, so nothing can redeem it, and name the wallet to
 * send the refund to. Checks first and refuses anything but REFUNDABLE. The
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
  if (report.verdict !== REFUNDABLE) {
    return { marked: false, report, why: `the verdict is ${report.verdict}, not ${REFUNDABLE}` };
  }
  const created = await store.create(spentKey(signature), { refunded: true, at: now, payer: report.payer });
  if (!created) {
    return {
      marked: false,
      report,
      why: "spent/<signature> was written by something else between the check and the mark. Nothing was marked: run check again",
    };
  }
  return { marked: true, report, payer: report.payer, account: report.payerAccount };
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
 * it, has none.
 */
export async function* oldPayments({ rpc, store, now, payTo, until, since, payeeAccount = payeeUsdcAccount(payTo) }) {
  if (!Number.isFinite(until)) throw new UsageError("--until is required.");
  if (until > now) throw new UsageError("--until is later than now. Run this after publishing, with --until set to the publish time.");
  if (since !== undefined && !(since < until)) throw new UsageError("--since must be earlier than --until.");
  const unclear = (signature, why) => ({ signature, blockTime: null, payer: null, oldState: null, verdict: UNCLEAR, why });

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
      if (since !== undefined && time < since) return;
      if (row.err !== null) continue;
      const tx = await rpc.getTransaction(row.signature);
      const report = await inspect({ tx, signature: row.signature, store, payTo, now });
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
  if (command === "old-payments") {
    const times = {};
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      if ((flag !== "--until" && flag !== "--since") || flag in times || rest[i + 1] === undefined) {
        throw new UsageError("old-payments takes --until <ISO time> and, optionally, --since <ISO time>.");
      }
      times[flag] = parseTime(flag, rest[i + 1]);
    }
    if (times["--until"] === undefined) throw new UsageError("old-payments needs --until, the time this version was published.");
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
}

async function runOldPayments({ rpc, store, now, until, since }, out) {
  out(`Payments to ${PAY_TO}'s USDC account before ${msTime(until)}${since === undefined ? "" : `, from ${msTime(since)}`}.`);
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
  out("Refund a listed payment with mark-refunded <signature>, then send it back. UNCLEAR ones need a look by hand.");
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
