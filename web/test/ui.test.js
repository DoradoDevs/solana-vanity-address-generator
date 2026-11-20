// The page's design: the vendored design system is the released one, every
// font it names ships with its licence, and the figures and match marks the
// generator draws are right.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { foundByNowProbability, formatOdds, formatProbability } from "../../shared/grind-math.js";
import { matchRange, previewParts, splitAtMatch } from "../src/match-view.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
// Hashed with LF line endings, so a Windows checkout with autocrlf hashes the same.
const sha256 = (rel) => createHash("sha256").update(read(rel).replace(/\r\n/g, "\n")).digest("hex");

test("system.css and system.js are Quiet Technical 2.3.0, byte for byte", () => {
  assert.equal(sha256("../public/system.css"), "a22bd4c8f15ccdac3c4bfe1f7383eb468242087aad4281f0d321b341c28aa410");
  assert.equal(sha256("../public/system.js"), "5cdc7344fafa8d4541e58960e303db9f430db44132552311343ec15571a52684");
});

test("every font system.css names is served from this site, with its licence", () => {
  const urls = [...read("../public/system.css").matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.match(url, /^\.\/fonts\/[a-z0-9-]+\.woff2$/, url);
    assert.ok(fs.existsSync(new URL(`../public/${url.slice(2)}`, import.meta.url)), url);
  }
  assert.match(read("../public/fonts/OFL.txt"), /SIL OPEN FONT LICENSE/i);
});

test("both pages load the design system and nothing from another host", () => {
  for (const page of ["../index.html", "../public/404.html"]) {
    const html = read(page);
    assert.match(html, /<html[^>]*\sdata-product="vanity"[^>]*\sdata-theme="dark"/, page);
    assert.match(html, /<link rel="stylesheet" href="\/system\.css" \/>/, page);
    assert.match(html, /<script src="\/system\.js" defer><\/script>/, page);
    assert.doesNotMatch(html, /(?:href|src)="(?:https?:)?\/\/(?!vanitygrinder\.com|github\.com)/, page);
  }
});

test("the console is a log that never speaks; one status line does", () => {
  const html = read("../index.html");
  const output = html.match(/<div [^>]*\sid="output"[^>]*>/)?.[0];
  assert.ok(output);
  assert.match(output, /\srole="log"/);
  assert.match(output, /\saria-live="off"/);
  assert.match(html, /<div id="live-status" class="sr-only" aria-live="polite"><\/div>/);
  // Inside the generator nothing else is live: odds change on every keystroke.
  const start = html.indexOf('id="generator"');
  const end = html.indexOf('id="privacy"', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(html.slice(start, end), /aria-live="(?:polite|assertive)"/);
});

test("found-by-now probability is 1 - (1 - 1/E)^n and never reads as a time", () => {
  assert.equal(foundByNowProbability(0, 1000), 0);
  assert.equal(foundByNowProbability(10, Infinity), 0);
  assert.equal(foundByNowProbability(5, 1), 1);
  const p = foundByNowProbability(1000, 1000);
  assert.ok(Math.abs(p - (1 - (1 - 1 / 1000) ** 1000)) < 1e-12);
  assert.ok(Math.abs(p - 0.6323) < 1e-3);
  // Precise far below one in a million, where 1 - (1 - x)^n would round to 0.
  const tiny = foundByNowProbability(1, 128.1e12);
  assert.ok(tiny > 0 && Math.abs(tiny - 1 / 128.1e12) < 1e-24);
});

test("probability figures round down and keep their bounds", () => {
  assert.equal(formatProbability(0), "0%");
  assert.equal(formatProbability(NaN), "0%");
  assert.equal(formatProbability(1e-9), "<0.1%");
  assert.equal(formatProbability(0.0289), "2.8%");
  assert.equal(formatProbability(0.0999), "9.9%");
  assert.equal(formatProbability(0.1), "10%");
  assert.equal(formatProbability(0.5499), "54%");
  assert.equal(formatProbability(0.9989), "99%");
  assert.equal(formatProbability(0.9995), ">99.9%");
  assert.equal(formatProbability(1), ">99.9%");
  for (const p of [0.001, 0.05, 0.3, 0.9]) assert.doesNotMatch(formatProbability(p), /[smhdy]$/);
});

test("odds read as 1 in N", () => {
  assert.equal(formatOdds(841), "About 1 in 841");
  assert.equal(formatOdds(707_281.4), "About 1 in 707,281");
  assert.match(formatOdds(128.1e12), /^About 1 in \S+T$/);
  assert.equal(formatOdds(Infinity), "not possible");
});

test("the match mark sits where the grind matched", () => {
  const addr = "pumpXa9bc1234567890ABCDEFGHJKLMNPQRSTUVWXpump";
  assert.deepEqual(matchRange(addr, "pump", "prefix", true), [0, 4]);
  assert.deepEqual(matchRange(addr, "pump", "suffix", true), [addr.length - 4, addr.length]);
  // Either end prefers the start, as the matcher does.
  assert.deepEqual(matchRange(addr, "pump", "prefix-or-suffix", true), [0, 4]);
  assert.deepEqual(matchRange(addr, "xa9", "anywhere", false), [4, 7]);
  assert.equal(matchRange(addr, "xa9", "anywhere", true), null);
  assert.deepEqual(matchRange(addr, "PUMP", "suffix", false), [addr.length - 4, addr.length]);
  assert.equal(matchRange(addr, "PUMP", "suffix", true), null);
  assert.equal(matchRange(addr, "", "suffix", true), null);
  assert.equal(matchRange(addr, "pump", "middle", true), null);

  assert.deepEqual(splitAtMatch("abcdef", [2, 4]), ["ab", "cd", "ef"]);
  assert.deepEqual(splitAtMatch("abcdef", null), ["abcdef", "", ""]);
});

test("the preview puts the pattern where it would land, 44 characters wide", () => {
  for (const position of ["prefix", "suffix", "prefix-or-suffix", "anywhere"]) {
    const parts = previewParts("pump", position);
    assert.equal(parts.join("").length, 44, position);
    assert.equal(parts[1], "pump");
  }
  assert.equal(previewParts("pump", "prefix")[0], "");
  assert.equal(previewParts("pump", "suffix")[2], "");
  assert.equal(previewParts("pump", "prefix-or-suffix")[2], "");
  assert.equal(previewParts("ab", "anywhere", 10).join(""), "····ab····");
  assert.equal(previewParts("x".repeat(50), "suffix").join("").length, 50);
});
