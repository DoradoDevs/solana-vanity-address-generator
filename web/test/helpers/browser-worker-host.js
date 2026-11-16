// Runs a browser dedicated-worker module inside a Node worker thread: `self`,
// `postMessage` and `onmessage` are wired to the parent port. Lets the tests
// drive the real web/src/grind-worker.js, message for message.
import { parentPort, workerData } from "node:worker_threads";

globalThis.self = globalThis;
globalThis.postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", (data) => globalThis.onmessage?.({ data }));

await import(workerData.module);
