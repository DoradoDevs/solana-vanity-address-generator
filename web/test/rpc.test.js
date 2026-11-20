import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcError, SIGNATURE_LIMIT, createRpc } from "../netlify/functions/lib/rpc.js";

const URL_WITH_KEY = "https://rpc.example/v2/PATH-KEY?api-key=QUERY-KEY";
const SIG = "5".repeat(88);

function rpcReturning(result) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  return { rpc: createRpc(URL_WITH_KEY, { fetch }), requests };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to throw");
}

test("requests carry the commitment each check depends on", async () => {
  const sigs = rpcReturning([]);
  await sigs.rpc.getSignaturesForAddress("Addr");
  assert.deepEqual(sigs.requests[0].body.params, ["Addr", { limit: SIGNATURE_LIMIT, commitment: "confirmed" }]);
  assert.equal(SIGNATURE_LIMIT, 1000);
  // The next page back starts just older than the oldest signature of the last one.
  await sigs.rpc.getSignaturesForAddress("Addr", { before: SIG });
  assert.deepEqual(sigs.requests[1].body.params, ["Addr", { limit: SIGNATURE_LIMIT, commitment: "confirmed", before: SIG }]);
  // A cursor that is not a signature never reaches the node.
  assert.match((await failure(sigs.rpc.getSignaturesForAddress("Addr", { before: "../x" }))).message, /bad cursor/);
  assert.equal(sigs.requests.length, 2);

  const statuses = rpcReturning({ context: { slot: 1 }, value: [null] });
  assert.deepEqual(await statuses.rpc.getSignatureStatuses([SIG]), [null]);
  assert.deepEqual(statuses.requests[0].body.params, [[SIG], { searchTransactionHistory: true }]);

  const tx = rpcReturning(null);
  assert.equal(await tx.rpc.getTransaction("Sig"), null);
  assert.deepEqual(tx.requests[0].body.params, [
    "Sig",
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ]);
  assert.ok(tx.requests[0].signal instanceof AbortSignal);
});

test("a hung node times out instead of holding the function open", async () => {
  const fetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const rpc = createRpc(URL_WITH_KEY, { fetch, timeoutMs: 30 });
  const started = Date.now();
  const error = await failure(rpc.getLatestBlockhash());
  assert.ok(error instanceof RpcError);
  assert.equal(error.message, "getLatestBlockhash: timeout");
  assert.ok(Date.now() - started < 2000);
});

test("no failure message ever contains the endpoint, whatever the transport or the node says", async () => {
  const cases = [
    async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${URL_WITH_KEY}`);
    },
    async () => new Response(`<html>bad gateway ${URL_WITH_KEY}</html>`, { status: 502 }),
    async () => new Response(`upstream ${URL_WITH_KEY}`, { status: 200 }),
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: `limit for ${URL_WITH_KEY}` } })),
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: `denied ${URL_WITH_KEY}` })),
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
    async () => new Response(JSON.stringify([URL_WITH_KEY])),
    async () => new Response("null"),
  ];
  const messages = [];
  for (const fetch of cases) {
    const error = await failure(createRpc(URL_WITH_KEY, { fetch }).getSignaturesForAddress("Addr"));
    assert.ok(error instanceof RpcError);
    assert.equal(error.cause, undefined);
    for (const part of ["rpc.example", "PATH-KEY", "QUERY-KEY", "api-key"]) {
      assert.equal(error.message.includes(part), false, error.message);
      assert.equal(String(error.stack).includes(part), false);
    }
    messages.push(error.message);
  }
  assert.deepEqual(messages, [
    "getSignaturesForAddress: network",
    "getSignaturesForAddress: http 502",
    "getSignaturesForAddress: not json",
    "getSignaturesForAddress: rpc error -32005",
    "getSignaturesForAddress: rpc error unknown",
    "getSignaturesForAddress: no result",
    "getSignaturesForAddress: bad response",
    "getSignaturesForAddress: bad response",
  ]);
});

test("a result of the wrong shape is a failure, not a value", async () => {
  const bad = async (method, result, ...args) => {
    const error = await failure(rpcReturning(result).rpc[method](...args));
    assert.equal(error.message, `${method}: bad response`, JSON.stringify(result));
  };
  await bad("getSignaturesForAddress", null, "A");
  await bad("getSignaturesForAddress", { value: [] }, "A");
  await bad("getSignaturesForAddress", [{ signature: 5, err: null }], "A");
  await bad("getSignaturesForAddress", [{ signature: SIG }], "A"); // no err field: success cannot be assumed
  await bad("getSignaturesForAddress", [SIG], "A");
  await bad("getSignaturesForAddress", [{ signature: "s", err: null }], "A"); // too short to be a signature
  await bad("getSignaturesForAddress", [{ signature: "0".repeat(88), err: null }], "A"); // not Base58
  await bad("getSignaturesForAddress", [{ signature: "../spent/x", err: null }], "A"); // would escape the ledger key
  await bad("getSignatureStatuses", [null], [SIG]);
  await bad("getSignatureStatuses", { value: [] }, [SIG]);
  await bad("getSignatureStatuses", { value: [{ confirmationStatus: "finalized" }] }, [SIG]); // no err: success cannot be assumed
  await bad("getSignatureStatuses", { value: ["finalized"] }, [SIG]);
  await bad("getTransaction", "tx", "S");
  await bad("getTransaction", [], "S");
  await bad("getMultipleAccounts", { value: [null] }, ["A", "B"]);
  await bad("getMultipleAccounts", { value: "x" }, ["A"]);
  await bad("getMultipleAccounts", [null], ["A"]);
  await bad("getMultipleAccounts", { value: [{ lamports: "5", data: ["", "base64"] }] }, ["A"]);
  await bad("getMultipleAccounts", { value: [{ lamports: -1, data: ["", "base64"] }] }, ["A"]);
  await bad("getMultipleAccounts", { value: [{ lamports: 1.5, data: ["", "base64"] }] }, ["A"]);
  await bad("getMultipleAccounts", { value: [{ lamports: 1, data: "AAAA" }] }, ["A"]);
  await bad("getLatestBlockhash", { value: {} });
  await bad("getLatestBlockhash", { value: { blockhash: 7 } });
  await bad("getMinimumBalanceForRentExemption", "2039280", 165);
  await bad("getMinimumBalanceForRentExemption", 0, 165);
});

test("well-formed results come back as plain values", async () => {
  const rows = [{ signature: SIG, err: null, confirmationStatus: "finalized" }];
  assert.deepEqual(await rpcReturning(rows).rpc.getSignaturesForAddress("A"), rows);

  const statuses = await rpcReturning({
    context: { slot: 1 },
    value: [{ slot: 9, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: "finalized" }, null],
  }).rpc.getSignatureStatuses([SIG, SIG]);
  assert.deepEqual(statuses, [{ err: null, confirmationStatus: "finalized" }, null]);

  const data = Buffer.from([1, 2, 3]).toString("base64");
  const accounts = await rpcReturning({
    context: { slot: 1 },
    value: [{ lamports: 5000, owner: "Owner", data: [data, "base64"] }, null],
  }).rpc.getMultipleAccounts(["A", "B"]);
  assert.deepEqual(accounts, [{ lamports: 5000, owner: "Owner", data: new Uint8Array([1, 2, 3]) }, null]);

  const blockhash = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  assert.equal(await rpcReturning({ value: { blockhash } }).rpc.getLatestBlockhash(), blockhash);
  assert.equal(await rpcReturning(2_039_280).rpc.getMinimumBalanceForRentExemption(165), 2_039_280);
});
