import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { validatePattern } from "../../shared/grind-math.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const WORDING = "$1 in USDC per grind, paid from your wallet";

/** The JSON-LD block. It is inline because crawlers do not fetch structured data through a src attribute. */
function structuredData(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(html, /<script[^>]*application\/ld\+json[^>]*\ssrc=/);
  return JSON.parse(blocks[0][1]);
}

test("public copy describes a USDC wallet payment and not SOL or QR", () => {
  const html = read("../index.html");
  const schema = structuredData(html);
  const readme = read("../../README.md");
  const deploy = read("../../DEPLOY.md");

  for (const src of [html, readme]) {
    assert.ok(src.includes(WORDING), src.slice(0, 40));
    assert.equal(src.includes("SOL or USDC"), false);
    assert.equal(src.includes("QR ·"), false);
    assert.equal(src.includes("CoinGecko"), false);
  }
  assert.equal(schema["@type"], "WebApplication");
  assert.equal(schema.url, "https://vanitygrinder.com/");
  assert.deepEqual(schema.offers, { "@type": "Offer", price: "1", priceCurrency: "USD", description: WORDING });
  assert.ok(schema.description.includes(WORDING));
  assert.match(html, /property="og:description" content="[^"]*\$1 in USDC per grind, paid from your wallet\./);
  assert.match(html, /name="twitter:description" content="[^"]*\$1 in USDC per grind, paid from your wallet\./);
  assert.match(html, /name="description" content="[^"]*\$1 in USDC per grind, paid from your wallet\./);
  assert.equal(html.includes("pay-qr"), false);
  assert.equal(html.includes("pay-wallet-sol"), false);
  assert.equal(deploy.includes("CoinGecko"), false);
  assert.equal(deploy.includes("within 3%"), false);
  assert.equal(deploy.includes("wallet or QR"), false);
  assert.ok(deploy.includes(WORDING));
});

test("every example pattern the page shows is one the grinder accepts", () => {
  const html = read("../index.html");
  const placeholder = html.match(/id="est-pattern"[^>]*placeholder="e\.g\. ([^"]+)"/)[1];
  const prose = [...html.matchAll(/<span class="mono">…?([1-9A-HJ-NP-Za-km-z0OIl]{3,})…?<\/span>/g)].map((m) => m[1]);
  const examples = [placeholder, ...prose].filter((text) => !text.includes(".") && text !== "vanitygrinder");
  assert.ok(examples.length >= 3, examples.join(","));
  for (const example of examples) {
    assert.deepEqual(validatePattern(example), [], `"${example}" is shown as an example but is not valid Base58`);
  }
});

test("what the page says about the network and the key matches what the code does", () => {
  const html = read("../index.html");
  const readme = read("../../README.md");
  const deploy = read("../../DEPLOY.md");
  for (const src of [html, readme, deploy]) {
    assert.doesNotMatch(src, /60 seconds after a match|after the run finishes, the terminal wipes/);
  }
  // The functions moved to /api/ and the CSP names no host, so the old wording would be false.
  // DEPLOY.md mentions the old URLs only to say that they are gone.
  for (const src of [html, readme]) assert.equal(src.includes("/.netlify/functions/"), false);
  assert.ok(deploy.includes("The default `/.netlify/functions/<name>` URLs do not exist."));
  for (const route of ["/api/quote", "/api/prepare", "/api/verify", "/api/consume"]) {
    assert.ok(deploy.includes(route), route);
  }
  assert.match(html, /stays hidden until you/);
  assert.match(html, /connect-src<\/span> is <span class="mono">'self'<\/span>/);
  assert.match(readme, /hidden until you reveal it/);
  // DEPLOY.md used to call the repository private. It is public, and the page links to it.
  assert.doesNotMatch(deploy, /private repo/i);
});
