import { isSignature } from "./address.js";

/**
 * Minimal Solana JSON-RPC client for the payment functions.
 *
 * Every failure becomes an RpcError whose message names the method and a
 * short cause, and nothing else. The endpoint URL carries an API key, so it
 * never goes into an error, a log line, or a response. A response that is
 * not the shape the method promises is a failure too: callers get the value
 * they asked for or an exception, never something to guess at.
 */
export class RpcError extends Error {
  constructor(method, cause) {
    super(`${method}: ${cause}`);
    this.name = "RpcError";
  }
}

export const RPC_TIMEOUT_MS = 8_000;

/** The most signatures getSignaturesForAddress returns in one call. */
export const SIGNATURE_LIMIT = 1_000;


function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRpc(url, { fetch: fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  async function call(method, params) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RpcError(method, error?.name === "TimeoutError" ? "timeout" : "network");
    }
    if (!response.ok) throw new RpcError(method, `http ${response.status}`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new RpcError(method, "not json");
    }
    if (!isObject(data)) throw new RpcError(method, "bad response");
    if (data.error) {
      const code = Number.isInteger(data.error?.code) ? data.error.code : "unknown";
      throw new RpcError(method, `rpc error ${code}`);
    }
    if (!("result" in data)) throw new RpcError(method, "no result");
    return data.result;
  }

  return {
    /**
     * Newest first, at most SIGNATURE_LIMIT rows. Asks for "confirmed" so a
     * payment that has landed but is not final yet is visible as pending
     * instead of looking absent. With `before`, the page starts just older
     * than that signature: a full page is followed by asking again with the
     * oldest signature it returned.
     */
    async getSignaturesForAddress(address, { before } = {}) {
      const method = "getSignaturesForAddress";
      if (before !== undefined && !isSignature(before)) throw new RpcError(method, "bad cursor");
      const options = { limit: SIGNATURE_LIMIT, commitment: "confirmed", ...(before ? { before } : {}) };
      const rows = await call(method, [address, options]);
      if (!Array.isArray(rows)) throw new RpcError(method, "bad response");
      for (const row of rows) {
        if (!isObject(row) || !isSignature(row.signature) || !("err" in row)) {
          throw new RpcError(method, "bad response");
        }
      }
      return rows;
    },

    /**
     * Where each transaction stands, in the order asked for; null for one the
     * node has never seen. Searches past the recent-status cache, so a page
     * that comes back hours later still gets an answer.
     */
    async getSignatureStatuses(signatures) {
      const method = "getSignatureStatuses";
      const result = await call(method, [signatures, { searchTransactionHistory: true }]);
      const statuses = result?.value;
      if (!Array.isArray(statuses) || statuses.length !== signatures.length) {
        throw new RpcError(method, "bad response");
      }
      return statuses.map((status) => {
        if (status === null) return null;
        if (!isObject(status) || !("err" in status)) throw new RpcError(method, "bad response");
        const confirmationStatus = typeof status.confirmationStatus === "string" ? status.confirmationStatus : null;
        return { err: status.err, confirmationStatus };
      });
    },

    /** The finalized transaction, or null when it is not final (or not known) yet. */
    async getTransaction(signature) {
      const method = "getTransaction";
      const tx = await call(method, [
        signature,
        { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
      ]);
      if (tx !== null && !isObject(tx)) throw new RpcError(method, "bad response");
      return tx;
    },

    /** Account infos in the order asked for; null where the account does not exist. */
    async getMultipleAccounts(addresses) {
      const method = "getMultipleAccounts";
      const result = await call(method, [addresses, { encoding: "base64", commitment: "confirmed" }]);
      const accounts = result?.value;
      if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
        throw new RpcError(method, "bad response");
      }
      return accounts.map((account) => {
        if (account === null) return null;
        const encoded = Array.isArray(account?.data) ? account.data[0] : null;
        if (!Number.isSafeInteger(account?.lamports) || account.lamports < 0 || typeof encoded !== "string") {
          throw new RpcError(method, "bad response");
        }
        return {
          lamports: account.lamports,
          owner: account.owner,
          data: new Uint8Array(Buffer.from(encoded, "base64")),
        };
      });
    },

    async getLatestBlockhash() {
      const method = "getLatestBlockhash";
      const result = await call(method, [{ commitment: "confirmed" }]);
      const blockhash = result?.value?.blockhash;
      if (typeof blockhash !== "string" || blockhash.length < 32 || blockhash.length > 44) {
        throw new RpcError(method, "bad response");
      }
      return blockhash;
    },

    async getMinimumBalanceForRentExemption(space) {
      const method = "getMinimumBalanceForRentExemption";
      const lamports = await call(method, [space]);
      if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new RpcError(method, "bad response");
      return lamports;
    },
  };
}
