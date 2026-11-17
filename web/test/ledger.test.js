// The spend ledger through the real consume function and the real
// @netlify/blobs client, against an edge that is atomic the way hosted
// Netlify Blobs documents its conditional writes to be.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import consume from "../netlify/functions/consume.mjs";
import { blobStore, spentKey } from "../netlify/functions/lib/store.js";
import { signUnlockToken } from "../netlify/functions/lib/token.js";
import { newSignature } from "./helpers/chain.js";
import { post, startAtomicBlobs } from "./helpers/servers.js";

const SECRET = "ledger-unlock-secret-0123456789";
let blobs;
const realLog = console.log;

before(async () => {
  blobs = await startAtomicBlobs();
  console.log = () => {};
});

after(async () => {
  console.log = realLog;
  await blobs.stop();
});

beforeEach(() => {
  blobs.connect();
  process.env.UNLOCK_SECRET = SECRET;
});

const spend = async (token) => {
  const response = await consume(post("/api/consume", { token }));
  return { status: response.status, body: await response.json() };
};

test("fifty different tokens for one payment, spent at once through Blobs: exactly one wins", async () => {
  const signature = newSignature();
  const tokens = Array.from({ length: 50 }, (_, i) => signUnlockToken({ signature, secret: SECRET, now: Date.now() + i }).token);
  assert.equal(new Set(tokens).size, 50);
  const puts = blobs.counts.puts;

  const results = await Promise.all(tokens.map(spend));

  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409 && r.body.reason === "reused").length, 49);
  // Every request went to the store as a conditional write, and the store refused all but one.
  assert.equal(blobs.counts.puts - puts, 50);
  const winner = tokens[results.findIndex((r) => r.status === 200)];
  // The winner asks again, as a page whose answer was lost does: same answer. Nobody else gets one.
  assert.equal((await spend(winner)).status, 200);
  for (const loser of tokens.filter((t) => t !== winner).slice(0, 5)) {
    assert.equal((await spend(loser)).status, 409);
  }
});

test("the winning token's retry is answered from the store itself, not from a cached miss", async () => {
  const signature = newSignature();
  const { token } = signUnlockToken({ signature, secret: SECRET, now: Date.now() });
  const store = blobStore();
  // verify reads the ledger before the spend, which is when an edge cache would remember a miss.
  assert.equal(await store.get(spentKey(signature)), null);
  assert.equal((await spend(token)).status, 200);
  // The answer was lost; the page sends the same token again.
  const retry = await spend(token);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(blobs.counts.cachedGets, 0);
});

test("blobStore opens the ledger strongly consistent and writes only if the key is new", async () => {
  const calls = [];
  const answers = [{ modified: true }, { modified: false }, undefined, { etag: "x" }];
  const getStore = (options) => {
    calls.push(["getStore", options]);
    return {
      async get(key, options) {
        calls.push(["get", key, options]);
        return null;
      },
      async setJSON(key, value, options) {
        calls.push(["setJSON", key, value, options]);
        return answers.shift();
      },
    };
  };
  const store = blobStore({ getStore });
  assert.deepEqual(calls[0], ["getStore", { name: "grind-payments", consistency: "strong" }]);
  assert.equal(await store.create("spent/a", { at: 1 }), true);
  // 412 or 409 from the store: the key existed, so this request did not win.
  assert.equal(await store.create("spent/a", { at: 2 }), false);
  // Anything that is not a clear "created" is not a win.
  assert.equal(await store.create("spent/a", { at: 3 }), false);
  assert.equal(await store.create("spent/a", { at: 4 }), false);
  for (const call of calls.filter(([name]) => name === "setJSON")) {
    assert.deepEqual(call[3], { onlyIfNew: true });
  }
  assert.equal(await store.get("spent/a"), null);
  assert.deepEqual(calls.at(-1), ["get", "spent/a", { type: "json" }]);
});
