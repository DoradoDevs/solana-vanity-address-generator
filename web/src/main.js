import { siteConfig } from "./site.config.js";
import {
  validatePattern,
  describeJob,
  formatAttempts,
  formatDuration,
  formatEstimate,
  DEFAULT_KEYS_PER_THREAD,
  ADDRESS_LENGTH,
} from "../../shared/grind-math.js";
import { isLongPattern, isPublishableTipAddress, resolveBatch } from "../../shared/pro.js";
import { consumePaidGrind, ensurePaid, initPay, spendInProgress } from "./pay.js";
import { confirmUnload } from "./unload.js";

const output = document.getElementById("output");
const inputLine = document.getElementById("input-line");
const inputEl = document.getElementById("input");
const stopBtn = document.getElementById("stop-btn");
const liveStatus = document.getElementById("live-status");

const BASE58_CHARS =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ── Matrix rain (paused while grinding so cores stay on keys) ──

let matrixPaused = false;

function setMatrixPaused(paused) {
  matrixPaused = paused;
}

function initMatrix() {
  const canvas = document.getElementById("matrix-bg");
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    canvas.remove();
    return;
  }
  const ctx = canvas.getContext("2d");
  const fontSize = 14;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();

  let columns = Math.max(1, Math.floor(canvas.width / fontSize));
  let drops = new Array(columns).fill(1);

  window.addEventListener("resize", () => {
    resize();
    columns = Math.max(1, Math.floor(canvas.width / fontSize));
    drops = new Array(columns).fill(1);
  });

  setInterval(() => {
    if (matrixPaused || document.hidden) return;
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#00ff41";
    ctx.font = `${fontSize}px monospace`;
    for (let i = 0; i < drops.length; i++) {
      const char = BASE58_CHARS[Math.floor(Math.random() * BASE58_CHARS.length)];
      ctx.fillText(char, i * fontSize, drops[i] * fontSize);
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  }, 120);
}

function announce(text) {
  if (liveStatus) liveStatus.textContent = text;
}

// ── Security: CSPRNG required ────────────────────────

if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
  output.textContent =
    "FATAL: crypto.getRandomValues is not available. Open this page in a current browser over HTTPS.";
  throw new Error("No CSPRNG available");
}

// ── Terminal helpers (textContent only) ──────────────

function isNarrow() {
  return window.matchMedia("(max-width: 800px)").matches;
}

function terminalColumns() {
  const terminal = document.getElementById("terminal");
  if (!terminal || terminal.clientWidth < 40) return isNarrow() ? 28 : 80;
  const sample = document.getElementById("output") || terminal;
  const style = getComputedStyle(sample);
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.font = style.font;
  document.body.appendChild(probe);
  const char = probe.getBoundingClientRect().width / 10 || 8;
  probe.remove();
  const termStyle = getComputedStyle(terminal);
  const pad =
    (parseFloat(termStyle.paddingLeft) || 0) + (parseFloat(termStyle.paddingRight) || 0);
  return Math.max(18, Math.floor((terminal.clientWidth - pad - 8) / char));
}

function boxWidth() {
  return Math.min(51, Math.max(16, terminalColumns() - 4));
}

function boxTop(width = boxWidth()) {
  return "  ╔" + "═".repeat(width) + "╗";
}
function boxMid(text, width = boxWidth()) {
  const value = text.length > width ? text.slice(0, width) : text;
  const pad = width - value.length;
  const left = Math.floor(pad / 2);
  return "  ║" + " ".repeat(left) + value + " ".repeat(pad - left) + "║";
}
function boxBot(width = boxWidth()) {
  return "  ╚" + "═".repeat(width) + "╝";
}

function bannerSubtitle(width) {
  const full = "Solana vanity addresses, on this device";
  if (full.length <= width) return full;
  const short = "Keys stay on this device";
  if (short.length <= width) return short;
  return "On this device";
}

function printRule() {
  if (!isNarrow()) {
    print("  ─────────────────────────────────────────", "dim");
    return;
  }
  const count = Math.max(8, Math.min(41, terminalColumns() - 2));
  print(`  ${"─".repeat(count)}`, "dim");
}

function print(text = "", cls = "") {
  const div = document.createElement("div");
  div.className = "line" + (cls ? " " + cls : "");
  div.textContent = text;
  output.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  output.scrollTop = output.scrollHeight;
}

function clearOutput() {
  output.replaceChildren();
}

function showToast(text) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ── Clipboard ────────────────────────────────────────

const CLIPBOARD_CLEAR_MS = 60_000;
let clipboardTimer = null;

async function copyPrivateKey(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied. Clipboard clears in 60s if the browser allows it.");
    if (clipboardTimer) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText();
        if (current === text) {
          await navigator.clipboard.writeText("");
          showToast("Clipboard cleared.");
        }
      } catch {
        /* readback is optional; the on-screen wipe still runs */
      }
    }, CLIPBOARD_CLEAR_MS);
  } catch {
    showToast("Copy failed. Select the key and copy it yourself.");
  }
}

async function copyPublic(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Address copied.");
  } catch {
    showToast("Copy failed. Select the address instead.");
  }
}

const KEY_VISIBLE_MS = 120_000;

function scheduleKeyRedaction(keyElement) {
  setTimeout(() => {
    if (!keyElement.isConnected) return;
    keyElement.textContent = "  Private Key: [REDACTED]";
    keyElement.classList.remove("key");
    keyElement.classList.add("dim");
    keyElement.disabled = true;
    keyElement.replaceWith(keyElement.cloneNode(true));
  }, KEY_VISIBLE_MS);
}

// ── Input ────────────────────────────────────────────

let resolveInput = null;

function waitForInput(prompt = "> ") {
  document.getElementById("prompt").textContent = prompt;
  inputLine.classList.remove("hidden");
  inputEl.value = "";
  renderChoices(prompt);
  inputEl.focus({ preventScroll: true });
  return new Promise((resolve) => {
    resolveInput = resolve;
  });
}

function hideInput() {
  inputLine.classList.add("hidden");
  const bar = document.getElementById("choice-bar");
  if (bar) {
    bar.hidden = true;
    bar.replaceChildren();
  }
}

function commitInput(val) {
  if (!resolveInput) return;
  print(`${document.getElementById("prompt").textContent}${val}`);
  inputEl.value = "";
  const resolve = resolveInput;
  resolveInput = null;
  resolve(val);
}

const CHOICE_SETS = [
  {
    test: (prompt) => prompt.includes("Choice [1/2/3/4]"),
    options: [
      ["1", "Prefix"],
      ["2", "Suffix"],
      ["3", "Either end"],
      ["4", "Anywhere"],
    ],
  },
  {
    test: (prompt) => prompt.includes("Case sensitive"),
    options: [
      ["n", "Ignore case"],
      ["y", "Match case"],
    ],
  },
  {
    test: (prompt) => prompt.includes("Grind another"),
    options: [
      ["Y", "Yes"],
      ["n", "No"],
    ],
  },
];

function renderChoices(prompt) {
  const bar = document.getElementById("choice-bar");
  if (!bar) return;
  bar.replaceChildren();
  const spec = isNarrow() ? CHOICE_SETS.find((item) => item.test(prompt)) : null;
  if (!spec) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  for (const [value, label] of spec.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    button.textContent = label;
    button.addEventListener("click", () => commitInput(value));
    bar.appendChild(button);
  }
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitInput(inputEl.value);
});

inputEl.addEventListener("focus", () => {
  if (isNarrow()) inputEl.scrollIntoView({ block: "center" });
});

document.getElementById("terminal").addEventListener("click", () => {
  if (!inputLine.classList.contains("hidden")) inputEl.focus();
});

// ── Grinding ─────────────────────────────────────────

let workers = [];
let totalAttempts = 0;
let startTime = 0;
let foundCount = 0;
let targetCount = 1;
let grinding = false;
let estimatedAttempts = Infinity;
let workerErrors = 0;
let progressTimer = null;
let clearCountdownTimer = null;
let progressLine = null;
/** A matched key exists in this tab and has not been wiped yet. */
let holdingKey = false;
/** The run is over, so nothing more will be added to the terminal. */
let runFinished = false;
/** At least one key has been put on screen. The wipe countdown waits for this. */
let keyRevealed = false;

function stopWorkers() {
  grinding = false;
  setMatrixPaused(false);
  if (stopBtn) stopBtn.hidden = true;
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  for (const worker of workers) {
    try {
      worker.postMessage({ command: "stop" });
    } catch {
      /* already gone */
    }
    worker.terminate();
  }
  workers = [];
}

function updateProgress() {
  if (!progressLine) return;
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = elapsed > 0 ? totalAttempts / elapsed : 0;
  let eta = "";
  if (rate > 0 && Number.isFinite(estimatedAttempts) && estimatedAttempts > totalAttempts) {
    eta = ` | ETA: ${formatEstimate((estimatedAttempts - totalAttempts) / rate)}`;
  }
  const checked = formatAttempts(totalAttempts);
  const rateText = formatAttempts(Math.round(rate));
  const timeText = formatDuration(elapsed);
  if (isNarrow()) {
    const lines = [
      `  Checked: ${checked}`,
      `  Rate: ${rateText}/s`,
      `  Time: ${timeText}`,
    ];
    if (eta) lines.push(`  ETA: ${eta.slice(" | ETA: ".length)}`);
    progressLine.textContent = lines.join("\n");
    return;
  }
  progressLine.textContent =
    `  Checked: ${checked} | Rate: ${rateText}/s | Time: ${timeText}${eta}`;
}

function scheduleProgress() {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    updateProgress();
  }, 200);
}

function startClearCountdown() {
  let remaining = 60;
  const countdownLine = document.createElement("div");
  countdownLine.className = "line dim";
  countdownLine.textContent = `  Terminal clears in ${remaining}s.`;
  output.appendChild(countdownLine);
  scrollToBottom();

  clearCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(clearCountdownTimer);
      clearCountdownTimer = null;
      holdingKey = false;
      clearOutput();
      print("  Terminal cleared. The key is no longer on screen.", "dim");
      print();
      promptRestart();
    } else {
      countdownLine.textContent = `  Terminal clears in ${remaining}s.`;
    }
  }, 1000);
}

function showMatch(msg) {
  if (targetCount === 1) {
    print();
    const width = boxWidth();
    print(boxTop(width), "box glow");
    print(boxMid("MATCH FOUND", width), "box glow");
    print(boxBot(width), "box glow");
  } else {
    print();
    print(`  Match ${foundCount} of ${targetCount}`, "bright");
  }
  print();
  if (isNarrow()) {
    print("  Address:", "bright");
    print(`  ${msg.address}`, "bright");
  } else {
    print(`  Address:     ${msg.address}`, "bright");
  }

  // The key stays off the screen until it is asked for. A grind can finish hours
  // after it was started, with nobody watching, and the wipe must not run then.
  holdingKey = true;
  const keyLine = document.createElement("button");
  keyLine.type = "button";
  keyLine.className = "line key";
  keyLine.textContent = "  Private Key: hidden. Click here to reveal it.";
  keyLine.title = "Reveal the private key";
  let shown = false;
  keyLine.addEventListener("click", () => {
    if (shown) {
      copyPrivateKey(msg.privateKey);
      return;
    }
    shown = true;
    keyLine.textContent = `  Private Key: ${msg.privateKey}`;
    keyLine.title = "Copy the private key";
    scheduleKeyRedaction(keyLine);
    keyRevealed = true;
    startClearCountdownWhenReady();
  });
  output.appendChild(keyLine);
  scrollToBottom();
}

/** The 60 second wipe runs once the run is over and a key has actually been shown. */
function startClearCountdownWhenReady() {
  if (!runFinished || !keyRevealed || clearCountdownTimer) return;
  print("  Click the key to copy it. Save it before the terminal clears.", "amber");
  startClearCountdown();
}

function finishRun() {
  stopWorkers();
  runFinished = true;
  print();
  print(
    targetCount > 1
      ? "  YOUR PRIVATE KEYS ARE ABOVE. Each stays hidden until you click its line."
      : "  YOUR PRIVATE KEY IS ABOVE. It stays hidden until you click that line.",
    "amber"
  );
  print("  It exists only in this tab. Keep the tab open until you have saved it.", "amber");
  print("  The terminal clears 60 seconds after you reveal it.", "amber");
  print("  Anyone with the private key controls that wallet.", "amber");
  print();
  announce("Match found. The private key is hidden until you reveal it. Keep this tab open.");
  startClearCountdownWhenReady();
}

function startGrinding(pattern, position, caseSensitive, threadCount, batch, attempts) {
  totalAttempts = 0;
  startTime = Date.now();
  foundCount = 0;
  targetCount = batch;
  estimatedAttempts = attempts;
  workerErrors = 0;
  grinding = true;
  runFinished = false;
  keyRevealed = false;
  workers = [];
  setMatrixPaused(true);
  if (stopBtn) stopBtn.hidden = false;

  progressLine = document.createElement("div");
  progressLine.className = "line progress";
  progressLine.textContent = "  Checked: 0 | Rate: …/s | Time: 0s";
  output.appendChild(progressLine);
  scrollToBottom();

  const expected = threadCount;
  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(new URL("./grind-worker.js", import.meta.url), {
      name: "vanity-grind",
    });

    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === "error") {
        print(`  Worker error: ${msg.message}`, "red");
        return;
      }
      if (msg.type === "ready") return;

      if (msg.type === "progress") {
        totalAttempts += msg.count;
        scheduleProgress();
        return;
      }

      if (msg.type === "found" && foundCount < targetCount) {
        foundCount++;
        totalAttempts += msg.attempts;
        updateProgress();
        showMatch(msg);
        if (foundCount >= targetCount) finishRun();
      }
    };

    worker.onerror = (err) => {
      workerErrors++;
      print(`  Worker error: ${err.message || "failed to start"}`, "red");
      if (grinding && workerErrors >= expected && foundCount === 0) {
        stopWorkers();
        print("  Grinding stopped because the workers did not start.", "red");
        promptRestart();
      }
    };

    worker.postMessage({ pattern, position, caseSensitive });
    workers.push(worker);
  }
}

function requestStop() {
  if (!grinding) return;
  const elapsed = (Date.now() - startTime) / 1000;
  const hadMatches = foundCount > 0;
  stopWorkers();
  print();
  print("  Stopped.", "red");
  print(
    `  Checked ${formatAttempts(totalAttempts)} keys in ${formatDuration(elapsed)}.`,
    "dim"
  );
  print();
  if (hadMatches) {
    runFinished = true;
    print("  The keys found so far are above. Reveal the ones you want to keep.", "amber");
    print("  The terminal clears 60 seconds after the first reveal.", "amber");
    startClearCountdownWhenReady();
  } else {
    promptRestart();
  }
}

// A running grind, an unsaved key, and the answer to a spend on its way exist only in this
// tab. Ask before any of them is thrown away (unload.js).
window.addEventListener("beforeunload", (event) => {
  confirmUnload(event, { grinding, holdingKey, spending: spendInProgress() });
});

document.addEventListener("keydown", (e) => {
  if (!grinding) return;
  const selected = window.getSelection?.().toString();
  const stop =
    e.key === "Escape" || (e.ctrlKey && (e.key === "c" || e.key === "C"));
  if (!stop || selected) return;
  e.preventDefault();
  requestStop();
});

if (stopBtn) stopBtn.addEventListener("click", requestStop);

// ── Setup flow ───────────────────────────────────────

async function promptRestart() {
  if (clearCountdownTimer) {
    clearInterval(clearCountdownTimer);
    clearCountdownTimer = null;
  }
  const answer = await waitForInput("  Grind another? [Y/n] > ");
  hideInput();
  if (answer.trim().toLowerCase() === "n") {
    print();
    print("  Session ended. Refresh the page to start over.", "dim");
    return;
  }
  print();
  await runSetup();
}

function previewAddress(pattern, position, width = 44) {
  const gap = Math.max(0, width - pattern.length);
  const pad = "·".repeat(gap);
  if (position === "prefix") return pattern + pad;
  if (position === "suffix") return pad + pattern;
  if (position === "prefix-or-suffix") {
    return `${pattern}${pad}   or   ${pad}${pattern}`;
  }
  const left = Math.floor(gap / 2);
  return "·".repeat(left) + pattern + "·".repeat(gap - left);
}

function printPreview(pattern, position) {
  const full = `  Preview:    ${previewAddress(pattern, position)}`;
  if (!isNarrow()) {
    print(full, "bright");
    return;
  }
  const usable = Math.max(pattern.length, Math.min(44, terminalColumns() - 2));
  print("  Preview:", "bright");
  if (position === "prefix-or-suffix") {
    print(`  ${previewAddress(pattern, "prefix", usable)}`, "bright");
    print("  or", "dim");
    print(`  ${previewAddress(pattern, "suffix", usable)}`, "bright");
    return;
  }
  print(`  ${previewAddress(pattern, position, usable)}`, "bright");
}

function benchmarkDevice() {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL("./grind-worker.js", import.meta.url), { name: "vanity-bench" });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      resolve(null);
    }, 6000);
    worker.onmessage = (event) => {
      if (event.data?.type !== "bench") return;
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data.keysPerSec || null);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      resolve(null);
    };
    worker.postMessage({ command: "bench", ms: 2500 });
  });
}

async function runSetup() {
  let pattern;
  while (true) {
    pattern = (await waitForInput("  Enter desired pattern > ")).trim();
    hideInput();
    if (!pattern) {
      print("  Pattern cannot be empty.", "red");
      continue;
    }
    if (pattern.length > ADDRESS_LENGTH) {
      print("  Solana addresses are at most 44 characters.", "red");
      continue;
    }
    const bad = validatePattern(pattern);
    if (bad.length > 0) {
      print(`  Invalid character(s): ${bad.map((c) => `'${c}'`).join(", ")}`, "red");
      print("  Base58 omits 0, O, I, and l.", "red");
      print();
      continue;
    }
    break;
  }

  print();
  print("  Where should the pattern appear?");
  print("  [1] Prefix  (start of address)");
  print("  [2] Suffix  (end of address)");
  print("  [3] Prefix or suffix");
  print("  [4] Anywhere in the address");
  print();

  let position;
  while (true) {
    const choice = (await waitForInput("  Choice [1/2/3/4] > ")).trim();
    hideInput();
    if (choice === "1") { position = "prefix"; break; }
    if (choice === "2") { position = "suffix"; break; }
    if (choice === "3") { position = "prefix-or-suffix"; break; }
    if (choice === "4") { position = "anywhere"; break; }
    print("  Enter 1, 2, 3, or 4.", "red");
  }

  print();
  let caseSensitive;
  while (true) {
    const choice = (await waitForInput("  Case sensitive? [y/N] > ")).trim().toLowerCase();
    hideInput();
    if (choice === "" || choice === "n") { caseSensitive = false; break; }
    if (choice === "y") { caseSensitive = true; break; }
    print("  Enter y or n.", "red");
  }

  const cpuCount = navigator.hardwareConcurrency || 4;
  const defaultThreads = Math.max(1, cpuCount - 1);
  print();
  let threadCount;
  while (true) {
    const raw = (await waitForInput(`  Worker threads [${defaultThreads}] > `)).trim();
    hideInput();
    if (raw === "") { threadCount = defaultThreads; break; }
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= cpuCount * 2) { threadCount = n; break; }
    print(`  Enter a number from 1 to ${cpuCount * 2}.`, "red");
  }

  let batch = 1;
  if (siteConfig.pro.enabled) {
    print();
    print(`  Pro is on. You can grind up to ${siteConfig.pro.maxBatch} matches in this run.`, "dim");
    while (true) {
      const raw = (await waitForInput(`  How many matches? [1] > `)).trim();
      hideInput();
      if (raw === "") { batch = 1; break; }
      const parsed = resolveBatch(parseInt(raw, 10), siteConfig.pro);
      if (!parsed.rejected) { batch = parsed.batch; break; }
      print(`  Enter a number from 1 to ${siteConfig.pro.maxBatch}.`, "red");
    }
  } else if (isLongPattern(pattern, siteConfig.pro)) {
    print();
    print("  Pro notice: this pattern is past the free-length hint.", "amber");
    print("  Batch mode is off on this deploy. One address still grinds in this tab.", "amber");
    print("  Nothing you type is uploaded.", "amber");
  }

  const job = describeJob({
    pattern,
    position,
    caseSensitive,
    threads: threadCount,
    keysPerThread: DEFAULT_KEYS_PER_THREAD,
  });

  print();
  printRule();
  if (isNarrow()) {
    print(`  Pattern: "${pattern}"`, "bright");
    print(`  Position: ${position}`);
    print(`  Case: ${caseSensitive ? "sensitive" : "insensitive"}`);
    print(`  Threads: ${threadCount}`);
    print(`  Matches: ${batch}`);
    print(`  Est. keys: ~${formatAttempts(job.attempts)}`, "dim");
    print(`  Planning guess: ${formatEstimate(job.seconds)}`, "dim");
    print(`  At ~${formatAttempts(job.rate)} keys/s`, "dim");
  } else {
    print(`  Pattern:    "${pattern}"`, "bright");
    print(`  Position:   ${position}`);
    print(`  Case:       ${caseSensitive ? "sensitive" : "insensitive"}`);
    print(`  Threads:    ${threadCount}`);
    print(`  Matches:    ${batch}`);
    print(`  Est. keys:  ~${formatAttempts(job.attempts)} attempts`, "dim");
    print(
      `  Planning guess: ${formatEstimate(job.seconds)} at ~${formatAttempts(job.rate)} keys/s`,
      "dim"
    );
  }
  print("  Measuring this device…", "dim");
  const perWorker = await benchmarkDevice();
  if (perWorker) {
    const deviceRate = perWorker * threadCount;
    const deviceSeconds = Number.isFinite(job.attempts)
      ? (job.attempts * batch) / deviceRate
      : Infinity;
    if (isNarrow()) {
      print(`  This device: ${formatAttempts(perWorker)} keys/s per worker`, "bright");
      print(`  Across ${threadCount}: ~${formatAttempts(deviceRate)}/s`, "bright");
      print(`  Est. time here: ${formatEstimate(deviceSeconds)}`, "bright");
    } else {
      print(
        `  This device: ${formatAttempts(perWorker)} keys/s per worker, ~${formatAttempts(deviceRate)}/s across ${threadCount}`,
        "bright"
      );
      print(`  Est. time here: ${formatEstimate(deviceSeconds)}`, "bright");
    }
  } else {
    print("  Could not measure this device. The planning guess still stands.", "amber");
  }
  printPreview(pattern, position);
  print(
    caseSensitive
      ? "  The preview uses the case you typed."
      : "  A case-insensitive grind also keeps the other case.",
    "dim"
  );
  if (batch > 1) {
    print("  Batch time scales roughly with the number of matches.", "dim");
  }
  for (const warning of job.warnings) print(`  ${warning}`, "amber");
  printRule();
  print();
  print("  Pay $1 to start grinding.", "amber");
  print("  Waiting for payment…", "amber");

  const paid = await ensurePaid();
  if (!paid.ok) {
    print(`  ${paid.message || "Payment was not completed."}`, "amber");
    print();
    await runSetup();
    return;
  }

  const spent = await consumePaidGrind();
  if (!spent.ok) {
    print(`  ${spent.message}`, "red");
    print();
    await runSetup();
    return;
  }

  print();
  print(`  Grinding with ${threadCount} worker${threadCount === 1 ? "" : "s"}…`, "bright");
  print("  Press Stop, Esc, or Ctrl+C to stop.", "dim");
  print();
  announce(`Grinding ${pattern}. ${threadCount} workers.`);
  startGrinding(pattern, position, caseSensitive, threadCount, batch, job.attempts * batch);
}

async function boot() {
  hideInput();
  const width = boxWidth();
  print(boxTop(width), "box");
  print(boxMid("VANITYGRINDER", width), "box");
  print(boxMid(bannerSubtitle(width), width), "box");
  print(boxBot(width), "box");
  print();

  const cores = navigator.hardwareConcurrency || "?";
  if (isNarrow()) {
    print(`  Cores: ${cores}`, "dim");
    print("  Crypto: @noble/curves ed25519", "dim");
    print("  Network: payment check only", "dim");
    print("  Keys stay on this device", "dim");
    print("  Key stays hidden until you reveal it", "dim");
  } else {
    print(`  Cores:    ${cores}`, "dim");
    print("  Crypto:   @noble/curves ed25519", "dim");
    print("  Network:  payment check only — keys stay on this device", "dim");
    print("  Reveal:   the key stays hidden until you ask, then clears after 60s", "dim");
  }
  print();
  if (isNarrow()) {
    print("  Base58: 1-9 A-H J-N P-Z a-k m-z", "bright");
    print("  Excluded: 0 O I l", "amber");
  } else {
    print("  Base58:   1-9  A-H  J-N  P-Z  a-k  m-z", "bright");
    print("  Excluded: 0 (zero)  O (cap-o)  I (cap-i)  l (low-L)", "amber");
  }
  print();
  await runSetup();
}

function initNav() {
  const nav = document.querySelector(".topnav nav");
  const toggle = document.querySelector(".nav-toggle");
  if (!nav || !toggle) return;
  const close = () => {
    nav.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll("a").forEach((link) => link.addEventListener("click", close));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".topnav")) close();
  });
}

// ── Estimator ────────────────────────────────────────

function addLine(parent, label, value, cls) {
  const row = document.createElement("p");
  row.className = "est-row" + (cls ? " " + cls : "");
  const k = document.createElement("span");
  k.className = "est-k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "est-v";
  v.textContent = value;
  row.append(k, v);
  parent.appendChild(row);
}

function initEstimator() {
  const form = document.getElementById("est-form");
  if (!form) return;
  form.addEventListener("submit", (event) => event.preventDefault());

  const patternEl = document.getElementById("est-pattern");
  const lengthEl = document.getElementById("est-length");
  const lengthVal = document.getElementById("est-length-val");
  const positionEl = document.getElementById("est-position");
  const caseEl = document.getElementById("est-case");
  const threadsEl = document.getElementById("est-threads");
  const rateEl = document.getElementById("est-rate");
  const result = document.getElementById("est-result");

  const cores = navigator.hardwareConcurrency || 4;
  threadsEl.value = String(Math.max(1, cores - 1));
  rateEl.value = String(DEFAULT_KEYS_PER_THREAD);

  function render() {
    const typed = patternEl.value.trim();
    if (typed) {
      lengthEl.max = String(Math.max(8, Math.min(ADDRESS_LENGTH, typed.length)));
      lengthEl.value = String(Math.min(ADDRESS_LENGTH, typed.length));
      lengthEl.disabled = true;
    } else {
      lengthEl.disabled = false;
      lengthEl.max = "8";
    }
    lengthVal.textContent = lengthEl.value;

    const pattern = typed || "A".repeat(Number(lengthEl.value) || 1);
    const threads = Math.min(64, Math.max(1, parseInt(threadsEl.value, 10) || 1));
    const rate = Math.min(
      100_000,
      Math.max(100, parseInt(rateEl.value, 10) || DEFAULT_KEYS_PER_THREAD)
    );
    const job = describeJob({
      pattern,
      position: positionEl.value,
      caseSensitive: caseEl.checked,
      threads,
      keysPerThread: rate,
    });

    result.replaceChildren();
    if (!typed) {
      const note = document.createElement("p");
      note.className = "est-note";
      note.textContent =
        "No pattern typed. This estimates a letter pattern of the chosen length. Type one to include digits and prefix bias.";
      result.appendChild(note);
    }
    addLine(result, "Expected attempts", `~${formatAttempts(job.attempts)}`);
    addLine(
      result,
      "Rough time",
      formatEstimate(job.seconds),
      Number.isFinite(job.seconds) && job.seconds > 86400 ? "warn" : ""
    );
    addLine(result, "Assumed speed", `${formatAttempts(job.rate)} keys/s`);
    for (const warning of job.warnings) {
      const line = document.createElement("p");
      line.className = "est-warn";
      line.textContent = warning;
      result.appendChild(line);
    }
  }

  for (const el of [patternEl, lengthEl, positionEl, caseEl, threadsEl, rateEl]) {
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  }
  render();
}

// ── Tip + Pro scaffold ───────────────────────────────

function initSupport() {
  const tipAddress = document.getElementById("tip-address");
  const tipCopy = document.getElementById("tip-copy");
  const tipNote = document.getElementById("tip-note");
  if (tipAddress && isPublishableTipAddress(siteConfig.tipAddress)) {
    tipAddress.textContent = siteConfig.tipAddress.trim();
    tipAddress.tabIndex = 0;
    if (tipCopy) {
      tipCopy.hidden = false;
      tipCopy.addEventListener("click", () => copyPublic(tipAddress.textContent.trim()));
    }
    if (tipNote) {
      tipNote.textContent =
        "Public address only. A tip is optional. The grind is $1 in USDC per grind, paid from your wallet, and is checked separately.";
    }
  }

  const status = document.getElementById("pro-status");
  const lead = document.getElementById("pro-lead");
  if (!status || !lead) return;
  if (siteConfig.pro.enabled) {
    status.textContent = "On";
    status.classList.add("on");
    lead.textContent =
      `Pro is on for this build: up to ${siteConfig.pro.maxBatch} matches per run, still generated in this tab. There is no checkout.`;
  } else {
    status.textContent = "Off";
    status.classList.remove("on");
  }
}

document.querySelectorAll('a[href="#terminal-section"]').forEach((link) => {
  link.addEventListener("click", () => {
    setTimeout(() => {
      if (!inputLine.classList.contains("hidden")) inputEl.focus();
    }, 400);
  });
});

initMatrix();
initNav();
initEstimator();
initSupport();
initPay();
boot();
