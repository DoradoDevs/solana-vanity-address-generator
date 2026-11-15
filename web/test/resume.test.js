import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { consumeMessage } from "../netlify/functions/consume.mjs";
import { referenceFromSearch, shouldRetryConsume } from "../src/pay.js";

const PAYER = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";

test("consume tells a missing record apart from a bad signature", () => {
  assert.equal(
    consumeMessage({ ok: false, reason: "invalid" }),
    "Payment still settling, retrying…"
  );
  assert.equal(
    consumeMessage({ ok: false, reason: "bad" }),
    "The unlock token is not valid."
  );
  assert.match(consumeMessage({ ok: false, reason: "expired" }), /expired/i);
  assert.match(consumeMessage({ ok: false, reason: "reused" }), /already used/i);
  assert.equal(consumeMessage({ ok: true }), "Unlocked.");
});

test("resume keeps a real ?ref= and ignores anything else", () => {
  assert.equal(referenceFromSearch(`?ref=${PAYER}`), PAYER);
  assert.equal(referenceFromSearch(`ref=${PAYER}&x=1`.replace(/^/, "?")), PAYER);
  assert.equal(referenceFromSearch("?ref=not-a-solana-address"), null);
  assert.equal(referenceFromSearch("?ref="), null);
  assert.equal(referenceFromSearch(""), null);
});

test("only an expired or missing unlock is retried", () => {
  assert.equal(shouldRetryConsume("expired"), true);
  assert.equal(shouldRetryConsume("invalid"), true);
  assert.equal(shouldRetryConsume("bad"), false);
  assert.equal(shouldRetryConsume("reused"), false);
  assert.equal(shouldRetryConsume("unlocked"), false);
});

test("payment records use a strongly consistent blob store", () => {
  const src = fs.readFileSync(new URL("../netlify/functions/lib/store.js", import.meta.url), "utf8");
  assert.match(src, /getStore\(\{\s*name:\s*"grind-payments",\s*consistency:\s*"strong"\s*\}\)/);
  assert.match(src, /consistency:\s*"strong"/);
});
