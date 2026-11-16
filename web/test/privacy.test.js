// What the page is allowed to reach, checked on the source. The built output
// is checked in build.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  PRODUCTION_CSP,
  WORKER_CSP,
  headerRules,
  headersForPath,
  inlineCodeIn,
  parseNetlifyHeaders,
  renderNetlifyHeaders,
} from "../src/headers.js";
import { siteConfig } from "../src/site.config.js";
import { DEFAULT_PAY_TO } from "../netlify/functions/lib/constants.js";
import { isPublishableTipAddress } from "../../shared/pro.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const exists = (rel) => fs.existsSync(new URL(rel, import.meta.url));

function directives(csp) {
  return Object.fromEntries(
    csp.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    })
  );
}

test("the page may connect only to its own origin, and names no other host", () => {
  const csp = directives(PRODUCTION_CSP);
  assert.deepEqual(csp["connect-src"], ["'self'"]);
  assert.deepEqual(csp["script-src"], ["'self'"]);
  assert.deepEqual(csp["style-src"], ["'self'"]);
  assert.deepEqual(csp["worker-src"], ["'self'"]);
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepEqual(csp["form-action"], ["'none'"]);
  // No host, no scheme-wide source, no wildcard, no hash, no inline or eval allowance.
  assert.doesNotMatch(PRODUCTION_CSP, /https?:|wss?:|\*|blob:|'sha\d+-|'nonce-|unsafe-inline|unsafe-eval|netlify\.app|localhost/i);
  for (const sources of Object.values(csp)) {
    for (const source of sources) assert.ok(["'self'", "'none'", "data:"].includes(source), source);
  }
  assert.deepEqual(csp["img-src"], ["'self'", "data:"]);
});

test("the grind worker gets a policy of its own that allows nothing", () => {
  assert.deepEqual(directives(WORKER_CSP), { "default-src": ["'none'"], "frame-ancestors": ["'none'"] });
  const rules = headerRules(["/assets/grind-worker-abc123.js"]);
  const worker = headersForPath(rules, "/assets/grind-worker-abc123.js");
  assert.equal(worker["Content-Security-Policy"], WORKER_CSP);
  assert.equal(worker["X-Content-Type-Options"], "nosniff");
  assert.match(worker["Cache-Control"], /immutable/);
  // Everything else, including other scripts, gets the page policy.
  for (const path of ["/", "/index.html", "/assets/index-abc.js", "/assets/index-abc.css", "/404.css", "/nope"]) {
    assert.equal(headersForPath(rules, path)["Content-Security-Policy"], PRODUCTION_CSP, path);
    assert.equal(headersForPath(rules, path)["X-Frame-Options"], "DENY", path);
  }
  assert.match(headersForPath(rules, "/")["Cache-Control"], /max-age=0, must-revalidate/);
  assert.deepEqual(parseNetlifyHeaders(renderNetlifyHeaders(rules)), rules);
});

test("headers live in one place: no hand-kept copy in netlify.toml or public/", () => {
  assert.equal(exists("../public/_headers"), false);
  const root = read("../../netlify.toml");
  const web = read("../netlify.toml");
  for (const toml of [root, web]) {
    assert.doesNotMatch(toml, /\[\[headers\]\]|Content-Security-Policy/);
    assert.doesNotMatch(toml, /SOLANA_RPC_URL\s*=|UNLOCK_SECRET\s*=/);
  }
  // Netlify reads one file or the other depending on the base directory. They must agree.
  const settings = (toml) =>
    toml
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line !== 'base = "web"');
  assert.deepEqual(settings(root), settings(web));
  assert.match(web, /node_bundler = "esbuild"/);
  assert.equal(exists("../vercel.json"), false);
});

test("the page sources contain no inline code, so the policy needs no exception", () => {
  assert.deepEqual(inlineCodeIn(read("../index.html")), []);
  assert.deepEqual(inlineCodeIn(read("../public/404.html")), []);
  // The detector itself: each kind of inline code is caught, data blocks are not.
  assert.equal(inlineCodeIn("<script>go()</script>").length, 1);
  assert.equal(inlineCodeIn('<script type="module">go()</script>').length, 1);
  assert.equal(inlineCodeIn("<style>p{}</style>").length, 1);
  assert.equal(inlineCodeIn('<p style="color:red">x</p>').length, 1);
  assert.equal(inlineCodeIn('<a onclick="go()">x</a>').length, 1);
  assert.equal(inlineCodeIn('<a href="javascript:go()">x</a>').length, 1);
  assert.equal(inlineCodeIn('<script type="application/ld+json">{"a":1}</script>').length, 0);
  assert.equal(inlineCodeIn('<script type="module" src="/a.js"></script><link rel="stylesheet" href="/a.css">').length, 0);
});

test("only the payment functions pull in the heavy Solana libraries", () => {
  for (const name of ["quote", "verify", "consume"]) {
    const source = read(`../netlify/functions/${name}.mjs`);
    assert.doesNotMatch(source, /@solana\/web3\.js|@solana\/spl-token|lib\/tx\.js/, name);
  }
  for (const name of ["assess", "claim", "rpc", "store", "token", "verify", "http", "address", "constants"]) {
    const source = read(`../netlify/functions/lib/${name}.js`);
    assert.doesNotMatch(source, /@solana\/web3\.js|@solana\/spl-token/, name);
  }
});

test("the client sources never see a server secret, a third-party host, or an HTML sink", () => {
  const html = read("../index.html");
  const main = read("../src/main.js");
  const pay = read("../src/pay.js");
  const flow = read("../src/pay-flow.js");
  const worker = read("../src/grind-worker.js");

  for (const src of [html, main, pay, flow, worker]) {
    assert.doesNotMatch(src, /fonts\.googleapis|google-analytics|googletagmanager|stripe\.com|cloudflareinsights|walletconnect/i);
    assert.doesNotMatch(src, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write/);
    assert.doesNotMatch(src, /SOLANA_RPC_URL|UNLOCK_SECRET/);
    assert.doesNotMatch(src, /vg-dev-bypass|import\.meta\.env\.DEV|[?&]dev=1/);
  }
  // The worker makes keys. It has no way to send, store or load anything.
  assert.doesNotMatch(
    worker,
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|indexedDB|localStorage|BroadcastChannel|caches\./
  );
  // The terminal, which shows keys, never calls the network or storage. Only pay.js does.
  assert.doesNotMatch(main, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(flow, /\bfetch\s*\(|document\.|privateKey/);
  assert.doesNotMatch(pay, /privateKey|https?:\/\//);
  const fetches = [...pay.matchAll(/fetch\(([^,)]+)/g)].map((match) => match[1].trim());
  assert.deepEqual(fetches, ["`/api/${name}`", '"/api/quote"']);
  assert.doesNotMatch(pay, /@solana\/web3\.js|@solana\/spl-token|netlify\/functions/);

  assert.match(html, /Keys are generated on your device/);
  assert.match(html, /rel="canonical" href="https:\/\/vanitygrinder\.com\/"/);
  assert.ok(html.includes(siteConfig.siteUrl));
  assert.ok(exists("../public/og.png"));
});

test("tip address is the public receive address, never a secret key", () => {
  assert.equal(siteConfig.tipAddress, DEFAULT_PAY_TO);
  assert.equal(isPublishableTipAddress(siteConfig.tipAddress), true);
  assert.equal(siteConfig.pro.enabled, false);
  assert.ok(siteConfig.tipAddress.length <= 44);
});

test("the terminal is marked never to be machine-translated, so a key shown there is not sent to a translation service", () => {
  const html = read("../index.html");
  const open = html.match(/<div id="terminal-window"[^>]*>/)?.[0];
  assert.ok(open, "terminal window not found");
  // Chrome and Edge honour translate="no"; Google's page translator also looks for the notranslate class.
  assert.match(open, /\stranslate="no"/);
  assert.match(open, /\sclass="notranslate"/);
  // The key is only ever written inside it.
  const start = html.indexOf(open);
  assert.ok(html.indexOf('id="output"') > start);
});
