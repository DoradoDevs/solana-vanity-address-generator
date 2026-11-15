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
import { consumePaidGrind, ensurePaid, initPay } from "./pay.js";

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

const BOX_W = 51;

function boxTop() {
  return "  ╔" + "═".repeat(BOX_W) + "╗";
}
function boxMid(text) {
  const value = text.length > BOX_W ? text.slice(0, BOX_W) : text;
  const pad = BOX_W - value.length;
  const left = Math.floor(pad / 2);
  return "  ║" + " ".repeat(left) + value + " ".repeat(pad - left) + "║";
}
function boxBot() {
  return "  ╚" + "═".repeat(BOX_W) + "╝";
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
  const terminal = document.getElementById("terminal");
  terminal.scrollTop = terminal.scrollHeight;
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
  inputEl.focus({ preventScroll: true });
  return new Promise((resolve) => {
    resolveInput = resolve;
  });
}

function hideInput() {
  inputLine.classList.add("hidden");
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && resolveInput) {
    const val = inputEl.value;
    print(`${document.getElementById("prompt").textContent}${val}`);
    inputEl.value = "";
    const resolve = resolveInput;
    resolveInput = null;
    resolve(val);
  }
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
  progressLine.textContent =
    `  Checked: ${formatAttempts(totalAttempts)} | Rate: ${formatAttempts(Math.round(rate))}/s | Time: ${formatDuration(elapsed)}${eta}`;
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
    print(boxTop(), "box glow");
    print(boxMid("MATCH FOUND"), "box glow");
    print(boxBot(), "box glow");
  } else {
    print();
    print(`  Match ${foundCount} of ${targetCount}`, "bright");
  }
  print();
  print(`  Address:     ${msg.address}`, "bright");

  const keyLine = document.createElement("button");
  keyLine.type = "button";
  keyLine.className = "line key";
  keyLine.textContent = `  Private Key: ${msg.privateKey}`;
  keyLine.title = "Copy the private key";
  keyLine.addEventListener("click", () => copyPrivateKey(msg.privateKey));
  output.appendChild(keyLine);
  scheduleKeyRedaction(keyLine);
  scrollToBottom();
}

function finishRun() {
  stopWorkers();
  print();
  print(
    targetCount > 1
      ? "  SAVE THESE PRIVATE KEYS NOW. Click a key to copy it."
      : "  SAVE YOUR PRIVATE KEY NOW. Click it to copy.",
    "amber"
  );
  print("  Anyone with the private key controls that wallet.", "amber");
  print();
  announce("Match found. The private key is on screen. Save it now.");
  startClearCountdown();
}

function startGrinding(pattern, position, caseSensitive, threadCount, batch, attempts) {
  totalAttempts = 0;
  startTime = Date.now();
  foundCount = 0;
  targetCount = batch;
  estimatedAttempts = attempts;
  workerErrors = 0;
  grinding = true;
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
    print("  Keys already on screen will be wiped with the terminal.", "amber");
    startClearCountdown();
  } else {
    promptRestart();
  }
}

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

async function runSetup() {
  const paid = await ensurePaid();
  if (!paid) {
    print("  A $1 payment is required before grinding.", "amber");
    return;
  }

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
  print("  ─────────────────────────────────────────", "dim");
  print(`  Pattern:    "${pattern}"`, "bright");
  print(`  Position:   ${position}`);
  print(`  Case:       ${caseSensitive ? "sensitive" : "insensitive"}`);
  print(`  Threads:    ${threadCount}`);
  print(`  Matches:    ${batch}`);
  print(`  Est. keys:  ~${formatAttempts(job.attempts)} attempts`, "dim");
  print(
    `  Est. time:  ${formatEstimate(job.seconds)} at ~${formatAttempts(job.rate)} keys/s`,
    "dim"
  );
  if (batch > 1) {
    print("  Batch time scales roughly with the number of matches.", "dim");
  }
  for (const warning of job.warnings) print(`  ${warning}`, "amber");
  print("  ─────────────────────────────────────────", "dim");
  print();

  const confirm = (await waitForInput("  Start grinding? [Y/n] > ")).trim().toLowerCase();
  hideInput();
  if (confirm === "n") {
    print("  Aborted.", "dim");
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
  print(boxTop(), "box");
  print(boxMid("VANITYGRINDER"), "box");
  print(boxMid("Solana vanity addresses, on this device"), "box");
  print(boxBot(), "box");
  print();

  const cores = navigator.hardwareConcurrency || "?";
  print(`  Cores:    ${cores}`, "dim");
  print("  Crypto:   @noble/curves ed25519", "dim");
  print("  Network:  payment check only — keys stay on this device", "dim");
  print("  Reveal:   the key leaves the screen about 60s after a match", "dim");
  print();
  print("  Base58:   1-9  A-H  J-N  P-Z  a-k  m-z", "bright");
  print("  Excluded: 0 (zero)  O (cap-o)  I (cap-i)  l (low-L)", "amber");
  print();
  await runSetup();
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
      tipCopy.addEventListener("click", () => copyPublic(siteConfig.tipAddress.trim()));
    }
    if (tipNote) {
      tipNote.textContent =
        "Public address only. A tip is optional. The $1 grind payment is a separate transfer checked by this site.";
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
initEstimator();
initSupport();
initPay();
boot();
