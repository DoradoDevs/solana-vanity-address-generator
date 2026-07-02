const output = document.getElementById("output");
const inputLine = document.getElementById("input-line");
const inputEl = document.getElementById("input");

const BASE58_CHARS =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ── Matrix rain background ───────────────────────────

function initMatrix() {
  const canvas = document.getElementById("matrix-bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  const chars = BASE58_CHARS;
  const fontSize = 14;
  let columns = Math.floor(canvas.width / fontSize);
  let drops = new Array(columns).fill(1);

  window.addEventListener("resize", () => {
    columns = Math.floor(canvas.width / fontSize);
    drops = new Array(columns).fill(1);
  });

  function draw() {
    ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#00ff41";
    ctx.font = `${fontSize}px monospace`;

    for (let i = 0; i < drops.length; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)];
      ctx.fillText(char, i * fontSize, drops[i] * fontSize);
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
    requestAnimationFrame(draw);
  }
  draw();
}

initMatrix();

// ── Security: verify CSPRNG ──────────────────────────

if (
  typeof crypto === "undefined" ||
  typeof crypto.getRandomValues !== "function"
) {
  document.getElementById("output").textContent =
    "FATAL: crypto.getRandomValues not available. Use a modern browser over HTTPS.";
  throw new Error("No CSPRNG available");
}

// ── Helpers (textContent only — zero innerHTML) ──────

function print(text = "", cls = "") {
  const div = document.createElement("div");
  div.className = "line" + (cls ? " " + cls : "");
  div.textContent = text;
  output.appendChild(div);
  scrollToBottom();
}

async function typeText(text, cls = "", speed = 20) {
  const div = document.createElement("div");
  div.className = "line typing" + (cls ? " " + cls : "");
  output.appendChild(div);
  scrollToBottom();
  for (let i = 0; i < text.length; i++) {
    div.textContent = text.substring(0, i + 1);
    scrollToBottom();
    await new Promise((r) => setTimeout(r, speed));
  }
  div.classList.remove("typing");
  return div;
}

function getLastLine() {
  return output.querySelector(".line:last-child");
}

function updateLastLine(text, cls) {
  const last = getLastLine();
  if (last) {
    last.textContent = text;
    if (cls !== undefined) last.className = "line " + cls;
  }
}

function scrollToBottom() {
  const terminal = document.getElementById("terminal");
  terminal.scrollTop = terminal.scrollHeight;
}

function formatNumber(n) {
  return n.toLocaleString();
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── First character probability ──────────────────────

const COMMON_FIRST_CHARS = "23456789ABCDEFGHJ";

function firstCharProbability(ch, caseSensitive) {
  if (!caseSensitive) {
    const upper = ch.toUpperCase();
    const lower = ch.toLowerCase();
    const upperCommon = COMMON_FIRST_CHARS.includes(upper);
    const lowerCommon = COMMON_FIRST_CHARS.includes(lower);
    if (upperCommon && lowerCommon) return 2 * (1 / 17);
    if (upperCommon || lowerCommon) return 1 / 17 + 1 / 1000;
    if (ch === "1") return 1 / 250;  // digit, no case variant
    return 2 * (1 / 1000);
  }
  if (COMMON_FIRST_CHARS.includes(ch)) return 1 / 17;  // ~5.9%
  if (ch === "1") return 1 / 250;                        // ~0.4%
  return 1 / 1000;                                       // ~0.1%
}

// Returns "common", "uncommon", or "rare"
function prefixRarity(pattern, caseSensitive) {
  const ch = pattern[0];
  if (caseSensitive) {
    if (COMMON_FIRST_CHARS.includes(ch)) return "common";
    if (ch === "1") return "uncommon";
    return "rare";
  }
  // Case insensitive — common if either case is in the common set
  if (COMMON_FIRST_CHARS.includes(ch.toUpperCase()) ||
      COMMON_FIRST_CHARS.includes(ch.toLowerCase())) return "common";
  if (ch === "1") return "uncommon";
  return "rare";
}

function estimateDifficulty(pattern, position, caseSensitive) {
  const charsPerPos = caseSensitive ? 58 : 34;
  if (position === "prefix") {
    const firstProb = firstCharProbability(pattern[0], caseSensitive);
    const restProb = 1 / Math.pow(charsPerPos, pattern.length - 1);
    return Math.round(1 / (firstProb * restProb));
  }
  if (position === "prefix-or-suffix") {
    // Prefix probability
    const firstProb = firstCharProbability(pattern[0], caseSensitive);
    const restProb = 1 / Math.pow(charsPerPos, pattern.length - 1);
    const prefixProb = firstProb * restProb;
    // Suffix probability (uniform)
    const suffixProb = 1 / Math.pow(charsPerPos, pattern.length);
    // Combined: P(prefix OR suffix) ≈ P(prefix) + P(suffix) for small probabilities
    return Math.round(1 / (prefixProb + suffixProb));
  }
  let expected = Math.pow(charsPerPos, pattern.length);
  if (position === "anywhere") {
    expected = expected / Math.max(1, 44 - pattern.length);
  }
  return Math.round(expected);
}

function validatePattern(pattern) {
  const errors = [];
  for (const ch of pattern) {
    if (!BASE58_CHARS.includes(ch)) errors.push(ch);
  }
  return [...new Set(errors)];
}

// ── Clipboard with auto-clear ────────────────────────

const CLIPBOARD_CLEAR_MS = 60_000;
let clipboardTimer = null;

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

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied! Clipboard auto-clears in 60s.");
    if (clipboardTimer) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText();
        if (current === text) {
          await navigator.clipboard.writeText("");
          showToast("Clipboard cleared for security.");
        }
      } catch {}
    }, CLIPBOARD_CLEAR_MS);
  } catch {
    showToast("Copy failed - use manual selection");
  }
}

// ── Key auto-redaction ───────────────────────────────

const KEY_VISIBLE_MS = 120_000;

function scheduleKeyRedaction(keyElement) {
  setTimeout(() => {
    if (keyElement && keyElement.parentNode) {
      keyElement.textContent = "  Private Key: [REDACTED]";
      keyElement.classList.remove("key");
      keyElement.classList.add("dim");
      keyElement.style.cursor = "default";
      keyElement.replaceWith(keyElement.cloneNode(true));
    }
  }, KEY_VISIBLE_MS);
}

// ── Input ────────────────────────────────────────────

let resolveInput = null;

function waitForInput(prompt = "> ") {
  document.getElementById("prompt").textContent = prompt;
  inputLine.classList.remove("hidden");
  inputEl.value = "";
  inputEl.focus();
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
    const r = resolveInput;
    resolveInput = null;
    r(val);
  }
});

document.getElementById("terminal").addEventListener("click", () => {
  if (!inputLine.classList.contains("hidden")) {
    inputEl.focus();
  }
});

// ── Grinding ─────────────────────────────────────────

let workers = [];
let totalAttempts = 0;
let startTime = 0;
let found = false;
let grinding = false;

function stopWorkers() {
  for (const w of workers) {
    w.terminate();
  }
  workers = [];
  grinding = false;
}

let clearCountdownTimer = null;

function startClearCountdown() {
  let remaining = 60;
  const countdownLine = document.createElement("div");
  countdownLine.className = "line dim";
  countdownLine.textContent = `  Terminal clears in ${remaining}s...`;
  output.appendChild(countdownLine);
  scrollToBottom();

  clearCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(clearCountdownTimer);
      clearCountdownTimer = null;
      output.innerHTML = "";
      print("  Terminal cleared for security.", "dim");
      print();
      promptRestart();
    } else {
      countdownLine.textContent = `  Terminal clears in ${remaining}s...`;
    }
  }, 1000);
}

// Ctrl+C to stop grinding
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "c" && grinding && !found) {
    e.preventDefault();
    stopWorkers();
    const elapsed = (Date.now() - startTime) / 1000;
    print();
    print("  ^C", "red");
    print(
      `  Stopped. Checked ${formatNumber(totalAttempts)} keys in ${formatTime(Math.round(elapsed))}.`,
      "dim"
    );
    print();
    promptRestart();
  }
});

function startGrinding(pattern, position, caseSensitive, threadCount) {
  totalAttempts = 0;
  startTime = Date.now();
  found = false;
  grinding = true;
  workers = [];

  // Create a direct reference to the progress line (don't rely on :last-child)
  const progressLine = document.createElement("div");
  progressLine.className = "line progress";
  progressLine.textContent = "  Checked: 0 | Rate: .../s | Time: 0s";
  output.appendChild(progressLine);
  scrollToBottom();

  function updateProgress() {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? Math.round(totalAttempts / elapsed) : 0;
    progressLine.textContent =
      `  Checked: ${formatNumber(totalAttempts)} | Rate: ${formatNumber(rate)}/s | Time: ${formatTime(Math.round(elapsed))}`;
  }

  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker("/worker.js");

    worker.onmessage = (e) => {
      const msg = e.data;

      if (msg.type === "error") {
        print(`  Worker error: ${msg.message}`, "red");
        return;
      }

      if (msg.type === "ready") return;

      if (msg.type === "speed") {
        print(`  Worker speed: ~${formatNumber(msg.keysPerSec)} keys/s per thread (batch=${msg.batchSize})`, "dim");
        return;
      }

      if (msg.type === "progress") {
        totalAttempts += msg.count;
        updateProgress();
      }

      if (msg.type === "found" && !found) {
        found = true;
        grinding = false;
        totalAttempts += msg.attempts;
        updateProgress();

        print();
        print(
          "  ╔═══════════════════════════════════════════════════╗",
          "box glow"
        );
        print(
          "  ║                  MATCH FOUND!                    ║",
          "box glow"
        );
        print(
          "  ╚═══════════════════════════════════════════════════╝",
          "box glow"
        );
        print();
        print(`  Address:     ${msg.address}`, "bright");
        print();

        const keyLine = document.createElement("div");
        keyLine.className = "line key";
        keyLine.textContent = `  Private Key: ${msg.privateKey}`;
        keyLine.title = "Click to copy private key";
        keyLine.addEventListener("click", () =>
          copyToClipboard(msg.privateKey)
        );
        output.appendChild(keyLine);
        scheduleKeyRedaction(keyLine);

        print();
        print(`  Attempts:    ${formatNumber(totalAttempts)}`, "dim");
        const elapsed = (Date.now() - startTime) / 1000;
        print(`  Time:        ${formatTime(Math.round(elapsed))}`, "dim");
        print();
        print("  SAVE YOUR PRIVATE KEY NOW. Click it to copy.", "amber");
        print();

        stopWorkers();
        startClearCountdown();
      }
    };

    worker.onerror = (err) => {
      print(`  Worker error: ${err.message}`, "red");
    };

    worker.postMessage({ pattern, position, caseSensitive });
    workers.push(worker);
  }
}

// ── Main flow ────────────────────────────────────────

async function promptRestart() {
  if (clearCountdownTimer) {
    clearInterval(clearCountdownTimer);
    clearCountdownTimer = null;
  }
  const answer = await waitForInput("  Grind another? [Y/n] > ");
  hideInput();
  if (answer.trim().toLowerCase() === "n") {
    print();
    print("  Session ended. Refresh to start over.", "dim");
    return;
  }
  print();
  await runSetup();
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
    const bad = validatePattern(pattern);
    if (bad.length > 0) {
      print(
        `  Invalid character(s): ${bad.map((c) => `'${c}'`).join(", ")}`,
        "red"
      );
      print("  Only Base58 chars allowed (no 0, O, I, l).", "red");
      print();
      continue;
    }
    break;
  }

  print();
  print("  Where should the pattern appear?");
  print("  [1] Prefix  (start of address)");
  print("  [2] Suffix  (end of address)");
  print("  [3] Prefix or Suffix");
  print("  [4] Anywhere in address");
  print();

  let position;
  while (true) {
    const choice = (await waitForInput("  Choice [1/2/3/4] > ")).trim();
    hideInput();
    if (choice === "1") { position = "prefix"; break; }
    if (choice === "2") { position = "suffix"; break; }
    if (choice === "3") { position = "prefix-or-suffix"; break; }
    if (choice === "4") { position = "anywhere"; break; }
    print("  Please enter 1, 2, 3, or 4.", "red");
  }

  print();
  let caseSensitive;
  while (true) {
    const choice = (await waitForInput("  Case sensitive? [y/N] > "))
      .trim()
      .toLowerCase();
    hideInput();
    if (choice === "" || choice === "n") { caseSensitive = false; break; }
    if (choice === "y") { caseSensitive = true; break; }
    print("  Please enter y or n.", "red");
  }

  const cpuCount = navigator.hardwareConcurrency || 4;
  const defaultThreads = Math.max(1, cpuCount - 1);
  print();
  let threadCount;
  while (true) {
    const input = (
      await waitForInput(`  Worker threads [${defaultThreads}] > `)
    ).trim();
    hideInput();
    if (input === "") { threadCount = defaultThreads; break; }
    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= cpuCount * 2) { threadCount = n; break; }
    print(`  Enter a number between 1 and ${cpuCount * 2}.`, "red");
  }

  const estimated = estimateDifficulty(pattern, position, caseSensitive);
  // Estimate ~1500 keys/sec per thread as a conservative baseline
  const keysPerSec = threadCount * 1500;
  const estSeconds = Math.round(estimated / keysPerSec);

  print();
  print("  ─────────────────────────────────────────", "dim");
  print(`  Pattern:    "${pattern}"`, "bright");
  print(`  Position:   ${position}`);
  print(`  Case:       ${caseSensitive ? "sensitive" : "insensitive"}`);
  print(`  Threads:    ${threadCount}`);
  print(`  Est. time:  ~${formatTime(estSeconds)}`, "dim");

  if (estSeconds > 600) {
    print();
    print(`  This could take a while. For faster results:`, "amber");
    print("  - Use 1-3 character patterns", "amber");
    print("  - Try prefix or suffix position", "amber");
    print("  - Turn off case sensitivity", "amber");
  }

  print("  ─────────────────────────────────────────", "dim");
  print();

  const confirm = (await waitForInput("  Start grinding? [Y/n] > "))
    .trim()
    .toLowerCase();
  hideInput();

  if (confirm === "n") {
    print("  Aborted.", "dim");
    print();
    await runSetup();
    return;
  }

  print();
  print(`  Grinding with ${threadCount} threads...`, "bright");
  print("  Press Ctrl+C to stop.", "dim");
  print();

  startGrinding(pattern, position, caseSensitive, threadCount);
}

// ── Boot ─────────────────────────────────────────────

async function boot() {
  hideInput();
  await new Promise((r) => setTimeout(r, 400));

  await typeText("  Initializing Vanity Wallet Grinder...", "dim", 25);
  await new Promise((r) => setTimeout(r, 300));

  print();
  print(
    "  ╔═══════════════════════════════════════════════════╗",
    "box"
  );
  print(
    "  ║                                                   ║",
    "box"
  );
  print(
    "  ║       VANITY WALLET GRINDER  v1.0                 ║",
    "box"
  );
  print(
    "  ║       Solana Vanity Address Generator              ║",
    "box"
  );
  print(
    "  ║                                                   ║",
    "box"
  );
  print(
    "  ╚═══════════════════════════════════════════════════╝",
    "box"
  );
  print();

  await new Promise((r) => setTimeout(r, 150));

  const cores = navigator.hardwareConcurrency || "?";
  await typeText(`  System:   ${cores} CPU cores detected`, "dim", 15);
  await typeText("  Crypto:   @noble/curves ed25519 (CSPRNG)", "dim", 15);
  await typeText("  Network:  NONE — fully offline", "dim", 15);
  await typeText("  Security: keys auto-redact after 2min", "dim", 15);
  await typeText("  Status:   Ready", "bright", 15);

  print();
  print("  Valid characters (Base58):");
  print("  1-9  A-H  J-N  P-Z  a-k  m-z", "bright");
  print();
  print("  Excluded: 0 (zero)  O (cap-o)  I (cap-i)  l (low-L)", "amber");
  print();

  await runSetup();
}

boot();
