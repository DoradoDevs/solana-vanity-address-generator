import { getStore as netlifyGetStore } from "@netlify/blobs";

/**
 * The payment ledger is append-only: one record per spent transaction,
 * written once and never changed. (The operator's refund tool in
 * web/scripts also records which transfer refunded a payment,
 * under refund-sent/ and refund-transfer/, the same way; no function reads
 * those.) `create` is the only write. It asks the
 * store to create the key only if it is absent, and reports whether it did.
 * Whether two concurrent requests can both win therefore depends on the
 * store deciding that atomically:
 *
 * - memoryStore below decides it in one synchronous step.
 * - Hosted Netlify Blobs documents `onlyIfNew` as an atomic, conditional
 *   write (see kb/README.md, "consume"). The suite cannot reach the hosted
 *   store; test/ledger.test.js proves the code against an atomic stand-in.
 * - Netlify's local BlobsServer, which `netlify dev` uses, is NOT atomic: it
 *   checks for the key and writes it across awaits, so concurrent spends
 *   there can all succeed. Never use it to judge single-spend.
 */

/** In-process ledger with the same contract. Used by the tests. */
export function memoryStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async create(key, value) {
      if (map.has(key)) return false;
      map.set(key, structuredClone(value));
      return true;
    },
  };
}

/**
 * Netlify Blobs. `onlyIfNew` makes the write conditional on the key being
 * absent, decided by the store itself.
 *
 * Reads are strongly consistent. The conditional write decides who wins, but
 * the winner's retry is told it won by reading the record back (consumeUnlock),
 * and verify reports a spent payment by reading it. A read served from an
 * edge cache could miss a record that exists and turn the winner's retry
 * into "reused".
 *
 * Throws when Blobs is not configured for this environment. There is no
 * fallback: a ledger that forgets is worse than an error.
 *
 * @param {{ getStore?: typeof netlifyGetStore }} [deps] for the contract test only
 */
export function blobStore({ getStore = netlifyGetStore } = {}) {
  const store = getStore({ name: "grind-payments", consistency: "strong" });
  return {
    async get(key) {
      return (await store.get(key, { type: "json" })) ?? null;
    },
    async create(key, value) {
      const result = await store.setJSON(key, value, { onlyIfNew: true });
      return result?.modified === true;
    },
  };
}

/** Ledger key for a spent payment. Transaction signatures are unique on chain. */
export function spentKey(signature) {
  return `spent/${signature}`;
}
