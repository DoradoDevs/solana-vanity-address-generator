import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PRODUCTION_CSP } from "../src/headers.js";
import { siteConfig } from "../src/site.config.js";
import { DEFAULT_PAY_TO } from "../netlify/functions/lib/constants.js";
import { isPublishableTipAddress } from "../../shared/pro.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

function cspValues(text) {
  return text
    .split("\n")
    .filter((line) => line.includes("Content-Security-Policy"))
    .map((line) => {
      const quoted = line.match(/Content-Security-Policy(?:["']|)\s*=\s*"([^"]+)"/);
      if (quoted) return quoted[1];
      const raw = line.slice(line.indexOf(":") + 1).trim().replace(/^"/, "").replace(/"$/, "");
      return raw;
    });
}

test("production CSP allows only this site's Netlify functions", () => {
  assert.match(PRODUCTION_CSP, /connect-src https:\/\/vanitygrinder\.com\/\.netlify\/functions\//);
  assert.match(PRODUCTION_CSP, /https:\/\/\*\.netlify\.app\/\.netlify\/functions\//);
  assert.doesNotMatch(PRODUCTION_CSP, /connect-src 'none'/);
  assert.doesNotMatch(PRODUCTION_CSP, /connect-src 'self'/);
  assert.doesNotMatch(PRODUCTION_CSP, /api\.mainnet|quiknode|helius|coingecko|unsafe-inline|unsafe-eval/i);

  for (const value of cspValues(read("../public/_headers"))) {
    assert.equal(value, PRODUCTION_CSP);
  }
  for (const file of ["../../netlify.toml", "../netlify.toml"]) {
    const tomlValues = cspValues(read(file));
    assert.ok(tomlValues.length >= 1, file);
    for (const value of tomlValues) assert.equal(value, PRODUCTION_CSP);
  }
  const quote = read("../netlify/functions/quote.mjs");
  const verifyFn = read("../netlify/functions/verify.mjs");
  const consume = read("../netlify/functions/consume.mjs");
  for (const src of [quote, verifyFn, consume]) {
    assert.doesNotMatch(src, /@solana\/web3\.js|@solana\/spl-token|lib\/tx\.js/);
  }
  assert.equal(fs.existsSync(new URL("../vercel.json", import.meta.url)), false);
});

test("the client never sees the RPC URL or unlock secret", () => {
  const html = read("../index.html");
  const main = read("../src/main.js");
  const pay = read("../src/pay.js");
  const worker = read("../src/grind-worker.js");

  for (const src of [html, main, pay, worker]) {
    assert.doesNotMatch(src, /fonts\.googleapis|google-analytics|googletagmanager|stripe\.com|cloudflareinsights|walletconnect/i);
    assert.doesNotMatch(src, /\binnerHTML\b|\binsertAdjacentHTML\b|document\.write/);
    assert.doesNotMatch(src, /SOLANA_RPC_URL|UNLOCK_SECRET/);
  }
  assert.doesNotMatch(worker, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.doesNotMatch(main, /\bfetch\s*\(/);
  assert.match(pay, /\/\.netlify\/functions\//);
  assert.doesNotMatch(pay, /https?:\/\//);
  assert.doesNotMatch(pay, /@solana\/web3\.js|@solana\/spl-token|from "uqr"|pay-qr|vg-dev-bypass|import\.meta\.env\.DEV/);
  assert.equal(pay.includes("?dev=1"), false);
  assert.equal(pay.includes('get("dev")'), false);
  assert.equal(fs.existsSync(new URL("../netlify/functions/lib/price.js", import.meta.url)), false);
  const quote = read("../netlify/functions/quote.mjs");
  const verifyFn = read("../netlify/functions/verify.mjs");
  assert.doesNotMatch(quote, /coingecko|TOLERANCE_BPS|fetchSolPriceUsd/i);
  assert.doesNotMatch(verifyFn, /coingecko|TOLERANCE_BPS|fetchSolPriceUsd|minLamports/i);
  assert.match(html, /Keys are generated on your device/);
  assert.match(html, /rel="canonical" href="https:\/\/vanitygrinder\.com\/"/);
  assert.ok(html.includes(siteConfig.siteUrl));
  assert.ok(fs.existsSync(new URL("../public/og.png", import.meta.url)));
});

test("tip address is the public receive address, never a secret key", () => {
  assert.equal(siteConfig.tipAddress, DEFAULT_PAY_TO);
  assert.equal(isPublishableTipAddress(siteConfig.tipAddress), true);
  assert.equal(siteConfig.pro.enabled, false);
  assert.ok(siteConfig.tipAddress.length <= 44);
});
