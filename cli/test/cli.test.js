// The command-line grinder, end to end: the worker on its own, then the whole
// program driven through its prompts. Results are checked with OpenSSL (through
// node:crypto), which shares no code with the grinder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";

/** The address a Solana wallet derives from a Base58 private key, computed independently. */
function addressOf(privateKeyBase58) {
  const bytes = decodeBase58(privateKeyBase58);
  assert.equal(bytes.length, 64);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(bytes.subarray(0, 32))]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({
    format: "der",
    type: "spki",
  });
  const publicKey = new Uint8Array(spki.subarray(spki.length - 32));
  // The second half of a Solana secret key is the public key. Wallets reject a key where it is not.
  assert.deepEqual(bytes.subarray(32), publicKey);
  // The Solana CLI keypair file is the same 64 bytes as a JSON array.
  assert.deepEqual(Uint8Array.from(JSON.parse(JSON.stringify(Array.from(bytes)))), bytes);
  return encodeBase58(publicKey);
}

function runWorker(workerData) {
  const worker = new Worker(new URL("../worker.js", import.meta.url), { workerData });
  const messages = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cli worker timed out")), 30_000);
    worker.on("message", (message) => {
      messages.push(message);
      if (message.type === "found") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { worker, messages, done };
}

test("the worker finds a suffix, and its key imports to the address it reports", { timeout: 40_000 }, async () => {
  const { worker, messages, done } = runWorker({ pattern: "ab", position: "suffix", caseSensitive: false });
  try {
    const found = await done;
    assert.deepEqual(Object.keys(found).sort(), ["address", "attempts", "privateKey", "type"]);
    assert.equal(found.address.slice(-2).toLowerCase(), "ab");
    assert.equal(addressOf(found.privateKey), found.address);
    // Progress reports are counts. Only the match carries a key.
    for (const message of messages.filter((m) => m.type !== "found")) {
      assert.deepEqual(Object.keys(message).sort(), ["count", "type"]);
    }
    const counted = messages.reduce((sum, m) => sum + (m.count ?? m.attempts), 0);
    assert.ok(counted >= 1);
  } finally {
    await worker.terminate();
  }
});

test("the worker honours case-sensitive prefixes", { timeout: 40_000 }, async () => {
  const { worker, done } = runWorker({ pattern: "7", position: "prefix", caseSensitive: true });
  try {
    const found = await done;
    assert.ok(found.address.startsWith("7"), found.address);
    assert.equal(addressOf(found.privateKey), found.address);
  } finally {
    await worker.terminate();
  }
});

test("a worker started without a job fails loudly instead of grinding nothing", async () => {
  const worker = new Worker(new URL("../worker.js", import.meta.url), { workerData: { pattern: "", position: "suffix" } });
  const error = await new Promise((resolve) => worker.once("error", resolve));
  assert.match(error.message, /Missing workerData/);
});

test("the program asks its questions, grinds on several threads, prints one match and exits", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../index.js", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => child.kill(), 50_000);

  // Answer each prompt only once it has been asked, as a person would.
  const answers = [
    ["Enter desired pattern:", "0\n"], // not Base58: must be refused and asked again
    ["Enter desired pattern:", "ab\n"], // the same question, asked again
    ["Choice [1/2/3]:", "2\n"],
    ["Case sensitive? [y/N]:", "\n"],
    ["Worker threads [", "3\n"],
    ["Start grinding? [Y/n]:", "\n"],
  ];
  let cursor = 0;
  for (const [prompt, answer] of answers) {
    while (!out.slice(cursor).includes(prompt)) {
      if (child.exitCode !== null) assert.fail(`exited before "${prompt}":\n${out}\n${err}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    cursor = out.indexOf(prompt, cursor) + prompt.length;
    child.stdin.write(answer);
  }

  const { code } = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, `${out}\n${err}`);
  assert.equal(err, "");
  assert.match(out, /Invalid character\(s\): '0'/);
  assert.match(out, /Threads:\s+3/);
  assert.equal(out.match(/MATCH FOUND/g).length, 1);
  const address = out.match(/Address:\s+(\S+)/)[1];
  const privateKey = out.match(/Private Key:\s+(\S+)/)[1];
  assert.equal(address.slice(-2).toLowerCase(), "ab");
  assert.equal(addressOf(privateKey), address);
});
