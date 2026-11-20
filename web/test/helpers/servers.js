// Local stand-ins for the two services the functions talk to: a Solana JSON-RPC
// node and Netlify Blobs. Both listen on a free port picked by the OS and never
// leave the machine.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { BlobsServer } from "@netlify/blobs/server";
import { PublicKey } from "@solana/web3.js";
import { encodeBase58 } from "../../../shared/base58.js";
import { TOKEN_PROGRAM_ID, USDC_MINT } from "../../netlify/functions/lib/constants.js";
import { associatedTokenAddress } from "../../netlify/functions/lib/tx.js";

export function ataOf(owner) {
  return associatedTokenAddress(new PublicKey(USDC_MINT), new PublicKey(owner)).toBase58();
}

function tokenAccountData(owner, amount) {
  const data = Buffer.alloc(165);
  new PublicKey(USDC_MINT).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = 1;
  return data;
}

/**
 * A mock RPC node with a little chain state.
 *   lamports: address -> SOL balance in lamports
 *   usdc:     owner address -> USDC base units held in that owner's associated account
 *   txs:      [{ tx, status }] oldest first, served like a real node serves them
 *   mode:     "ok" | "http500" | "rpcError" | "garbage" | "hang"
 */
export async function startRpc() {
  const state = { lamports: new Map(), usdc: new Map(), txs: [], calls: {}, mode: "ok" };

  const accountInfo = (address) => {
    for (const [owner, amount] of state.usdc) {
      if (ataOf(owner) === address) {
        return {
          lamports: 2_039_280,
          owner: TOKEN_PROGRAM_ID,
          executable: false,
          rentEpoch: 0,
          space: 165,
          data: [tokenAccountData(owner, amount).toString("base64"), "base64"],
        };
      }
    }
    if (!state.lamports.has(address)) return null;
    return {
      lamports: state.lamports.get(address),
      owner: "11111111111111111111111111111111",
      executable: false,
      rentEpoch: 0,
      space: 0,
      data: ["", "base64"],
    };
  };

  const methods = {
    getMultipleAccounts: ([addresses]) => ({ context: { slot: 1 }, value: addresses.map(accountInfo) }),
    getLatestBlockhash: () => ({
      context: { slot: 1 },
      value: { blockhash: encodeBase58(new Uint8Array(randomBytes(32))), lastValidBlockHeight: 151 },
    }),
    getMinimumBalanceForRentExemption: () => 2_039_280,
    getSignaturesForAddress: ([address, options]) => {
      if (options?.commitment !== "confirmed") throw new Error("expected commitment confirmed");
      const rows = state.txs
        .filter(({ tx, status }) => {
          if (status === "unseen" || status === "processed") return false;
          return tx.transaction.message.accountKeys.some((key) => key.pubkey === address);
        })
        .map(({ tx, status }) => ({
          signature: tx.transaction.signatures[0],
          slot: tx.slot,
          err: tx.meta.err,
          memo: null,
          blockTime: tx.blockTime,
          confirmationStatus: status,
        }))
        .reverse();
      // Like a node: at most `limit` rows, starting just older than `before`; an unknown `before` gives nothing.
      const start = options.before === undefined ? 0 : rows.findIndex((row) => row.signature === options.before) + 1;
      if (options.before !== undefined && start === 0) return [];
      return rows.slice(start, start + (options.limit ?? 1000));
    },
    getSignatureStatuses: ([signatures, options]) => {
      if (options?.searchTransactionHistory !== true) throw new Error("expected searchTransactionHistory");
      return {
        context: { slot: 1 },
        value: signatures.map((signature) => {
          const found = state.txs.find(({ tx }) => tx.transaction.signatures[0] === signature);
          if (!found || found.status === "unseen") return null;
          const { err } = found.tx.meta;
          return {
            slot: found.tx.slot,
            confirmations: found.status === "finalized" ? null : 1,
            err,
            status: err ? { Err: err } : { Ok: null },
            confirmationStatus: found.status,
          };
        }),
      };
    },
    getTransaction: ([signature, options]) => {
      if (options?.commitment !== "finalized" || options?.encoding !== "jsonParsed") {
        throw new Error("expected a finalized jsonParsed request");
      }
      const found = state.txs.find(({ tx }) => tx.transaction.signatures[0] === signature);
      return found && found.status === "finalized" ? found.tx : null;
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.calls[body.method] = (state.calls[body.method] || 0) + 1;
      if (state.mode === "hang") return;
      if (state.mode === "http500") {
        res.writeHead(500, { "content-type": "text/html" });
        return res.end(`<html>upstream error for ${state.url}</html>`);
      }
      if (state.mode === "garbage") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{ this is not json");
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (state.mode === "rpcError") {
        const error = { code: -32005, message: `rate limited for ${state.url}` };
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error }));
      }
      let payload;
      try {
        payload = { jsonrpc: "2.0", id: body.id, result: methods[body.method](body.params || []) };
      } catch (error) {
        payload = { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: error.message } };
      }
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The path and query stand in for a provider API key. Nothing may ever echo them.
  state.url = `http://127.0.0.1:${server.address().port}/v2/RPC-PATH-KEY?api-key=RPC-QUERY-KEY`;
  state.resetCalls = () => {
    state.calls = {};
  };
  state.totalCalls = () => Object.values(state.calls).reduce((a, b) => a + b, 0);
  state.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return state;
}

/**
 * Netlify's own local Blobs server, wired up the way the function runtime wires the real one.
 * Its conditional writes are not atomic (see startAtomicBlobs), so it proves the protocol,
 * not single-spend under concurrency.
 */
export async function startBlobs() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vg-blobs-"));
  const token = "local-blobs-token";
  const server = new BlobsServer({ directory, token });
  const { port } = await server.start();
  const context = {
    edgeURL: `http://127.0.0.1:${port}`,
    uncachedEdgeURL: `http://127.0.0.1:${port}`,
    siteID: "local-site",
    token,
  };
  const encoded = Buffer.from(JSON.stringify(context)).toString("base64");
  return {
    context: encoded,
    connect() {
      process.env.NETLIFY_BLOBS_CONTEXT = encoded;
    },
    disconnect() {
      delete process.env.NETLIFY_BLOBS_CONTEXT;
    },
    async stop() {
      delete process.env.NETLIFY_BLOBS_CONTEXT;
      await server.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A Netlify Blobs edge that is atomic, unlike Netlify's local BlobsServer
 * (whose put checks If-None-Match and then writes across awaits, so two
 * conditional writes can both succeed). It speaks the edge protocol the real
 * @netlify/blobs client uses: GET and PUT on /<siteID>/<store>/<key> with a
 * bearer token, and `if-none-match: *` answered with 412 when the key exists.
 * The check and the write happen together, synchronously, once the body has
 * been read, so exactly one conditional write per key can win.
 *
 * It listens twice. The uncached URL reads the store itself. The cached URL
 * is an edge cache in its worst documented state: each key's first answer is
 * kept, misses included, and served from then on. Writes always reach the
 * store. A client that reads through the cached URL can therefore miss a
 * record that exists, which is what strong consistency rules out.
 */
export async function startAtomicBlobs() {
  const token = "atomic-blobs-token";
  const siteID = "atomic-site";
  const records = new Map();
  const edgeCache = new Map();
  const counts = { cachedGets: 0, uncachedGets: 0, puts: 0, conflicts: 0 };
  let etags = 0;

  const read = (key) => (records.has(key) ? records.get(key) : null);
  const answer = (res, found) => {
    if (!found) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", etag: found.etag });
    res.end(found.body);
  };

  const handler = (cached) => (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end();
    }
    const key = decodeURIComponent(new URL(req.url, "http://edge").pathname);
    if (req.method === "GET") {
      if (!cached) {
        counts.uncachedGets += 1;
        return answer(res, read(key));
      }
      counts.cachedGets += 1;
      if (!edgeCache.has(key)) edgeCache.set(key, read(key));
      return answer(res, edgeCache.get(key));
    }
    if (req.method !== "PUT") {
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      // No await from here to the write: the existence check and the write are one step.
      counts.puts += 1;
      if (req.headers["if-none-match"] === "*" && records.has(key)) {
        counts.conflicts += 1;
        res.writeHead(412);
        return res.end();
      }
      const etag = `"${++etags}"`;
      records.set(key, { body: Buffer.concat(chunks), etag });
      res.writeHead(200, { etag });
      res.end();
    });
  };

  const listen = async (cached) => {
    const server = http.createServer(handler(cached));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  const uncached = await listen(false);
  const edge = await listen(true);
  const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;
  const encoded = Buffer.from(
    JSON.stringify({ edgeURL: urlOf(edge), uncachedEdgeURL: urlOf(uncached), siteID, token })
  ).toString("base64");

  return {
    counts,
    records,
    connect() {
      process.env.NETLIFY_BLOBS_CONTEXT = encoded;
    },
    async stop() {
      delete process.env.NETLIFY_BLOBS_CONTEXT;
      for (const server of [uncached, edge]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

/** A JSON POST the way the page sends it. */
export function post(path, body, headers = { "content-type": "application/json" }) {
  return new Request(`https://vanitygrinder.com${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
