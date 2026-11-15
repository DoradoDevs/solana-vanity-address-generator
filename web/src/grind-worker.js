/* VanityGrinder — browser grind worker.
   Bundled by Vite into a same-origin module worker.
   Must not fetch, beacon, or open a socket. Matches go back to the page
   through postMessage and nowhere else. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeBase58 } from "../../shared/base58.js";
import { matchesAddress } from "../../shared/match.js";
import { assembleSecretKey } from "../../shared/secret.js";

const POSITIONS = new Set(["prefix", "suffix", "prefix-or-suffix", "anywhere"]);

const selfTestOk =
  encodeBase58(new Uint8Array(32)) === "11111111111111111111111111111111";

if (!selfTestOk) {
  self.postMessage({ type: "error", message: "Base58 self-test failed" });
} else {
  self.postMessage({ type: "ready" });
}

const yieldChannel = new MessageChannel();
let yieldResolve = null;
yieldChannel.port1.onmessage = () => {
  const resolve = yieldResolve;
  yieldResolve = null;
  if (resolve) resolve();
};

function yieldThread() {
  return new Promise((resolve) => {
    yieldResolve = resolve;
    yieldChannel.port2.postMessage(null);
  });
}

let stopped = false;
let running = false;

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.command === "stop") {
    stopped = true;
    return;
  }
  if (!selfTestOk || running) return;
  running = true;
  stopped = false;
  if (data.command === "bench") {
    bench(data.ms)
      .catch((err) => {
        self.postMessage({ type: "error", message: err?.message || String(err) });
      })
      .finally(() => {
        running = false;
      });
    return;
  }
  grind(data).catch((err) => {
    self.postMessage({ type: "error", message: err?.message || String(err) });
  });
};

async function bench(ms) {
  const duration = Math.min(4000, Math.max(1500, Number(ms) || 2500));
  const priv = new Uint8Array(32);
  const t0 = performance.now();
  let count = 0;
  try {
    while (!stopped && performance.now() - t0 < duration) {
      crypto.getRandomValues(priv);
      encodeBase58(ed25519.getPublicKey(priv));
      priv.fill(0);
      count++;
    }
    const elapsed = Math.max(1, performance.now() - t0);
    self.postMessage({
      type: "bench",
      count,
      ms: elapsed,
      keysPerSec: Math.round((count * 1000) / elapsed),
    });
  } finally {
    priv.fill(0);
  }
}

async function grind(data) {
  const { pattern, position } = data;
  const caseSensitive = data.caseSensitive === true;

  if (!pattern || !POSITIONS.has(position)) {
    self.postMessage({ type: "error", message: "Bad grind settings" });
    running = false;
    return;
  }

  let batchSize = 50;
  let tuned = false;
  const priv = new Uint8Array(32);

  try {
    while (!stopped) {
      const t0 = performance.now();
      let pending = 0;

      for (let i = 0; i < batchSize && !stopped; i++) {
        crypto.getRandomValues(priv);
        const pub = ed25519.getPublicKey(priv);
        const address = encodeBase58(pub);
        pending++;

        if (matchesAddress(address, pattern, position, caseSensitive)) {
          const privateKey = assembleSecretKey(priv, pub);
          priv.fill(0);
          self.postMessage({
            type: "found",
            address,
            privateKey,
            attempts: pending,
          });
          pending = 0;
        } else {
          priv.fill(0);
        }
      }

      const elapsed = performance.now() - t0;
      if (!tuned && elapsed > 0) {
        const keysPerMs = batchSize / elapsed;
        batchSize = Math.max(50, Math.min(10000, Math.round(keysPerMs * 250)));
        tuned = true;
      }

      if (pending > 0) {
        self.postMessage({ type: "progress", count: pending });
        pending = 0;
      }

      if (stopped) break;
      await yieldThread();
    }
  } finally {
    priv.fill(0);
    running = false;
  }
}
