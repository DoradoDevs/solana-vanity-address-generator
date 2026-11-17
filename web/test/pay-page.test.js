// pay.js itself, driven the way a visitor drives it: a stand-in document, a
// stand-in wallet registered through Wallet Standard, and a scripted /api/.
// Each test loads a fresh copy of the module.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { getWallets } from "@wallet-standard/app";
import { encodeBase58 } from "../../shared/base58.js";
import { PAY_ERRORS } from "../../shared/pay-copy.js";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import { buildUnsignedTransaction } from "../netlify/functions/lib/tx.js";
import { CLAIM_KEY, RETIRED_REF_KEY } from "../src/pay-flow.js";
import { PAYER, PAY_TO, STRANGER } from "./helpers/chain.js";

// ── A document just large enough for pay.js ──────────────────────────────────

function element(tag, id = "") {
  const el = {
    tag,
    id,
    className: "",
    textContent: "",
    children: [],
    parent: null,
    listeners: {},
    classList: { names: new Set(), add: (n) => el.classList.names.add(n), remove: (n) => el.classList.names.delete(n) },
    addEventListener: (type, fn) => (el.listeners[type] ||= []).push(fn),
    click: () => (el.listeners.click || []).forEach((fn) => fn()),
    appendChild: (child) => {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    prepend: (child) => {
      child.parent = el;
      el.children.unshift(child);
    },
    insertBefore: (child, before) => {
      child.parent = el;
      const at = el.children.indexOf(before);
      el.children.splice(at < 0 ? el.children.length : at, 0, child);
    },
    replaceChildren: (...kids) => {
      el.children = [];
      kids.forEach(el.appendChild);
    },
    remove: () => {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    scrollIntoView: () => {},
  };
  return el;
}

function fakeDocument() {
  const gate = element("section", "pay-gate");
  const ids = ["pay-wallet", "pay-cancel", "pay-quote", "pay-wallet-list", "pay-status"];
  for (const id of ids) gate.appendChild(element("x", id));
  const tip = element("p", "tip-address");
  tip.textContent = PAY_TO;
  const roots = [gate, tip];
  const find = (el, id) => (el.id === id ? el : el.children.reduce((hit, c) => hit || find(c, id), null));
  return {
    tip,
    getElementById: (id) => roots.reduce((hit, root) => hit || find(root, id), null),
    createElement: (tag) => element(tag),
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const saved = (storage) => JSON.parse(storage.getItem(CLAIM_KEY) || "null");

// ── The server and the wallet ────────────────────────────────────────────────

/** /api/ answers. prepare builds the real transfer for the claim it is sent, to `payTo`. */
function fakeApi({ payTo = PAY_TO, verify = [], consume = [], onConsume = () => {} } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, body });
    let status = 404;
    let data = {};
    if (url === "/api/prepare") {
      status = 200;
      data = {
        transaction: buildUnsignedTransaction({
          payer: body.payer,
          payTo,
          reference: referenceForClaim(body.claim),
          blockhash: encodeBase58(new Uint8Array(randomBytes(32))),
        }),
      };
    } else if (url === "/api/verify") {
      ({ status, data } = verify.shift() ?? { status: 503, data: {} });
    } else if (url === "/api/consume") {
      onConsume();
      ({ status, data } = consume.shift() ?? { status: 503, data: {} });
    } else if (url === "/api/quote") {
      status = 200;
      data = { payTo: STRANGER };
    }
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, requests, of: (name) => requests.filter((r) => r.url === `/api/${name}`) };
}

let unregister = () => {};
let loads = 0;

function fakeWallet(answer) {
  const signed = [];
  const wallet = {
    version: "1.0.0",
    name: `Test Wallet ${++loads}`,
    icon: "data:image/svg+xml;base64,",
    chains: ["solana:mainnet"],
    accounts: [],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({ accounts: [{ address: PAYER, chains: ["solana:mainnet"], features: [] }] }),
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signAndSendTransaction: async (input) => {
          signed.push(input.transaction);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    },
  };
  return { wallet, signed };
}

/** Load a fresh pay.js against a fresh document, storage and API. */
async function load({ storage = fakeStorage(), api = fakeApi(), wallet } = {}) {
  const document = fakeDocument();
  globalThis.document = document;
  // Wallet Standard announces itself on window; a bare event target is all it needs here.
  globalThis.window ??= Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  globalThis.fetch = api.fetch;
  if (wallet) unregister = getWallets().register(wallet);
  const pay = await import(`../src/pay.js?load=${++loads}`);
  pay.initPay();
  const status = () => document.getElementById("pay-status").textContent;
  return { pay, document, storage, api, status };
}

async function until(predicate, what) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Connect wallet, then the wallet's own button, as a visitor does. */
async function choose(page, wallet) {
  page.document.getElementById("pay-wallet").click();
  const button = page.document.getElementById("pay-wallet-list").children.find((b) => b.textContent === wallet.name);
  assert.ok(button, "wallet listed");
  button.click();
}

afterEach(() => {
  unregister();
  unregister = () => {};
  delete globalThis.document;
});

const PAID = { status: 200, data: { ok: true, token: "token-1", expiresAt: Date.now() + 600_000 } };
const CONSUMED = { status: 200, data: { ok: true } };

test("a transfer the page's check refuses is never shown to the wallet, and the visitor is told to reload", async () => {
  const { wallet, signed } = fakeWallet([{ signature: new Uint8Array(64) }]);
  const page = await load({ api: fakeApi({ payTo: STRANGER }), wallet });
  await choose(page, wallet);
  await until(() => page.status().includes("did not send it to your wallet"), "the refusal");
  assert.equal(signed.length, 0);
  assert.match(page.status(), /reload the page/);
  assert.equal(page.storage.getItem(CLAIM_KEY), null);
  assert.equal(page.api.of("prepare").length, 1);
});

test("the honest transfer reaches the wallet unchanged, and its claim is followed to the unlock", async () => {
  const signature = new Uint8Array(64).fill(4);
  const { wallet, signed } = fakeWallet([{ signature }]);
  const api = fakeApi({ verify: [PAID] });
  const page = await load({ api, wallet });
  await choose(page, wallet);
  await until(() => page.status() === "Paid. Starting this grind.", "the unlock");
  const claim = api.of("prepare")[0].body.claim;
  assert.equal(signed.length, 1);
  assert.deepEqual(api.of("verify")[0].body, { claim, signature: encodeBase58(signature) });
});

test("a wallet error nobody recognises keeps the claim and looks for the payment; a refusal clears it", async () => {
  const unknown = fakeWallet(new Error("Unexpected error"));
  const api = fakeApi({ verify: [PAID] });
  const page = await load({ api, wallet: unknown.wallet });
  await choose(page, unknown.wallet);
  await until(() => api.of("verify").length === 1, "the payment check");
  const claim = api.of("prepare")[0].body.claim;
  assert.equal(api.of("verify")[0].body.claim, claim);
  const record = saved(page.storage);
  assert.equal(record.claim, claim);
  assert.equal(record.walletError, true);
  assert.equal(typeof record.sentAt, "number");

  unregister();
  for (const [error, kind] of [
    [new Error("User rejected the request."), "rejected"],
    [new Error("Transaction simulation failed: Blockhash not found"), "not_sent"],
  ]) {
    const declined = fakeWallet(error);
    const other = await load({ wallet: declined.wallet });
    await choose(other, declined.wallet);
    await until(() => other.status() === PAY_ERRORS[kind], kind);
    assert.equal(other.storage.getItem(CLAIM_KEY), null, kind);
    unregister();
  }
});

test("while nothing is seen, the status counts down to when paying again is allowed, and says why it waits", async () => {
  const NOT_FOUND = { status: 202, data: { ok: false, reason: "not_found" } };

  // The wallet threw something nobody recognises: it may or may not have sent.
  const unknown = fakeWallet(new Error("Unexpected error"));
  const api = fakeApi({ verify: [NOT_FOUND] });
  const page = await load({ api, wallet: unknown.wallet });
  await choose(page, unknown.wallet);
  await until(() => /Up to \d:\d\d left/.test(page.status()), "the countdown after a wallet error");
  assert.match(page.status(), /^Your wallet reported an error, so this page is making sure no payment went out/);
  assert.match(page.status(), /Up to (3:00|2:5\d) left\.$/);
  page.document.getElementById("pay-cancel").click();
  unregister();

  // The page was closed while the wallet was asking: no signature, no error, one minute gone.
  const claim = encodeBase58(new Uint8Array(randomBytes(32)));
  const storage = fakeStorage({ [CLAIM_KEY]: JSON.stringify({ claim, createdAt: Date.now() - 60_000, sentAt: null }) });
  const resumed = await load({ storage, api: fakeApi({ verify: [NOT_FOUND] }) });
  await until(() => /at most\.$/.test(resumed.status()), "the countdown on a resumed attempt");
  assert.match(resumed.status(), /^Looking for a payment from this attempt\. If none has landed, you can pay again in (2:00|1:5\d) at most\.$/);
  resumed.document.getElementById("pay-cancel").click();
  assert.equal(saved(storage).claim, claim, "stopping the wait keeps the attempt");
});

test("the token is saved before consume, the tab asks before closing mid-spend, and a reload replays it", async () => {
  const storage = fakeStorage();
  let duringSpend = null;
  let pageRef;
  const api = fakeApi({
    verify: [PAID],
    consume: [{ status: 502, data: {} }, { status: 502, data: {} }, { status: 502, data: {} }, { status: 502, data: {} }],
    onConsume: () => (duringSpend ??= { record: saved(storage), spending: pageRef.pay.spendInProgress() }),
  });
  const { wallet } = fakeWallet([{ signature: new Uint8Array(64).fill(5) }]);
  const page = await load({ storage, api, wallet });
  pageRef = page;
  await choose(page, wallet);
  await until(() => page.status() === "Paid. Starting this grind.", "the unlock");
  assert.equal(page.pay.spendInProgress(), false);

  // Every answer to the spend is lost.
  const spent = await page.pay.consumePaidGrind();
  assert.equal(spent.ok, false);
  assert.equal(duringSpend.record.token, "token-1");
  assert.equal(duringSpend.spending, true);
  assert.equal(page.pay.spendInProgress(), false);
  unregister();

  // A reload: the saved token is spent again, without asking verify.
  const again = fakeApi({ consume: [CONSUMED] });
  const reloaded = await load({ storage, api: again });
  assert.deepEqual(await reloaded.pay.ensurePaid(), { ok: true });
  assert.deepEqual(await reloaded.pay.consumePaidGrind(), { ok: true });
  assert.equal(again.of("verify").length, 0);
  assert.deepEqual(again.of("consume").map((r) => r.body.token), ["token-1"]);
  assert.equal(storage.getItem(CLAIM_KEY), null);
});

test("an expired token is replaced through verify before the grind is refused", async () => {
  const storage = fakeStorage({
    [CLAIM_KEY]: JSON.stringify({ claim: encodeBase58(new Uint8Array(32).fill(1)), createdAt: 1, sentAt: 2 }),
  });
  const api = fakeApi({
    verify: [PAID, { status: 200, data: { ok: true, token: "token-2", expiresAt: 9 } }],
    consume: [{ status: 401, data: { reason: "expired" } }, CONSUMED],
  });
  const page = await load({ storage, api });
  assert.deepEqual(await page.pay.ensurePaid(), { ok: true });
  assert.deepEqual(await page.pay.consumePaidGrind(), { ok: true });
  assert.deepEqual(api.of("consume").map((r) => r.body.token), ["token-1", "token-2"]);
});

test("the tip address is the bundle's own: nothing the server returns replaces it", async () => {
  const page = await load({ api: fakeApi() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.document.tip.textContent, PAY_TO);
  assert.equal(page.api.of("quote").length, 0);
});

test("a reference saved by the page before claims is shown with how to get a refund, until hidden", async () => {
  const old = "11111111111111111111111111111112";
  const storage = fakeStorage({ [RETIRED_REF_KEY]: old });
  const page = await load({ storage });
  const notice = page.document.getElementById("pay-notice-retired");
  assert.ok(notice);
  assert.match(notice.children[0].textContent, new RegExp(old));
  assert.match(notice.children[0].textContent, /refunded/);
  notice.children[1].click();
  assert.equal(page.document.getElementById("pay-notice-retired"), null);
  assert.equal(storage.getItem(RETIRED_REF_KEY), null);
});
