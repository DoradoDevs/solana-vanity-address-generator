import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";
import {
  DEFAULT_KEYS_PER_THREAD,
  describeJob,
  estimateDifficulty,
  formatAttempts,
  formatDuration,
  formatEstimate,
  prefixRarity,
} from "../../shared/grind-math.js";
import { matchesAddress } from "../../shared/match.js";
import { isLongPattern, isPublishableTipAddress, resolveBatch } from "../../shared/pro.js";
import { assembleSecretKey } from "../../shared/secret.js";

const ADDRESS = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";
const SECRET =
  "1111111111111111111111111111111PPm2a2NNZH2EFJ5UkEjkH9Fcxn8cvjTmZDKQQisyLDmA";

test("base58 encodes 32 zero bytes as 32 ones", () => {
  assert.equal(encodeBase58(new Uint8Array(32)), "1".repeat(32));
});

test("base58 round-trips random 32-byte strings and leading zeros", () => {
  for (let i = 0; i < 30; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
  }
  const leading = new Uint8Array([0, 0, 1, 0]);
  const encoded = encodeBase58(leading);
  assert.ok(encoded.startsWith("11"));
  assert.deepEqual(decodeBase58(encoded), leading);
});

test("base58 rejects glyphs outside the alphabet", () => {
  assert.throws(() => decodeBase58("0"), /Invalid Base58/);
  assert.throws(() => decodeBase58("O"), /Invalid Base58/);
  assert.throws(() => decodeBase58("I"), /Invalid Base58/);
  assert.throws(() => decodeBase58("l"), /Invalid Base58/);
});

test("ed25519 fixture matches the Solana secret-key layout", () => {
  const seed = new Uint8Array(32);
  seed[31] = 1;
  const pub = ed25519.getPublicKey(seed);
  assert.equal(encodeBase58(pub), ADDRESS);
  const secret = assembleSecretKey(seed, pub);
  assert.equal(secret, SECRET);
  assert.equal(seed[31], 1);
  const decoded = decodeBase58(secret);
  assert.equal(decoded.length, 64);
  assert.deepEqual(decoded.subarray(0, 32), seed);
  assert.deepEqual(decoded.subarray(32), pub);
});

test("matcher covers position and case folding", () => {
  assert.equal(matchesAddress(ADDRESS, "6AS", "prefix", true), true);
  assert.equal(matchesAddress(ADDRESS, "6as", "prefix", true), false);
  assert.equal(matchesAddress(ADDRESS, "6as", "prefix", false), true);
  assert.equal(matchesAddress(ADDRESS, "GWt", "suffix", true), true);
  assert.equal(matchesAddress(ADDRESS, "gwt", "suffix", true), false);
  assert.equal(matchesAddress(ADDRESS, "gwt", "suffix", false), true);
  assert.equal(matchesAddress(ADDRESS, "TCp", "anywhere", true), true);
  assert.equal(matchesAddress(ADDRESS, "tcp", "anywhere", false), true);
  assert.equal(matchesAddress(ADDRESS, "GWt", "prefix-or-suffix", true), true);
  assert.equal(matchesAddress(ADDRESS, "nope", "suffix", false), false);
  assert.equal(matchesAddress(ADDRESS, "", "suffix", true), false);
  assert.equal(matchesAddress(ADDRESS, "GWt", "sideways", true), false);
});

test("difficulty uses 58^n for a case-sensitive suffix", () => {
  assert.equal(estimateDifficulty("a", "suffix", true), 58);
  assert.equal(estimateDifficulty("ab", "suffix", true), 3364);
  assert.equal(estimateDifficulty("abc", "suffix", true), 195112);
  assert.equal(estimateDifficulty("abcd", "suffix", true), 11316496);
});

test("case-insensitive letters are 29^n and digits stay at 58^n", () => {
  assert.equal(estimateDifficulty("ab", "suffix", false), 841);
  assert.equal(estimateDifficulty("a1", "suffix", false), 1682);
  assert.equal(estimateDifficulty("12", "suffix", false), 3364);
  assert.equal(estimateDifficulty("L", "suffix", false), 58);
});

test("prefix odds do not double digits and do add a real second case", () => {
  assert.equal(estimateDifficulty("2", "prefix", true), 17);
  assert.equal(estimateDifficulty("2", "prefix", false), 17);
  assert.equal(estimateDifficulty("A", "prefix", true), 17);
  assert.equal(estimateDifficulty("a", "prefix", false), 17);
  assert.equal(estimateDifficulty("AB", "prefix", true), 986);
  assert.equal(estimateDifficulty("1", "prefix", true), 250);
  assert.equal(estimateDifficulty("z", "prefix", true), 1000);
  assert.equal(estimateDifficulty("z", "prefix", false), 500);
  assert.equal(estimateDifficulty("L", "prefix", false), 1000);
  assert.equal(prefixRarity("A", true), "common");
  assert.equal(prefixRarity("1", true), "uncommon");
  assert.equal(prefixRarity("z", true), "rare");
  assert.equal(prefixRarity("a", false), "common");
});

test("anywhere counts windows, and prefix-or-suffix unions the two odds", () => {
  assert.equal(estimateDifficulty("ab", "anywhere", false), 20);
  // "AB": prefix 1/17 × 1/58, suffix 1/58². Union rounds to 763.
  assert.equal(estimateDifficulty("AB", "prefix-or-suffix", true), 763);
  // Case-sensitive "ab": 'a' is a rare first glyph, so the suffix term dominates.
  assert.equal(estimateDifficulty("ab", "prefix-or-suffix", true), 3180);
  assert.equal(estimateDifficulty("", "suffix", true), Infinity);
  assert.equal(estimateDifficulty("0", "suffix", true), Infinity);
  assert.equal(estimateDifficulty("a".repeat(45), "suffix", true), Infinity);
  assert.throws(() => estimateDifficulty("a", "nope", true), /Unknown position/);
});

test("describeJob warns about rare prefixes and case-less patterns", () => {
  const rare = describeJob({
    pattern: "z",
    position: "prefix",
    caseSensitive: true,
    threads: 1,
    keysPerThread: 5000,
  });
  assert.equal(rare.attempts, 1000);
  assert.ok(rare.warnings.some((w) => w.includes("17×")));

  const digits = describeJob({
    pattern: "1",
    position: "suffix",
    caseSensitive: false,
    threads: 1,
    keysPerThread: DEFAULT_KEYS_PER_THREAD,
  });
  assert.ok(digits.warnings.some((w) => w.includes("does not shorten")));

  const easy = describeJob({
    pattern: "ab",
    position: "suffix",
    caseSensitive: false,
    threads: 1,
    keysPerThread: 5000,
  });
  assert.equal(easy.attempts, 841);
  assert.ok(Math.abs(easy.seconds - 841 / 5000) < 1e-9);
  assert.equal(easy.warnings.length, 0);
});

test("duration and attempt formatting", () => {
  assert.equal(formatDuration(0.2, { estimate: true }), "under a second");
  assert.equal(formatEstimate(0.2), "under a second");
  assert.equal(formatEstimate(47), "~47s");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(90), "1m 30s");
  assert.equal(formatDuration(Infinity), "not practical");
  assert.equal(formatAttempts(58), "58");
  assert.equal(formatAttempts(3364), "3,364");
  assert.equal(formatAttempts(11316496), "11.3M");
});

test("tip addresses are public and short, and batching follows the flag", () => {
  assert.equal(isPublishableTipAddress(""), false);
  assert.equal(isPublishableTipAddress("REPLACE_WITH_YOUR_SOL_ADDRESS"), false);
  assert.equal(isPublishableTipAddress("1".repeat(88)), false);
  assert.equal(isPublishableTipAddress(ADDRESS), true);
  assert.equal(isLongPattern("abcdef", { freeMaxPatternLength: 5 }), true);
  assert.equal(isLongPattern("abc", { freeMaxPatternLength: 5 }), false);

  const off = { enabled: false, maxBatch: 10, freeMaxPatternLength: 5 };
  assert.deepEqual(resolveBatch(4, off), { enabled: false, batch: 1, rejected: true });
  assert.deepEqual(resolveBatch(1, off), { enabled: false, batch: 1, rejected: false });
  const on = { enabled: true, maxBatch: 10, freeMaxPatternLength: 5 };
  assert.deepEqual(resolveBatch(3, on), { enabled: true, batch: 3, rejected: false });
  assert.deepEqual(resolveBatch(40, on), { enabled: true, batch: 10, rejected: true });
  assert.equal(resolveBatch(Number.NaN, on).rejected, true);
});

test("cli worker finds a one-character suffix", { timeout: 20_000 }, async () => {
  const worker = new Worker(new URL("../../cli/worker.js", import.meta.url), {
    workerData: { pattern: "a", position: "suffix", caseSensitive: false },
  });
  try {
    const found = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cli worker timed out")), 15_000);
      worker.on("message", (msg) => {
        if (msg.type === "found") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      worker.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const end = found.address.at(-1);
    assert.ok(end === "a" || end === "A", found.address);
    assert.equal(decodeBase58(found.privateKey).length, 64);
    const decoded = decodeBase58(found.privateKey);
    const pub = decoded.subarray(32);
    assert.equal(encodeBase58(pub), found.address);
  } finally {
    await worker.terminate();
  }
});
