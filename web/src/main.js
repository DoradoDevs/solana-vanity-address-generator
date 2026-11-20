import { siteConfig } from "./site.config.js";
import {
  validatePattern,
  describeJob,
  formatAttempts,
  formatDuration,
  formatEstimate,
  formatOdds,
  formatProbability,
  foundByNowProbability,
  DEFAULT_KEYS_PER_THREAD,
  ADDRESS_LENGTH,
} from "../../shared/grind-math.js";
import { consoleWarnings, deviceLines, planLines } from "./console-lines.js";
import { readCount } from "./fields.js";
import { isLongPattern, isPublishableTipAddress, resolveBatch } from "../../shared/pro.js";
import { consumePaidGrind, ensurePaid, initPay, spendInProgress } from "./pay.js";
import { confirmUnload } from "./unload.js";
import { matchRange, previewParts, splitAtMatch } from "./match-view.js";

const $ = (id) => document.getElementById(id);

const output = $("output");
const stopBtn = $("stop-btn");
const liveStatus = $("live-status");
const form = $("setup");
const patternEl = $("pattern");
const threadsEl = $("threads");
const batchEl = $("batch");
const caseEl = $("case");
const jobEl = $("job");
const gate = $("pay-gate");
const runState = $("run-state");
const readouts = $("readouts");
const roRate = $("ro-rate");
const roAttempts = $("ro-attempts");
const roChance = $("ro-chance");
const addrLabel = $("addr-label");
const addrEl = $("addr");
const addrCopy = $("addr-copy");

const POSITION_WORDS = {
  prefix: "Prefix, the start",
  suffix: "Suffix, the end",
  "prefix-or-suffix": "Either end",
  anywhere: "Anywhere",
};

function announce(text) {
  if (liveStatus) liveStatus.textContent = text;
}

/** A short confirmation. Never an error and never a key: those go in the console. */
function toast(text) {
  if (window.QT?.toast) window.QT.toast(text);
  else announce(text);
}

// ── Security: CSPRNG required ────────────────────────

if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
  output.textContent =
    "FATAL: crypto.getRandomValues is not available. Open this page in a current browser over HTTPS.";
  throw new Error("No CSPRNG available");
}

// ── Console helpers (textContent only) ───────────────

function terminalColumns() {
  if (!output || output.clientWidth < 40) return 28;
  const style = getComputedStyle(output);
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.font = style.font;
  document.body.appendChild(probe);
  const char = probe.getBoundingClientRect().width / 10 || 8;
  probe.remove();
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return Math.max(18, Math.floor((output.clientWidth - pad - 8) / char));
}

/** Under 64 columns the console prints one fact per line instead of a row of them. */
function isNarrow() {
  return terminalColumns() < 64;
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

/** A framed banner, its rows set solid so the box joins with no gaps. */
function printBox(rows) {
  const box = document.createElement("div");
  box.className = "console__box vg-line vg-box";
  box.textContent = rows.join("\n");
  output.appendChild(box);
  scrollToBottom();
  return box;
}

function printRule() {
  const count = Math.max(8, Math.min(41, terminalColumns() - 2));
  print(`  ${"─".repeat(count)}`, "dim");
}

function print(text = "", cls = "") {
  const div = document.createElement("div");
  div.className = "vg-line" + (cls ? " " + cls : "");
  div.textContent = text;
  output.appendChild(div);
  scrollToBottom();
  return div;
}

/** A line whose pattern is marked: the matched address, drawn as text nodes. */
function printAddress(label, address, range) {
  const div = document.createElement("div");
  div.className = "vg-line";
  const [before, hit, after] = splitAtMatch(address, range);
  div.append(label, before);
  if (hit) {
    const mark = document.createElement("mark");
    mark.className = "match";
    mark.textContent = hit;
    div.append(mark);
  }
  div.append(after);
  output.appendChild(div);
  scrollToBottom();
  return div;
}

/**
 * The console follows its newest line, except once a match is printed: then
 * the match stays at the top of the console, so on a short console (a phone)
 * the warnings printed after it never push the key line out of view.
 */
let pinnedLine = null;

function scrollToBottom() {
  if (pinnedLine?.isConnected) {
    const top = parseFloat(getComputedStyle(output).paddingTop) || 0;
    output.scrollTop += pinnedLine.getBoundingClientRect().top - output.getBoundingClientRect().top - top;
    return;
  }
  output.scrollTop = output.scrollHeight;
}

function pinToTop(line) {
  pinnedLine = line;
  scrollToBottom();
}

function clearOutput() {
  pinnedLine = null;
  output.replaceChildren();
}

// ── The address above the console: a preview, then the match ──

/** No pattern yet, or one that cannot match: words in the address row, not a rule of dots. */
function drawAddressNote(text) {
  const span = document.createElement("span");
  span.className = "vg-addr__note";
  span.textContent = text;
  addrEl.replaceChildren(span);
}

function drawAddress(parts, { dim = true } = {}) {
  const [before, hit, after] = parts;
  const nodes = [];
  for (const [text, isHit] of [[before, false], [hit, true], [after, false]]) {
    if (!text) continue;
    if (isHit) {
      const mark = document.createElement("mark");
      mark.className = "match";
      mark.textContent = text;
      nodes.push(mark);
    } else if (dim) {
      const span = document.createElement("span");
      span.className = "vg-addr__dots";
      span.textContent = text;
      nodes.push(span);
    } else {
      nodes.push(document.createTextNode(text));
    }
  }
  addrEl.replaceChildren(...nodes);
}

function showPreview() {
  const pattern = patternEl.value.trim();
  const position = selectedPosition();
  addrCopy.hidden = true;
  if (!pattern || patternProblem(pattern, { requireText: false })) {
    addrLabel.textContent = "Preview";
    drawAddressNote(pattern ? "Fix the pattern to preview it." : "Type a pattern to preview it.");
    return;
  }
  addrLabel.textContent = position === "prefix-or-suffix" ? "Preview, either end" : "Preview";
  drawAddress(previewParts(pattern, position));
}

function showFound(address, range, label) {
  addrLabel.textContent = label;
  drawAddress(splitAtMatch(address, range), { dim: false });
  addrCopy.hidden = false;
}

// ── Clipboard ────────────────────────────────────────

const CLIPBOARD_CLEAR_MS = 60_000;
let clipboardTimer = null;

async function copyPrivateKey(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Clipboard clears in 60s if the browser allows it.");
    if (clipboardTimer) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText();
        if (current === text) {
          await navigator.clipboard.writeText("");
          toast("Clipboard cleared.");
        }
      } catch {
        /* readback is optional; the on-screen wipe still runs */
      }
    }, CLIPBOARD_CLEAR_MS);
  } catch {
    print("  Copy failed. Select the key and copy it yourself.", "warn");
  }
}

const KEY_VISIBLE_MS = 120_000;

function scheduleKeyRedaction(keyElement) {
  setTimeout(() => {
    if (!keyElement.isConnected) return;
    keyElement.textContent = "  Private Key: [REDACTED]";
    keyElement.classList.remove("vg-key--shown");
    keyElement.classList.add("vg-key--redacted");
    keyElement.disabled = true;
    keyElement.replaceWith(keyElement.cloneNode(true));
  }, KEY_VISIBLE_MS);
}

// ── The generator's phases ───────────────────────────
// setup: the form. measuring and pay: the job is fixed, the wallet is asked.
// grinding: workers run. holding: a key is on this tab and not yet wiped.

const PILL = {
  setup: ["Ready", ""],
  stopped: ["Stopped", ""],
  measuring: ["Measuring this device", "pill--running"],
  pay: ["Waiting for payment", "pill--info"],
  grinding: ["Grinding", "pill--running"],
  holding: ["Match found", "pill--ok"],
};

/** The page's Start grinding links. While a run holds the form they lead back to it, unfilled. */
const startLinks = [...document.querySelectorAll("a[data-start]")];

function setPhase(phase, pill = phase) {
  const inSetup = phase === "setup";
  for (const link of startLinks) {
    link.textContent = inSetup ? "Start grinding" : "Back to the run";
    link.classList.toggle("btn--primary", inSetup);
    link.classList.toggle("btn--ghost", !inSetup);
  }
  form.hidden = !inSetup;
  jobEl.hidden = inSetup;
  gate.dataset.step = phase === "pay" ? "pay" : "idle";
  gate.dataset.phase = phase;
  const [word, tone] = PILL[pill];
  runState.textContent = word;
  runState.className = "pill" + (tone ? " " + tone : "");
  readouts.dataset.state = phase === "grinding" ? "running" : phase === "holding" ? "done" : "idle";
  $("job-note").textContent =
    phase === "holding"
      ? "Reveal and save the key in the console. The generator is free again when the console clears."
      : "";
}

function selectedPosition() {
  return form.querySelector('input[name="position"]:checked')?.value || "suffix";
}

function renderSummary(job) {
  const rows = [
    ["Pattern", job.pattern, true],
    ["Position", POSITION_WORDS[job.position], false],
    ["Case", job.caseSensitive ? "Matched" : "Ignored", false],
    ["Threads", String(job.threads), false],
  ];
  if (job.batch > 1) rows.push(["Matches", String(job.batch), false]);
  rows.push(["Odds", formatOdds(job.attempts), false]);
  $("job-summary").replaceChildren(
    ...rows.map(([key, value, mono]) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (mono) dd.className = "mono";
      row.append(dt, dd);
      return row;
    })
  );
}

function focusQuietly(el) {
  el?.focus({ preventScroll: true });
}

// ── Grinding ─────────────────────────────────────────

let workers = [];
let totalAttempts = 0;
let startTime = 0;
let foundCount = 0;
let targetCount = 1;
let grinding = false;
let perMatchAttempts = Infinity;
let attemptsAtLastMatch = 0;
let workerErrors = 0;
let progressTimer = null;
let clearCountdownTimer = null;
let progressLine = null;
let progressText = null;
let currentJob = null;
/** A matched key exists in this tab and has not been wiped yet. */
let holdingKey = false;
/** The run is over, so nothing more will be added to the console. */
let runFinished = false;
/** At least one key has been put on screen. The wipe countdown waits for this. */
let keyRevealed = false;

function stopWorkers() {
  grinding = false;
  if (stopBtn) stopBtn.hidden = true;
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  progressLine?.querySelector(".console__cursor")?.remove();
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

/** A figure that has not been measured: a hatch and words, never a zero. */
function showGap(el, text) {
  const mark = document.createElement("span");
  mark.className = "hatch vg-gap__mark";
  mark.setAttribute("aria-hidden", "true");
  const words = document.createElement("span");
  words.className = "vg-gap";
  words.append(mark, text);
  el.replaceChildren(words);
}

function resetReadouts() {
  showGap(roRate, "Not measured yet");
  roAttempts.textContent = "0";
  showGap(roChance, "Not started");
}

/**
 * The readouts and the console's progress line. At most twice a second
 * (scheduleProgress), and once more with the final count when a run is stopped.
 */
function updateProgress(now = Date.now()) {
  if (!progressText) return;
  const elapsed = (now - startTime) / 1000;
  const rate = elapsed > 0 ? totalAttempts / elapsed : 0;
  const checked = formatAttempts(totalAttempts);
  const rateText = formatAttempts(Math.round(rate));
  roRate.textContent = rateText;
  roAttempts.textContent = checked;
  roChance.textContent = formatProbability(
    foundByNowProbability(totalAttempts - attemptsAtLastMatch, perMatchAttempts)
  );
  const timeText = formatDuration(elapsed);
  progressText.textContent = isNarrow()
    ? `  Checked: ${checked}\n  Rate: ${rateText}/s\n  Time: ${timeText}`
    : `  Checked: ${checked} | Rate: ${rateText}/s | Time: ${timeText}`;
}

function scheduleProgress() {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    updateProgress();
  }, 500);
}

function startClearCountdown() {
  let remaining = 60;
  const countdownLine = print(`  Terminal clears in ${remaining}s.`, "dim");

  clearCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(clearCountdownTimer);
      clearCountdownTimer = null;
      holdingKey = false;
      clearOutput();
      print("  Terminal cleared. The key is no longer on screen.", "dim");
      print();
      backToSetup("stopped", { another: true });
    } else {
      countdownLine.textContent = `  Terminal clears in ${remaining}s.`;
    }
  }, 1000);
}

function showMatch(msg) {
  const range = matchRange(msg.address, currentJob.pattern, currentJob.position, currentJob.caseSensitive);
  if (targetCount === 1) {
    print();
    const width = boxWidth();
    pinToTop(printBox([boxTop(width), boxMid("MATCH FOUND", width), boxBot(width)]));
    showFound(msg.address, range, "Found address");
  } else {
    print();
    pinToTop(print(`  Match ${foundCount} of ${targetCount}`));
    showFound(msg.address, range, `Match ${foundCount} of ${targetCount}`);
  }
  print();
  if (isNarrow()) {
    print("  Address:");
    printAddress("  ", msg.address, range);
  } else {
    printAddress("  Address:     ", msg.address, range);
  }

  // The key stays off the screen until it is asked for. A grind can finish hours
  // after it was started, with nobody watching, and the wipe must not run then.
  holdingKey = true;
  const keyLine = document.createElement("button");
  keyLine.type = "button";
  keyLine.className = "vg-line vg-key";
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
    keyLine.classList.add("vg-key--shown");
    keyLine.title = "Copy the private key";
    announce("Key shown.");
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
  print("  Click the key to copy it. Save it before the terminal clears.", "warn");
  startClearCountdown();
}

function finishRun() {
  stopWorkers();
  runFinished = true;
  setPhase("holding");
  print();
  print(
    targetCount > 1
      ? "  YOUR PRIVATE KEYS ARE ABOVE. Each stays hidden until you click its line."
      : "  YOUR PRIVATE KEY IS ABOVE. It stays hidden until you click that line.",
    "warn"
  );
  print("  It exists only in this tab. Keep the tab open until you have saved it.", "warn");
  print("  The terminal clears 60 seconds after you reveal it.", "warn");
  print("  Anyone with the private key controls that wallet.", "warn");
  print();
  announce("Match found. The private key is hidden until you reveal it. Keep this tab open.");
  startClearCountdownWhenReady();
}

function startGrinding(job) {
  totalAttempts = 0;
  attemptsAtLastMatch = 0;
  startTime = Date.now();
  foundCount = 0;
  targetCount = job.batch;
  perMatchAttempts = job.attempts;
  workerErrors = 0;
  grinding = true;
  runFinished = false;
  keyRevealed = false;
  workers = [];
  setPhase("grinding");
  if (stopBtn) stopBtn.hidden = false;
  resetReadouts();

  progressLine = document.createElement("div");
  progressLine.className = "vg-line";
  progressText = document.createElement("span");
  progressText.textContent = "  Checked: 0 | Rate: …/s | Time: 0s";
  const cursor = document.createElement("span");
  cursor.className = "console__cursor";
  cursor.setAttribute("aria-hidden", "true");
  progressLine.append(progressText, cursor);
  output.appendChild(progressLine);
  scrollToBottom();

  const expected = job.threads;
  for (let i = 0; i < job.threads; i++) {
    const worker = new Worker(new URL("./grind-worker.js", import.meta.url), {
      name: "vanity-grind",
    });

    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === "error") {
        print(`  Worker error: ${msg.message}`, "danger");
        return;
      }
      if (msg.type === "ready") return;

      if (msg.type === "progress") {
        // After Stop the final count is already printed: a late report must not change it.
        if (!grinding) return;
        totalAttempts += msg.count;
        scheduleProgress();
        return;
      }

      if (msg.type === "found" && foundCount < targetCount) {
        foundCount++;
        totalAttempts += msg.attempts;
        updateProgress();
        attemptsAtLastMatch = totalAttempts;
        // The probability readout starts again for the next match.
        if (foundCount < targetCount) roChance.textContent = "0%";
        showMatch(msg);
        if (foundCount >= targetCount) finishRun();
      }
    };

    worker.onerror = (err) => {
      workerErrors++;
      print(`  Worker error: ${err.message || "failed to start"}`, "danger");
      if (grinding && workerErrors >= expected && foundCount === 0) {
        stopWorkers();
        print("  Grinding stopped because the workers did not start.", "danger");
        backToSetup("stopped", { another: true });
      }
    };

    worker.postMessage({ pattern: job.pattern, position: job.position, caseSensitive: job.caseSensitive });
    workers.push(worker);
  }
}

function requestStop() {
  if (!grinding) return;
  const now = Date.now();
  const elapsed = (now - startTime) / 1000;
  const hadMatches = foundCount > 0;
  stopWorkers();
  // The readouts and the progress line show the same final count as the summary below.
  updateProgress(now);
  print();
  print("  Stopped.", "danger");
  print(`  Checked ${formatAttempts(totalAttempts)} keys in ${formatDuration(elapsed)}.`, "dim");
  print();
  if (hadMatches) {
    runFinished = true;
    setPhase("holding");
    print("  The keys found so far are above. Reveal the ones you want to keep.", "warn");
    print("  The terminal clears 60 seconds after the first reveal.", "warn");
    startClearCountdownWhenReady();
  } else {
    backToSetup("stopped", { another: true });
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

// ── Setup ────────────────────────────────────────────

const cpuCount = navigator.hardwareConcurrency || 4;
const maxThreads = cpuCount * 2;

function setError(field, text) {
  const input = $(field);
  const box = $(`${field}-error`);
  $(`${field}-error-text`).textContent = text || "";
  box.hidden = !text;
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

/** The pattern's own problem, in the words the console used, or "" when it is fine. */
function patternProblem(pattern, { requireText }) {
  if (!pattern) return requireText ? "Pattern cannot be empty." : "";
  if (pattern.length > ADDRESS_LENGTH) return "Solana addresses are at most 44 characters.";
  const bad = validatePattern(pattern);
  if (bad.length > 0) {
    return `Invalid character(s): ${bad.map((c) => `'${c}'`).join(", ")}. Base58 omits 0, O, I, and l.`;
  }
  return "";
}

function readThreads() {
  return readCount(
    { raw: threadsEl.value, badInput: threadsEl.validity?.badInput },
    { max: maxThreads, fallback: Math.max(1, cpuCount - 1) }
  );
}

function readBatch() {
  if (!siteConfig.pro.enabled) return { value: 1 };
  const read = readCount(
    { raw: batchEl.value, badInput: batchEl.validity?.badInput },
    { max: siteConfig.pro.maxBatch, fallback: 1 }
  );
  if (read.error) return read;
  const parsed = resolveBatch(read.value, siteConfig.pro);
  if (!parsed.rejected) return { value: parsed.batch };
  return { error: `Enter a number from 1 to ${siteConfig.pro.maxBatch}.` };
}

/**
 * A count field's error appears when the field is left, and goes as soon as
 * the value is fixed, while typing. Leaving the field never removes it: that
 * would move Start grinding between the press and the release of the click
 * that left the field, and the click would be lost.
 */
function watchCount(field, input, read) {
  input.addEventListener("blur", () => {
    const { error } = read();
    if (error) setError(field, error);
  });
  input.addEventListener("input", () => {
    if (input.hasAttribute("aria-invalid") && !read().error) setError(field, "");
  });
}

/** The odds and the warnings beside the form, as the pattern is typed. */
function renderOdds() {
  const pattern = patternEl.value.trim();
  const problem = patternProblem(pattern, { requireText: false });
  setError("pattern", problem);
  showPreview();
  const odds = $("odds");
  const list = $("setup-warnings");
  list.replaceChildren();
  if (!pattern || problem) {
    odds.textContent = pattern ? "Fix the pattern first" : "Type a pattern";
    return;
  }
  const threads = readThreads().value || Math.max(1, cpuCount - 1);
  const job = describeJob({
    pattern,
    position: selectedPosition(),
    caseSensitive: caseEl.checked,
    threads,
    keysPerThread: DEFAULT_KEYS_PER_THREAD,
  });
  odds.textContent = formatOdds(job.attempts);
  // Rarity and case are facts about the pattern. Time warnings wait for this device's measured rate.
  for (const warning of consoleWarnings(job.warnings)) {
    const li = document.createElement("li");
    li.textContent = warning;
    list.appendChild(li);
  }
}

function initSetup() {
  $("cores").textContent = String(navigator.hardwareConcurrency || "?");
  threadsEl.max = String(maxThreads);
  threadsEl.value = String(Math.max(1, cpuCount - 1));
  if (siteConfig.pro.enabled) {
    $("batch-field").hidden = false;
    batchEl.max = String(siteConfig.pro.maxBatch);
    $("batch-max").textContent = String(siteConfig.pro.maxBatch);
  }
  patternEl.addEventListener("input", renderOdds);
  caseEl.addEventListener("change", renderOdds);
  for (const radio of form.querySelectorAll('input[name="position"]')) radio.addEventListener("change", renderOdds);
  watchCount("threads", threadsEl, readThreads);
  watchCount("batch", batchEl, readBatch);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const pattern = patternEl.value.trim();
    const patternError = patternProblem(pattern, { requireText: true });
    const threads = readThreads();
    const batch = readBatch();
    setError("pattern", patternError);
    setError("threads", threads.error || "");
    setError("batch", batch.error || "");
    const firstBad = patternError ? patternEl : threads.error ? threadsEl : batch.error ? batchEl : null;
    if (firstBad) {
      firstBad.focus();
      return;
    }
    runJob({
      pattern,
      position: selectedPosition(),
      caseSensitive: caseEl.checked,
      threads: threads.value,
      batch: batch.value,
    });
  });
  renderOdds();
}

/** Back to the form. After a run (`another`), the console says how to start the next one. */
function backToSetup(pill = "setup", { another = false } = {}) {
  if (clearCountdownTimer) {
    clearInterval(clearCountdownTimer);
    clearCountdownTimer = null;
  }
  setPhase("setup", pill);
  showPreview();
  if (another) print("  Grind another? Set a pattern and press Start grinding.", "dim");
  const active = document.activeElement;
  if (!active || active === document.body || $("generator").contains(active)) focusQuietly(patternEl);
}

function previewLines(pattern, position) {
  const full = (parts) => parts.join("");
  if (!isNarrow()) {
    if (position === "prefix-or-suffix") {
      return [`  Preview:    ${full(previewParts(pattern, "prefix"))}   or   ${full(previewParts(pattern, "suffix"))}`];
    }
    return [`  Preview:    ${full(previewParts(pattern, position))}`];
  }
  const usable = Math.max(pattern.length, Math.min(44, terminalColumns() - 2));
  if (position === "prefix-or-suffix") {
    return [
      "  Preview:",
      `  ${full(previewParts(pattern, "prefix", usable))}`,
      "  or",
      `  ${full(previewParts(pattern, "suffix", usable))}`,
    ];
  }
  return ["  Preview:", `  ${full(previewParts(pattern, position, usable))}`];
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

async function runJob(settings) {
  const { pattern, position, caseSensitive, threads, batch } = settings;
  const job = {
    ...settings,
    ...describeJob({ pattern, position, caseSensitive, threads, keysPerThread: DEFAULT_KEYS_PER_THREAD }),
  };
  currentJob = job;
  pinnedLine = null;
  renderSummary(job);
  setPhase("measuring");
  focusQuietly(jobEl);

  if (siteConfig.pro.enabled && batch > 1) {
    print();
    print(`  Pro is on. You can grind up to ${siteConfig.pro.maxBatch} matches in this run.`, "dim");
  } else if (!siteConfig.pro.enabled && isLongPattern(pattern, siteConfig.pro)) {
    print();
    print("  Pro notice: this pattern is past the free-length hint.", "warn");
    print("  Batch mode is off on this deploy. One address still grinds in this tab.", "warn");
    print("  Nothing you type is uploaded.", "warn");
  }

  print();
  printRule();
  for (const [text, tone] of planLines(job, { narrow: isNarrow() })) print(text, tone);
  print("  Measuring this device…", "dim");
  const perWorker = await benchmarkDevice();
  for (const [text, tone] of deviceLines(perWorker, threads, { narrow: isNarrow() })) print(text, tone);
  for (const line of previewLines(pattern, position)) print(line, line.trim() === "or" ? "dim" : "");
  print(
    caseSensitive
      ? "  The preview uses the case you typed."
      : "  A case-insensitive grind also keeps the other case.",
    "dim"
  );
  for (const warning of consoleWarnings(job.warnings)) print(`  ${warning}`, "warn");
  printRule();
  print();
  print("  Pay $1 to start grinding.", "warn");
  print("  Waiting for payment…", "warn");

  setPhase("pay");
  focusQuietly($("pay-wallet"));
  const paid = await ensurePaid();
  if (!paid.ok) {
    print(`  ${paid.message || "Payment was not completed."}`, "warn");
    print();
    backToSetup();
    return;
  }

  const spent = await consumePaidGrind();
  if (!spent.ok) {
    print(`  ${spent.message}`, "danger");
    print();
    backToSetup();
    return;
  }

  print();
  print(`  Grinding with ${threads} worker${threads === 1 ? "" : "s"}…`);
  print("  Press Stop, Esc, or Ctrl+C to stop.", "dim");
  print();
  announce(`Grinding ${pattern}. ${threads} workers.`);
  startGrinding(job);
}

function boot() {
  const width = boxWidth();
  printBox([boxTop(width), boxMid("VANITYGRINDER", width), boxMid(bannerSubtitle(width), width), boxBot(width)]);
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
    print("  Base58: 1-9 A-H J-N P-Z a-k m-z");
    print("  Excluded: 0 O I l", "warn");
  } else {
    print("  Base58:   1-9  A-H  J-N  P-Z  a-k  m-z");
    print("  Excluded: 0 (zero)  O (cap-o)  I (cap-i)  l (low-L)", "warn");
  }
  print();
  print("  Set a pattern, then press Start grinding.", "dim");
  setPhase("setup");
}

// Links to the pattern field put the cursor in it. While a run holds the form, they go to the run.
document.querySelectorAll('a[href="#pattern"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    if (form.hidden) {
      event.preventDefault();
      $("generator").scrollIntoView({ block: "start" });
      focusQuietly(jobEl);
      return;
    }
    setTimeout(() => focusQuietly(patternEl), 0);
  });
});

// ── Estimator ────────────────────────────────────────

function kvRow(label, value) {
  const row = document.createElement("div");
  const k = document.createElement("dt");
  k.textContent = label;
  const v = document.createElement("dd");
  v.textContent = value;
  row.append(k, v);
  return row;
}

const ESTIMATE_SETTLE_MS = 700;

function initEstimator() {
  const estForm = $("est-form");
  if (!estForm) return;
  estForm.addEventListener("submit", (event) => event.preventDefault());

  const estPattern = $("est-pattern");
  const lengthEl = $("est-length");
  const lengthVal = $("est-length-val");
  const positionEl = $("est-position");
  const estCase = $("est-case");
  const estThreads = $("est-threads");
  const rateEl = $("est-rate");
  const result = $("est-result");

  estThreads.value = String(Math.max(1, cpuCount - 1));
  rateEl.value = String(DEFAULT_KEYS_PER_THREAD);

  function render() {
    const typed = estPattern.value.trim();
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
    const threads = Math.min(64, Math.max(1, parseInt(estThreads.value, 10) || 1));
    const rate = Math.min(100_000, Math.max(100, parseInt(rateEl.value, 10) || DEFAULT_KEYS_PER_THREAD));
    const job = describeJob({
      pattern,
      position: positionEl.value,
      caseSensitive: estCase.checked,
      threads,
      keysPerThread: rate,
    });

    const label = document.createElement("p");
    label.className = "vg-est__label";
    label.textContent = "Expected attempts";
    const figure = document.createElement("p");
    figure.className = "vg-est__figure";
    figure.textContent = `~${formatAttempts(job.attempts)}`;
    const facts = document.createElement("dl");
    facts.className = "kv";
    facts.append(kvRow("Rough time", formatEstimate(job.seconds)), kvRow("Assumed speed", `${formatAttempts(job.rate)} keys/s`));
    const parts = [label, figure, facts];
    if (!typed) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent =
        "No pattern typed. This estimates a letter pattern of the chosen length. Type one to include digits and prefix bias.";
      parts.push(note);
    }
    if (job.warnings.length) {
      const list = document.createElement("ul");
      list.className = "vg-warnings";
      for (const warning of job.warnings) {
        const li = document.createElement("li");
        li.textContent = warning;
        list.appendChild(li);
      }
      parts.push(list);
    }
    result.replaceChildren(...parts);
    return `Expected attempts ${figure.textContent}. Rough time ${formatEstimate(job.seconds)}.`;
  }

  // The result redraws on every keystroke and slider step; a screen reader hears
  // one short sentence once the input has settled, not the whole block each time.
  const live = $("est-live");
  let settle = null;
  function update() {
    const sentence = render();
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (live) live.textContent = sentence;
    }, ESTIMATE_SETTLE_MS);
  }

  for (const el of [estPattern, lengthEl, positionEl, estCase, estThreads, rateEl]) {
    el.addEventListener("input", update);
    el.addEventListener("change", update);
  }
  render();
}

// ── Tip + Pro ────────────────────────────────────────

function initSupport() {
  const tipAddress = $("tip-address");
  const tipCopy = $("tip-copy");
  const tipNote = $("tip-note");
  if (tipAddress && isPublishableTipAddress(siteConfig.tipAddress)) {
    tipAddress.textContent = siteConfig.tipAddress.trim();
    if (tipCopy) tipCopy.hidden = false;
    if (tipNote) {
      tipNote.textContent =
        "Public address only. A tip is optional. The grind is $1 in USDC per grind, paid from your wallet, and is checked separately.";
    }
  }

  const status = $("pro-status");
  const lead = $("pro-lead");
  if (!status || !lead) return;
  if (siteConfig.pro.enabled) {
    status.textContent = "On";
    lead.textContent = `Pro is on for this build: up to ${siteConfig.pro.maxBatch} matches per run, still generated in this tab. There is no checkout.`;
  } else {
    status.textContent = "Off";
  }
}

initSetup();
initEstimator();
initSupport();
initPay();
boot();
