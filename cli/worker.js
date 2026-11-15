import { parentPort, workerData } from "node:worker_threads";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeBase58 } from "../shared/base58.js";
import { matchesAddress } from "../shared/match.js";
import { assembleSecretKey } from "../shared/secret.js";

if (encodeBase58(new Uint8Array(32)) !== "11111111111111111111111111111111") {
  throw new Error("Base58 self-test failed");
}

const { pattern, position, caseSensitive } = workerData;
if (!pattern || !position) {
  throw new Error("Missing workerData");
}

let attempts = 0;
let reported = 0;

for (;;) {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  const address = encodeBase58(pub);
  attempts++;

  if (matchesAddress(address, pattern, position, caseSensitive === true)) {
    const privateKey = assembleSecretKey(priv, pub);
    priv.fill(0);
    parentPort.postMessage({
      type: "found",
      address,
      privateKey,
      attempts: attempts - reported,
    });
    break;
  }

  priv.fill(0);

  if (attempts % 5000 === 0) {
    parentPort.postMessage({ type: "progress", count: attempts - reported });
    reported = attempts;
  }
}
