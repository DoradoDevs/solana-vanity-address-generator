import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PRODUCTION_CSP } from "../src/headers.js";
import { siteConfig } from "../src/site.config.js";
import { isPublishableTipAddress } from "../../shared/pro.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("production CSP blocks every connection and is what hosts ship", () => {
  assert.match(PRODUCTION_CSP, /connect-src 'none'/);
  assert.doesNotMatch(PRODUCTION_CSP, /connect-src 'self'/);
  assert.doesNotMatch(PRODUCTION_CSP, /unsafe-inline/);
  assert.doesNotMatch(PRODUCTION_CSP, /unsafe-eval/);

  const headerLines = read("../public/_headers")
    .split("\n")
    .filter((line) => line.includes("Content-Security-Policy:"));
  assert.ok(headerLines.length >= 1);
  for (const line of headerLines) {
    const value = line.slice(line.indexOf(":") + 1).trim();
    assert.equal(value, PRODUCTION_CSP);
  }

  const vercel = JSON.parse(read("../vercel.json"));
  for (const group of vercel.headers) {
    const csp = group.headers.find((header) => header.key === "Content-Security-Policy");
    assert.equal(csp.value, PRODUCTION_CSP);
    const payment = group.headers.find((header) => header.key === "Permissions-Policy");
    assert.match(payment.value, /payment=\(\)/);
  }
});

test("page source does not call the network or inject HTML", () => {
  const html = read("../index.html");
  const main = read("../src/main.js");
  const worker = read("../src/grind-worker.js");
  const config = read("../src/site.config.js");

  for (const src of [html, main, worker]) {
    assert.doesNotMatch(src, /fonts\.googleapis|google-analytics|googletagmanager|stripe\.com|cloudflareinsights|walletconnect/i);
    assert.doesNotMatch(src, /\binnerHTML\b|\binsertAdjacentHTML\b|document\.write/);
  }
  assert.doesNotMatch(worker, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.doesNotMatch(main, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.match(html, /rel="canonical" href="https:\/\/vanitygrinder\.com\/"/);
  assert.ok(html.includes(siteConfig.siteUrl));
  assert.ok(html.includes(siteConfig.repositoryUrl));
  assert.ok(html.includes("og:image"));
  assert.ok(fs.existsSync(new URL("../public/og.png", import.meta.url)));
  const serialized = JSON.stringify(siteConfig);
  assert.doesNotMatch(serialized, /sk_live|BEGIN PRIVATE|secretKey|apiKey|seed phrase/i);
  assert.equal(config.includes("tipAddress"), true);
});

test("tip address is empty or a public address, never a secret key", () => {
  assert.equal(siteConfig.siteUrl, "https://vanitygrinder.com");
  assert.equal(typeof siteConfig.pro.enabled, "boolean");
  assert.equal(siteConfig.pro.enabled, false);
  assert.ok(siteConfig.pro.freeMaxPatternLength >= 1);
  assert.ok(siteConfig.pro.maxBatch >= 1);
  const tip = siteConfig.tipAddress;
  assert.equal(tip === "" || isPublishableTipAddress(tip), true);
  assert.ok(tip.length <= 44);
});
