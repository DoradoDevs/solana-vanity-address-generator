import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const WORDING = "$1 in USDC per grind, paid from your wallet";

test("public copy describes a USDC wallet payment and not SOL or QR", () => {
  const html = read("../index.html");
  const schema = JSON.parse(read("../public/schema.json"));
  const readme = read("../../README.md");
  const deploy = read("../../DEPLOY.md");

  for (const src of [html, readme]) {
    assert.ok(src.includes(WORDING), src.slice(0, 40));
    assert.equal(src.includes("SOL or USDC"), false);
    assert.equal(src.includes("QR ·"), false);
    assert.equal(src.includes("CoinGecko"), false);
  }
  assert.equal(schema.offers.description, WORDING);
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
