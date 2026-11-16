import { getStore } from "@netlify/blobs";

/**
 * The payment ledger is append-only: one record per spent transaction,
 * written once and never changed. `create` is the only write, and it either
 * creates the key or reports that it already existed. There is no
 * read-then-write anywhere, so two requests cannot both win.
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
 * absent, decided by the store itself. Reads are strongly consistent so a
 * spent payment is reported as spent straight away; correctness does not
 * depend on that, because the conditional write is what decides.
 *
 * Throws when Blobs is not configured for this environment. There is no
 * fallback: a ledger that forgets is worse than an error.
 */
export function blobStore() {
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
