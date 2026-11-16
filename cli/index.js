import readline from "node:readline";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePattern,
  describeJob,
  formatAttempts,
  formatDuration,
  formatEstimate,
  DEFAULT_KEYS_PER_THREAD,
} from "../shared/grind-math.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
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

  let pattern;
  for (;;) {
    pattern = (await ask("  Enter desired pattern: ")).trim();
    if (!pattern) {
      console.log("  Pattern cannot be empty.\n");
      continue;
    }
    const bad = validatePattern(pattern);
    if (bad.length > 0) {
      console.log(`  Invalid character(s): ${bad.map((c) => `'${c}'`).join(", ")}`);
      console.log("  Only Base58 characters are allowed (no 0, O, I, l).\n");
      continue;
    }
    if (pattern.length > 44) {
      console.log("  Solana addresses are at most 44 characters.\n");
      continue;
    }
    break;
  }

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

  console.log("");
  let caseSensitive;
  for (;;) {
    const choice = (await ask("  Case sensitive? [y/N]: ")).trim().toLowerCase();
    if (choice === "" || choice === "n") { caseSensitive = false; break; }
    if (choice === "y") { caseSensitive = true; break; }
    console.log("  Please enter y or n.");
  }

  const cpuCount = Math.max(1, os.availableParallelism());
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

  const job = describeJob({
    pattern,
    position,
    caseSensitive,
    threads: threadCount,
    keysPerThread: DEFAULT_KEYS_PER_THREAD,
  });

  console.log("");
  console.log("  ─────────────────────────────────────────");
  console.log(`  Pattern:    "${pattern}"`);
  console.log(`  Position:   ${position}`);
  console.log(`  Case:       ${caseSensitive ? "sensitive" : "insensitive"}`);
  console.log(`  Threads:    ${threadCount}`);
  console.log(`  Est. keys:  ~${formatAttempts(job.attempts)} attempts`);
  console.log(
    `  Est. time:  ${formatEstimate(job.seconds)} at ~${formatNumber(job.rate)} keys/s`
  );
  for (const warning of job.warnings) {
    console.log("");
    console.log(`  ⚠ ${warning}`);
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
          `\r  Checked: ${formatNumber(totalAttempts)} | Rate: ${formatNumber(rate)}/s | Time: ${formatDuration(elapsed)}   `
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
        console.log(`  Time:        ${formatDuration(elapsed)}`);
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
