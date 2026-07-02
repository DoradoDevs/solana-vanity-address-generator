import readline from "node:readline";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INVALID_CHARS = ["0", "O", "I", "l"];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function validatePattern(pattern) {
  const errors = [];
  for (const ch of pattern) {
    if (INVALID_CHARS.includes(ch) || !BASE58_CHARS.includes(ch)) {
      errors.push(ch);
    }
  }
  return errors;
}

// Solana addresses are 32 bytes Base58-encoded to 43-44 chars.
// ~94% of addresses are 44 chars, where the first character is limited to
// indices 1-17 (chars '2' through 'J'). Only ~6% are 43 chars, where the
// first character can be anything. This makes lowercase/late-alphabet chars
// at the start ~17x rarer than a naive 1/58 estimate.
const COMMON_FIRST_CHARS = "23456789ABCDEFGHJ";

function firstCharProbability(ch, caseSensitive) {
  if (!caseSensitive) {
    const upperCommon = COMMON_FIRST_CHARS.includes(ch.toUpperCase());
    const lowerCommon = COMMON_FIRST_CHARS.includes(ch.toLowerCase());
    if (upperCommon && lowerCommon) return 2 * (1 / 17);
    if (upperCommon || lowerCommon) return 1 / 17 + 1 / 1000;
    if (ch === "1") return 1 / 250; // digit, no case variant
    return 2 * (1 / 1000); // both cases are rare
  }
  if (COMMON_FIRST_CHARS.includes(ch)) return 1 / 17; // ~5.9%
  if (ch === "1") return 1 / 250; // ~0.4%
  return 1 / 1000; // ~0.1%
}

function estimateDifficulty(pattern, position, caseSensitive) {
  const charsPerPosition = caseSensitive ? 58 : 34;

  if (position === "prefix") {
    const firstProb = firstCharProbability(pattern[0], caseSensitive);
    const restProb = 1 / Math.pow(charsPerPosition, pattern.length - 1);
    return Math.round(1 / (firstProb * restProb));
  }

  let expected = Math.pow(charsPerPosition, pattern.length);
  if (position === "anywhere") {
    expected = expected / Math.max(1, 44 - pattern.length);
  }
  return Math.round(expected);
}

// Returns "common", "uncommon", or "rare"
function prefixRarity(pattern, caseSensitive) {
  const ch = pattern[0];
  if (caseSensitive) {
    if (COMMON_FIRST_CHARS.includes(ch)) return "common";
    if (ch === "1") return "uncommon";
    return "rare";
  }
  if (
    COMMON_FIRST_CHARS.includes(ch.toUpperCase()) ||
    COMMON_FIRST_CHARS.includes(ch.toLowerCase())
  )
    return "common";
  if (ch === "1") return "uncommon";
  return "rare";
}

function formatNumber(n) {
  return n.toLocaleString();
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function main() {
  console.log("");
  console.log("  ╔═══════════════════════════════════════╗");
  console.log("  ║     SOLANA VANITY WALLET GRINDER      ║");
  console.log("  ╚═══════════════════════════════════════╝");
  console.log("");
  console.log("  Base58 alphabet (valid characters):");
  console.log("  1-9 A-H J-N P-Z a-k m-z");
  console.log("");
  console.log("  Excluded: 0 (zero), O (capital o), I (capital i), l (lowercase L)");
  console.log("");

  // Pattern
  let pattern;
  for (;;) {
    pattern = (await ask("  Enter desired pattern: ")).trim();
    if (!pattern) {
      console.log("  Pattern cannot be empty.\n");
      continue;
    }
    const bad = validatePattern(pattern);
    if (bad.length > 0) {
      const unique = [...new Set(bad)];
      console.log(`  Invalid character(s): ${unique.map((c) => `'${c}'`).join(", ")}`);
      console.log("  Only Base58 characters are allowed (no 0, O, I, l).\n");
      continue;
    }
    break;
  }

  // Position
  console.log("");
  console.log("  Where should the pattern appear?");
  console.log("  [1] Prefix  (start of address)");
  console.log("  [2] Suffix  (end of address)");
  console.log("  [3] Anywhere in address");
  console.log("");

  let position;
  for (;;) {
    const choice = (await ask("  Choice [1/2/3]: ")).trim();
    if (choice === "1") { position = "prefix"; break; }
    if (choice === "2") { position = "suffix"; break; }
    if (choice === "3") { position = "anywhere"; break; }
    console.log("  Please enter 1, 2, or 3.");
  }

  // Case sensitivity
  console.log("");
  let caseSensitive;
  for (;;) {
    const choice = (await ask("  Case sensitive? [y/N]: ")).trim().toLowerCase();
    if (choice === "" || choice === "n") { caseSensitive = false; break; }
    if (choice === "y") { caseSensitive = true; break; }
    console.log("  Please enter y or n.");
  }

  // Thread count
  const cpuCount = os.cpus().length;
  const defaultThreads = Math.max(1, cpuCount - 1);
  console.log("");
  let threadCount;
  for (;;) {
    const input = (await ask(`  Worker threads [${defaultThreads}]: `)).trim();
    if (input === "") { threadCount = defaultThreads; break; }
    const n = parseInt(input, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= cpuCount * 2) { threadCount = n; break; }
    console.log(`  Enter a number between 1 and ${cpuCount * 2}.`);
  }

  // Difficulty estimate
  const estimated = estimateDifficulty(pattern, position, caseSensitive);
  console.log("");
  console.log("  ─────────────────────────────────────────");
  console.log(`  Pattern:    "${pattern}"`);
  console.log(`  Position:   ${position}`);
  console.log(`  Case:       ${caseSensitive ? "sensitive" : "insensitive"}`);
  console.log(`  Threads:    ${threadCount}`);
  console.log(`  Est. keys:  ~${formatNumber(estimated)} attempts`);

  const rarity = position === "prefix" ? prefixRarity(pattern, caseSensitive) : "common";
  if (rarity === "uncommon") {
    console.log("");
    console.log(`  ⚠ '${pattern[0]}' is uncommon as a first character (~0.4% of addresses).`);
    console.log("  About 4x harder than common first chars (2-9, A-H, J).");
  } else if (rarity === "rare") {
    console.log("");
    console.log(`  ⚠ '${pattern[0]}' is rare as a first character (~0.1% of addresses).`);
    console.log("  About 17x harder than common first chars (2-9, A-H, J).");
    console.log("  Consider using suffix or anywhere for faster results.");
  }

  if (pattern.length >= 6 && position !== "anywhere") {
    console.log("");
    console.log("  ⚠ Long patterns take exponentially longer.");
    console.log("  6+ chars at prefix/suffix could take hours or days.");
  }

  console.log("  ─────────────────────────────────────────");
  console.log("");

  const confirm = (await ask("  Start grinding? [Y/n]: ")).trim().toLowerCase();
  if (confirm === "n") {
    console.log("  Aborted.");
    rl.close();
    return;
  }

  console.log("");
  console.log(`  Grinding with ${threadCount} threads...`);
  console.log("  Press Ctrl+C to stop.\n");

  rl.close();

  const startTime = Date.now();
  let totalAttempts = 0;
  let found = false;
  const workers = [];

  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { pattern, position, caseSensitive },
    });

    worker.on("message", (msg) => {
      if (msg.type === "progress") {
        totalAttempts += msg.count;
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = Math.round(totalAttempts / elapsed);
        process.stdout.write(
          `\r  Checked: ${formatNumber(totalAttempts)} | Rate: ${formatNumber(rate)}/s | Time: ${formatTime(Math.round(elapsed))}   `
        );
      }

      if (msg.type === "found" && !found) {
        found = true;
        totalAttempts += msg.attempts;
        const elapsed = (Date.now() - startTime) / 1000;

        console.log("\n");
        console.log("  ╔═══════════════════════════════════════════════════╗");
        console.log("  ║                   MATCH FOUND!                    ║");
        console.log("  ╚═══════════════════════════════════════════════════╝");
        console.log("");
        console.log(`  Address:     ${msg.address}`);
        console.log(`  Private Key: ${msg.privateKey}`);
        console.log("");
        console.log(`  Attempts:    ${formatNumber(totalAttempts)}`);
        console.log(`  Time:        ${formatTime(Math.round(elapsed))}`);
        console.log("");
        console.log("  ⚠ SAVE YOUR PRIVATE KEY SECURELY!");
        console.log("  ⚠ Anyone with the private key controls this wallet.");
        console.log("");

        for (const w of workers) {
          w.terminate();
        }
      }
    });

    worker.on("error", (err) => {
      console.error(`\n  Worker error: ${err.message}`);
    });

    workers.push(worker);
  }

  await Promise.all(
    workers.map((w) => new Promise((resolve) => w.on("exit", resolve)))
  );

  if (!found) {
    console.log("\n  All workers exited without finding a match.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
