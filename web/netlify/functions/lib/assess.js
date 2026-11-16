import { TOKEN_PROGRAM_ID, USDC_BASE_UNITS, USDC_MINT } from "./constants.js";

/** The node did not return the record a finalized transaction has. Nothing can be concluded from it. */
const MALFORMED = { ok: false, reason: "malformed" };

function pubkeyOf(key) {
  return typeof key === "string" ? key : key?.pubkey;
}

/**
 * Sum the payee's balance per mint from one side of the transaction's token
 * balances. Returns null when the list is not the shape the RPC promises:
 * an unreadable row is never treated as "no balance".
 */
function payeeTotals(rows, payTo) {
  if (!Array.isArray(rows)) return null;
  const totals = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return null;
    if (!Number.isInteger(row.accountIndex) || seen.has(row.accountIndex)) return null;
    seen.add(row.accountIndex);
    if (row.owner !== payTo) continue;
    const amount = row.uiTokenAmount?.amount;
    if (typeof row.mint !== "string" || typeof amount !== "string" || !/^\d{1,20}$/.test(amount)) return null;
    // USDC lives under the classic token program. A row that claims otherwise is not USDC.
    if (row.mint === USDC_MINT && row.programId !== undefined && row.programId !== TOKEN_PROGRAM_ID) return null;
    totals.set(row.mint, (totals.get(row.mint) ?? 0n) + BigInt(amount));
  }
  return totals;
}

/**
 * Decide whether a finalized jsonParsed transaction pays for one grind.
 *
 * Everything is read from what the chain recorded, in integer base units:
 * the transaction succeeded, it is the transaction that was asked for, it
 * names the reference, and across every USDC token account the payee owned
 * before and owns after, the payee ends up with exactly 1.00 USDC more.
 *
 * Summing over all of the payee's accounts, rather than looking at one,
 * means USDC that only moved between the payee's own accounts counts as
 * nothing, and USDC that went to an account somebody else owns is not seen
 * at all. Missing balance lists reject: with no "before", a transaction that
 * moved nothing would look like a payment of the whole balance.
 *
 * Reasons: "malformed" means the record is not what a node serves for a
 * finalized transaction (or is not the transaction asked for), so it says
 * nothing about the payment. "unrelated" means a readable transaction that
 * does not name the reference. "failed", "wrong_amount" and "wrong_mint" are
 * verdicts about the transaction itself.
 */
export function assessTransaction(tx, { payTo, reference, signature }) {
  const meta = tx?.meta;
  if (typeof meta !== "object" || meta === null || !("err" in meta)) return MALFORMED;
  if (signature !== undefined && tx.transaction?.signatures?.[0] !== signature) return MALFORMED;
  const keys = tx.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return MALFORMED;
  const before = payeeTotals(meta.preTokenBalances, payTo);
  const after = payeeTotals(meta.postTokenBalances, payTo);
  if (!before || !after) return MALFORMED;

  if (!keys.some((key) => pubkeyOf(key) === reference)) return { ok: false, reason: "unrelated" };
  if (meta.err !== null) return { ok: false, reason: "failed" };

  const gained = (mint) => (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n);
  if (gained(USDC_MINT) === USDC_BASE_UNITS) return { ok: true };

  for (const mint of after.keys()) {
    if (mint !== USDC_MINT && gained(mint) > 0n) return { ok: false, reason: "wrong_mint" };
  }
  return { ok: false, reason: "wrong_amount" };
}
