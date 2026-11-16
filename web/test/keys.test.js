// Key generation, checked against things that are not this project's code:
// the RFC 8032 test vectors, OpenSSL (through node:crypto), and @solana/web3.js,
// which is what wallets and the Solana CLI format are built on.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BASE58_ALPHABET, decodeBase58, encodeBase58 } from "../../shared/base58.js";
import { validatePattern } from "../../shared/grind-math.js";
import { matchesAddress } from "../../shared/match.js";
import { assembleSecretKey } from "../../shared/secret.js";

const hex = (text) => Uint8Array.from(Buffer.from(text, "hex"));

// RFC 8032 section 7.1, tests 1 to 3: 32-byte secret key (the seed) and its public key.
const RFC8032 = [
  ["9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"],
  ["4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"],
  ["c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025"],
];

/** The Ed25519 public key for a seed, computed by OpenSSL rather than by @noble/curves. */
function opensslPublicKey(seed) {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({
    format: "der",
    type: "spki",
  });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** What a user does with a result: import the Base58 private key, or save it as a Solana CLI keypair file. */
function importsAs(privateKeyBase58) {
  const bytes = decodeBase58(privateKeyBase58);
  assert.equal(bytes.length, 64);
  // fromSecretKey re-derives the public key from the seed and throws if the two halves disagree.
  const fromBase58 = Keypair.fromSecretKey(bytes);
  const keypairFile = JSON.stringify(Array.from(bytes));
  const fromFile = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairFile)));
  assert.equal(fromFile.publicKey.toBase58(), fromBase58.publicKey.toBase58());
  assert.deepEqual(opensslPublicKey(bytes.subarray(0, 32)), bytes.subarray(32));
  return fromBase58.publicKey.toBase58();
}

test("the derivation reproduces the RFC 8032 vectors, and OpenSSL and web3.js agree", () => {
  for (const [seedHex, publicHex] of RFC8032) {
    const seed = hex(seedHex);
    const pub = ed25519.getPublicKey(seed);
    assert.equal(Buffer.from(pub).toString("hex"), publicHex);
    assert.deepEqual(opensslPublicKey(seed), pub);
    assert.deepEqual(Keypair.fromSeed(seed).publicKey.toBytes(), pub);
  }
});

test("a known seed exports as the Solana keypair every wallet imports to the same address", () => {
  const seed = hex(RFC8032[0][0]);
  const pub = ed25519.getPublicKey(seed);
  const address = encodeBase58(pub);
  assert.equal(address, "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
  const exported = assembleSecretKey(seed, pub);
  assert.deepEqual(decodeBase58(exported), Keypair.fromSeed(seed).secretKey);
  assert.equal(importsAs(exported), address);
  // The caller's seed is left alone; wiping it is the caller's job.
  assert.equal(Buffer.from(seed).toString("hex"), RFC8032[0][0]);
  assert.throws(() => assembleSecretKey(seed.subarray(0, 31), pub), /32-byte/);
});

test("Base58 matches the encoding Solana uses, leading zeros included", () => {
  assert.equal(BASE58_ALPHABET.length, 58);
  assert.equal(new Set(BASE58_ALPHABET).size, 58);
  for (const excluded of "0OIl") assert.equal(BASE58_ALPHABET.includes(excluded), false);

  const samples = Array.from({ length: 300 }, () => new Uint8Array(randomBytes(32)));
  for (let zeros = 1; zeros <= 4; zeros++) {
    const bytes = new Uint8Array(randomBytes(32));
    bytes.fill(0, 0, zeros);
    samples.push(bytes);
  }
  samples.push(new Uint8Array(32), new Uint8Array(32).fill(255));
  for (const bytes of samples) {
    const text = encodeBase58(bytes);
    assert.equal(text, new PublicKey(bytes).toBase58());
    assert.deepEqual(decodeBase58(text), bytes);
    assert.deepEqual(validatePattern(text), []);
    assert.ok(text.length >= 32 && text.length <= 44);
  }
  assert.equal(encodeBase58(hex("0000287fb4cd")), "11233QC4");
  assert.deepEqual(decodeBase58("11233QC4"), hex("0000287fb4cd"));
});

test("matching agrees with a plain reference for every position and both case rules", () => {
  const lower = (text) => text.toLowerCase();
  const reference = (address, pattern, position, caseSensitive) => {
    const a = caseSensitive ? address : lower(address);
    const p = caseSensitive ? pattern : lower(pattern);
    if (position === "prefix") return a.startsWith(p);
    if (position === "suffix") return a.endsWith(p);
    if (position === "prefix-or-suffix") return a.startsWith(p) || a.endsWith(p);
    return a.includes(p);
  };
  const flip = (ch) => (ch === lower(ch) ? ch.toUpperCase() : lower(ch));
  let hits = 0;
  for (let i = 0; i < 400; i++) {
    const address = encodeBase58(new Uint8Array(randomBytes(32)));
    const at = Math.floor(Math.random() * (address.length - 3));
    const cut = address.slice(at, at + 1 + (i % 3));
    const patterns = [
      cut,
      [...cut].map(flip).join(""),
      address.slice(0, 2),
      lower(address.slice(0, 2)),
      address.slice(-2),
      address.slice(-2).toUpperCase(),
      address,
      BASE58_ALPHABET[i % 58] + BASE58_ALPHABET[(i * 7) % 58],
    ];
    for (const pattern of patterns) {
      for (const position of ["prefix", "suffix", "prefix-or-suffix", "anywhere"]) {
        for (const caseSensitive of [true, false]) {
          const expected = reference(address, pattern, position, caseSensitive);
          assert.equal(
            matchesAddress(address, pattern, position, caseSensitive),
            expected,
            `${address} ${pattern} ${position} ${caseSensitive}`
          );
          if (expected) hits += 1;
        }
      }
    }
  }
  assert.ok(hits > 1000);
  const address = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";
  assert.equal(matchesAddress(address, address + "1", "anywhere", false), false);
  assert.equal(matchesAddress(address, "", "anywhere", false), false);
  assert.equal(matchesAddress(address, "6AS", "sideways", true), false);
});

/** Drive the real browser grind worker, in a worker thread that stands in for the browser. */
function browserWorker() {
  const worker = new Worker(new URL("./helpers/browser-worker-host.js", import.meta.url), {
    workerData: { module: new URL("../src/grind-worker.js", import.meta.url).href },
  });
  const messages = [];
  const waiters = [];
  worker.on("message", (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) waiter();
  });
  const until = (predicate, ms = 30_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("grind worker timed out")), ms);
      const check = () => {
        const found = messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(check), 1);
        resolve(found);
      };
      waiters.push(check);
      check();
    });
  return { worker, messages, until, send: (data) => worker.postMessage(data) };
}

test("the browser grind worker returns keys that import to the address it reports", { timeout: 60_000 }, async () => {
  const { worker, messages, until, send } = browserWorker();
  try {
    await until((m) => m.type === "ready");
    send({ pattern: "ab", position: "suffix", caseSensitive: false });
    // It keeps going after a match, so one run can collect several.
    await until(() => messages.filter((m) => m.type === "found").length >= 3);
    send({ command: "stop" });

    const found = messages.filter((m) => m.type === "found");
    for (const match of found) {
      assert.deepEqual(Object.keys(match).sort(), ["address", "attempts", "privateKey", "type"]);
      assert.equal(match.address.slice(-2).toLowerCase(), "ab");
      assert.equal(importsAs(match.privateKey), match.address);
      assert.ok(Number.isInteger(match.attempts) && match.attempts >= 1);
    }
    assert.equal(new Set(found.map((m) => m.privateKey)).size, found.length);

    // Nothing but a match carries key material. Progress is a count and no more.
    for (const message of messages.filter((m) => m.type !== "found")) {
      assert.ok(["ready", "progress"].includes(message.type), message.type);
      if (message.type === "progress") assert.deepEqual(Object.keys(message).sort(), ["count", "type"]);
    }
    const tried = messages.reduce((sum, m) => sum + (m.count ?? m.attempts ?? 0), 0);
    assert.ok(tried >= found.length);
  } finally {
    await worker.terminate();
  }
});

test("the worker respects the case rule, measures without leaking keys, and rejects bad settings", { timeout: 60_000 }, async () => {
  const strict = browserWorker();
  try {
    await strict.until((m) => m.type === "ready");
    strict.send({ pattern: "Z", position: "prefix-or-suffix", caseSensitive: true });
    const match = await strict.until((m) => m.type === "found");
    assert.ok(match.address.startsWith("Z") || match.address.endsWith("Z"), match.address);
    assert.equal(importsAs(match.privateKey), match.address);
  } finally {
    await strict.worker.terminate();
  }

  const bench = browserWorker();
  try {
    await bench.until((m) => m.type === "ready");
    bench.send({ command: "bench", ms: 1500 });
    const result = await bench.until((m) => m.type === "bench");
    assert.deepEqual(Object.keys(result).sort(), ["count", "keysPerSec", "ms", "type"]);
    assert.ok(result.keysPerSec > 0 && result.count > 0);
    assert.deepEqual(bench.messages.map((m) => m.type), ["ready", "bench"]);
  } finally {
    await bench.worker.terminate();
  }

  const bad = browserWorker();
  try {
    await bad.until((m) => m.type === "ready");
    bad.send({ pattern: "a", position: "sideways" });
    assert.equal((await bad.until((m) => m.type === "error")).message, "Bad grind settings");
    bad.send({ pattern: "", position: "suffix" });
    await bad.until(() => bad.messages.filter((m) => m.type === "error").length === 2);
    assert.equal(bad.messages.some((m) => m.type === "found"), false);
  } finally {
    await bad.worker.terminate();
  }
});

test("keys come from the platform CSPRNG and nowhere else", () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  const web = read("../src/grind-worker.js");
  const cli = read("../../cli/worker.js");
  assert.match(web, /crypto\.getRandomValues\(priv\)/);
  assert.match(cli, /ed25519\.utils\.randomSecretKey\(\)/);
  for (const source of [web, cli, read("../../shared/secret.js"), read("../../shared/base58.js"), read("../../shared/match.js")]) {
    assert.doesNotMatch(source, /Math\.random|Date\.now|seedrandom/);
  }
  // @noble's helper is the same source: it reads crypto.getRandomValues and throws without it.
  const a = ed25519.utils.randomSecretKey();
  const b = ed25519.utils.randomSecretKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});
