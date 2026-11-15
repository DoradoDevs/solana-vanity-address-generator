import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  offerInAppBrowserLinks,
  phantomBrowseUrl,
  solflareBrowseUrl,
} from "../src/wallet-links.js";

test("wallet browse links encode the page and name Phantom and Solflare", () => {
  const page = "https://vanitygrinder.com/path?x=1";
  const origin = "https://vanitygrinder.com";
  assert.equal(
    phantomBrowseUrl(page),
    `https://phantom.app/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`
  );
  assert.equal(
    solflareBrowseUrl(page),
    `https://solflare.com/ul/v1/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`
  );
  const src = fs.readFileSync(new URL("../src/wallet-links.js", import.meta.url), "utf8");
  assert.match(src, /https:\/\/phantom\.app\/ul\/browse\//);
  assert.match(src, /https:\/\/solflare\.com\/ul\/v1\/browse\//);
  const hosts = src.match(/https?:\/\/[^/`'"\s]+/g) || [];
  assert.deepEqual([...new Set(hosts)].sort(), ["https://phantom.app", "https://solflare.com"]);
});

test("in-app browser help is offered on phones and narrow screens", () => {
  assert.equal(offerInAppBrowserLinks({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }), true);
  assert.equal(offerInAppBrowserLinks({ userAgent: "Mozilla/5.0 (Linux; Android 14)" }), true);
  assert.equal(offerInAppBrowserLinks({ platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(offerInAppBrowserLinks({ narrow: true }), true);
  assert.equal(
    offerInAppBrowserLinks({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", narrow: false }),
    false
  );
});
