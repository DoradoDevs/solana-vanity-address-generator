// The published output, checked after a real production build: what is in
// dist/ is what Netlify serves.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import {
  PRODUCTION_CSP,
  WORKER_CSP,
  WORKER_FILE_PATTERN,
  headerRules,
  headersForPath,
  inlineCodeIn,
  parseNetlifyHeaders,
  renderNetlifyHeaders,
} from "../src/headers.js";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const readDist = (file) => fs.readFileSync(path.join(dist, file), "utf8");
const assets = () => fs.readdirSync(path.join(dist, "assets")).map((file) => `assets/${file}`);

function build(extraEnv = {}) {
  // Run Vite's own entry with this Node, so the test behaves the same on every OS.
  return execFileSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "pipe",
    encoding: "utf8",
  });
}

before(() => {
  build();
});

test("the build writes the headers file, with a rule for the worker it just built", () => {
  const workers = assets().filter((file) => WORKER_FILE_PATTERN.test(file));
  assert.equal(workers.length, 1);
  const expected = headerRules(workers.map((file) => `/${file}`));
  assert.equal(readDist("_headers"), renderNetlifyHeaders(expected));

  const rules = parseNetlifyHeaders(readDist("_headers"));
  assert.equal(headersForPath(rules, "/")["Content-Security-Policy"], PRODUCTION_CSP);
  assert.equal(headersForPath(rules, `/${workers[0]}`)["Content-Security-Policy"], WORKER_CSP);
  for (const file of assets().filter((name) => !WORKER_FILE_PATTERN.test(name))) {
    assert.equal(headersForPath(rules, `/${file}`)["Content-Security-Policy"], PRODUCTION_CSP, file);
  }
  // Every rule points at a real file or is a prefix rule.
  for (const rule of rules) {
    if (rule.path.endsWith("/*")) continue;
    assert.ok(fs.existsSync(path.join(dist, rule.path)), rule.path);
  }
});

test("no published page needs a CSP exception, and each loads code only from this site", () => {
  const pages = fs.readdirSync(dist).filter((name) => name.endsWith(".html"));
  assert.deepEqual(pages.sort(), ["404.html", "index.html"]);
  for (const page of pages) {
    const html = readDist(page);
    assert.deepEqual(inlineCodeIn(html), [], page);
    const loaded = [
      ...[...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]),
      ...[...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((tag) => tag[0].match(/href="([^"]+)"/)[1]),
    ];
    assert.ok(loaded.length > 0, page);
    for (const url of loaded) {
      assert.match(url, /^\/[^/]/, `${page} loads ${url}`);
      assert.ok(fs.existsSync(path.join(dist, url)), `${page} loads ${url}, which was not built`);
    }
  }
});

test("the built worker, where keys are made, contains no way to send, store or load anything", () => {
  const worker = readDist(assets().find((file) => WORKER_FILE_PATTERN.test(file)));
  for (const api of [
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "sendBeacon",
    "importScripts",
    "indexedDB",
    "localStorage",
    "sessionStorage",
    "BroadcastChannel",
    "caches.",
    "new Worker",
    "console.",
    "eval(",
    "http://",
    "https://",
  ]) {
    assert.equal(worker.includes(api), false, `worker bundle contains ${api}`);
  }
});

test("the built page talks only to /api/ on its own origin and keeps nothing but the payment claim", () => {
  const scripts = assets().filter((file) => file.endsWith(".js") && !WORKER_FILE_PATTERN.test(file));
  assert.equal(scripts.length, 1);
  const page = readDist(scripts[0]);

  // Every fetch in the bundle starts with a literal /api/ path: none takes a computed URL.
  const fetches = [...page.matchAll(/fetch\((["`])([^"`]*)/g)].map((match) => match[2]);
  assert.equal(fetches.length, (page.match(/fetch\(/g) || []).length);
  // One: the page calls its own functions through one helper. The price and payee are in the bundle, not fetched.
  assert.equal(fetches.length, 1);
  for (const target of fetches) assert.match(target, /^\/api\//);

  for (const api of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "sessionStorage", "indexedDB", "document.cookie", "eval("]) {
    assert.equal(page.includes(api), false, `page bundle contains ${api}`);
  }
  // The only outside addresses are the two wallet deep links a phone user can tap.
  const hosts = [...new Set((page.match(/https?:\/\/[A-Za-z0-9.-]+/g) || []))].sort();
  assert.deepEqual(hosts, ["https://phantom.app", "https://solflare.com"]);
  assert.equal((page.match(/localStorage/g) || []).length, 1);
  assert.equal(page.includes("vg-pay-claim"), true);

  for (const bundle of [page]) {
    assert.equal(bundle.includes("vg-dev-bypass"), false);
    assert.equal(bundle.includes("?dev=1"), false);
    assert.equal(bundle.includes('get("dev")'), false);
    assert.equal(bundle.includes("/.netlify/functions/"), false);
  }
});

test("the build stops if a page gains inline code, instead of shipping a page the policy breaks", () => {
  const page = path.join(root, "public", "zz-inline-probe.html");
  fs.writeFileSync(page, "<!DOCTYPE html><title>probe</title><style>body{color:red}</style>");
  try {
    assert.throws(
      () => build(),
      (error) => /zz-inline-probe\.html has inline code that the Content-Security-Policy blocks/.test(`${error.stdout}${error.stderr}`)
    );
  } finally {
    fs.rmSync(page);
    build();
  }
  assert.equal(fs.existsSync(path.join(dist, "zz-inline-probe.html")), false);
});
