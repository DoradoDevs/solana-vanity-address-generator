// The page's side of a payment, driven with a fake clock and a scripted server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";
import { PAY_ERRORS } from "../../shared/pay-copy.js";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import { memoryStore } from "../netlify/functions/lib/store.js";
import { signUnlockToken } from "../netlify/functions/lib/token.js";
import { buildUnsignedTransaction } from "../netlify/functions/lib/tx.js";
import { consumeUnlock } from "../netlify/functions/lib/verify.js";
import { PAYER, PAY_TO, STRANGER, newSignature } from "./helpers/chain.js";
import {
  ABANDON_OFFER_AFTER_MS,
  CLAIM_KEY,
  GIVE_UP_AFTER_MS,
  LEASE_MS,
  MAX_BACKOFF_MS,
  POLL_MS,
  REFUND_NOTES_KEY,
  RETIRED_REF_KEY,
  SPEND_LOCK,
  createPayFlow,
} from "../src/pay-flow.js";
import { referenceOf } from "../src/transfer-check.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * Web Locks, as two tabs of one browser share them: one holder per name, the rest wait in turn.
 * Every flow over the same storage gets the same locks.
 */
const browserLocks = new WeakMap();
function locksFor(storage) {
  if (!browserLocks.has(storage)) {
    const tails = new Map();
    browserLocks.set(storage, {
      held: [],
      request(name, fn) {
        const run = (tails.get(name) ?? Promise.resolve()).then(async () => {
          this.held.push(name);
          try {
            return await fn();
          } finally {
            this.held.pop();
          }
        });
        tails.set(name, run.catch(() => {}));
        return run;
      },
    });
  }
  return browserLocks.get(storage);
}

/** A fake sleep never blocks timers, and a flow that never settles fails here instead of hanging the suite. */
const MAX_SLEEPS = 5_000;
const yieldToTimers = () => new Promise((resolve) => setImmediate(resolve));

const answers = {
  unseen: { status: 202, data: { ok: false, reason: "not_found" } },
  pending: { status: 202, data: { ok: false, reason: "pending" } },
  paid: { status: 200, data: { ok: true, token: "token-1", expiresAt: 1_600_000 } },
  used: { status: 409, data: { ok: false, reason: "reused", message: "That payment was already used for a grind." } },
  failed: { status: 400, data: { ok: false, reason: "failed" } },
  wrongAmount: { status: 400, data: { ok: false, reason: "wrong_amount" } },
  down: { status: 503, data: { ok: false, reason: "unavailable" } },
  limited: { status: 429, data: {} },
  proxy404: { status: 404, data: {} },
  proxy502: { status: 502, data: {} },
  offline: new Error("network"),
};

/** A flow whose server replies with `script`, one entry per request, repeating the last. */
function setup(script, { storage = fakeStorage(), start = 1_000_000, locks = locksFor(storage) } = {}) {
  const clock = { now: start };
  const calls = [];
  const replies = [];
  const sleeps = [];
  const post = async (name, body) => {
    calls.push({ name, body });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    const answer = typeof step === "function" ? step(clock, body) : step;
    replies.push(answer);
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  };
  const sleep = async (ms) => {
    sleeps.push(ms);
    if (sleeps.length > MAX_SLEEPS) throw new Error(`the flow never settled: ${MAX_SLEEPS} sleeps`);
    clock.now += ms;
    await yieldToTimers();
  };
  let seed = 1;
  const random = (n) => Uint8Array.from({ length: n }, () => seed++ % 256);
  const flow = createPayFlow({ storage, post, now: () => clock.now, sleep, random, locks });
  return { flow, storage, clock, calls, replies, sleeps };
}

test("a claim is 32 random bytes in Base58, saved before anything is sent", () => {
  const { flow, storage } = setup([answers.unseen]);
  assert.equal(flow.pending(), null);
  const claim = flow.begin();
  assert.equal(decodeBase58(claim).length, 32);
  assert.deepEqual(JSON.parse(storage.map.get(CLAIM_KEY)), { claim, createdAt: 1_000_000, sentAt: null });
  assert.deepEqual(flow.pending(), {
    claim,
    createdAt: 1_000_000,
    sentAt: null,
    signature: null,
    walletError: false,
    token: null,
    tokenExpiresAt: null,
    cursor: null,
  });
});

test("a second payment cannot be started while one is unresolved", () => {
  const { flow } = setup([answers.unseen]);
  const claim = flow.begin();
  assert.throws(() => flow.begin(), /already pending/);
  assert.equal(flow.pending().claim, claim);
  // Clearing names the attempt: without one, or with another, nothing is cleared.
  flow.forget();
  flow.forget("another-claim");
  assert.equal(flow.pending().claim, claim);
  flow.forget(claim);
  assert.notEqual(flow.begin(), claim);
});

test("a payment that is not visible yet is waited for, through finality, to the unlock", async () => {
  // What a real chain does: nothing for a moment, then seen, then final.
  const { flow, calls, sleeps } = setup([answers.unseen, answers.unseen, answers.pending, answers.pending, answers.paid]);
  const claim = flow.begin();
  flow.markSent();
  const states = [];
  const result = await flow.watch({ onState: (state) => states.push(state) });
  assert.deepEqual(result, { outcome: "paid", claim, token: "token-1", expiresAt: 1_600_000 });
  assert.deepEqual(states, ["unseen", "unseen", "pending", "pending"]);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.name === "verify" && call.body.claim === claim));
  assert.deepEqual(Object.keys(calls[0].body), ["claim"]);
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS, POLL_MS, POLL_MS]);
  // Still saved: the grind has not been unlocked yet.
  assert.equal(flow.pending().claim, claim);
});

test("the signature the wallet returned is saved with the claim and sent with every check", async () => {
  const { flow, storage, calls, clock } = setup([answers.unseen, answers.pending, answers.paid]);
  const claim = flow.begin();
  const raw = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
  // What Wallet Standard's solana:signAndSendTransaction resolves with: one output per input.
  flow.markSent([{ signature: raw }]);
  const signature = encodeBase58(raw);
  assert.equal(JSON.parse(storage.map.get(CLAIM_KEY)).signature, signature);
  assert.deepEqual(flow.pending(), {
    claim,
    createdAt: 1_000_000,
    sentAt: clock.now,
    signature,
    walletError: false,
    token: null,
    tokenExpiresAt: null,
    cursor: null,
  });
  assert.equal((await flow.watch()).outcome, "paid");
  assert.deepEqual(
    calls.map((call) => call.body),
    [{ claim, signature }, { claim, signature }, { claim, signature }]
  );
});

test("a send reported for an attempt that another tab has since replaced leaves the new attempt alone", () => {
  const { flow, storage } = setup([answers.unseen]);
  const old = flow.begin();
  flow.forget(old); // another tab gave the old attempt up and started its own
  const current = flow.begin();
  const before = storage.map.get(CLAIM_KEY);
  flow.markSent([{ signature: new Uint8Array(64).fill(7) }], old);
  assert.equal(storage.map.get(CLAIM_KEY), before);
  flow.markSent([{ signature: new Uint8Array(64).fill(7) }], current);
  assert.equal(flow.pending().signature, encodeBase58(new Uint8Array(64).fill(7)));
});

test("a wallet answer without a usable signature leaves the claim to be found by its reference", async () => {
  for (const output of [undefined, null, [], [{}], [{ signature: new Uint8Array(32) }], [{ signature: "5".repeat(88) }], { signature: new Uint8Array(64) }]) {
    const { flow, storage, calls } = setup([answers.paid]);
    const claim = flow.begin();
    flow.markSent(output);
    assert.equal(JSON.parse(storage.map.get(CLAIM_KEY)).signature, undefined, JSON.stringify(output));
    await flow.check();
    assert.deepEqual(calls[0].body, { claim });
  }
  // A damaged saved signature is dropped rather than sent.
  const storage = fakeStorage({ [CLAIM_KEY]: JSON.stringify({ claim: "x".repeat(44), createdAt: 1, sentAt: 2, signature: "not base58 0OIl" }) });
  const { flow } = setup([answers.paid], { storage });
  assert.equal(flow.pending().signature, null);
});

test("a payment still unseen three minutes after it was sent never landed, and only then is it dropped", async () => {
  const { flow, clock, sleeps } = setup([answers.unseen]);
  flow.begin();
  clock.now += 60_000; // a minute spent in the wallet
  flow.markSent();
  const sentAt = clock.now;
  const result = await flow.watch();
  assert.deepEqual(result, { outcome: "gone" });
  assert.equal(flow.pending(), null);
  assert.ok(clock.now - sentAt > GIVE_UP_AFTER_MS);
  assert.ok(clock.now - sentAt <= GIVE_UP_AFTER_MS + POLL_MS);
  assert.ok(sleeps.length >= 60);
});

test("a payment seen on chain is never given up on, however long finality takes", async () => {
  let polls = 0;
  const slow = () => (++polls > 400 ? answers.paid : answers.pending);
  const { flow, clock } = setup([slow]);
  flow.begin();
  flow.markSent();
  const result = await flow.watch();
  assert.equal(result.outcome, "paid");
  assert.ok(clock.now - 1_000_000 > GIVE_UP_AFTER_MS * 5);
});

test("an unreachable or rate-limited check decides nothing: it backs off and keeps the claim", async () => {
  const script = [answers.down, answers.limited, answers.proxy502, answers.offline, answers.proxy404, answers.down, answers.paid];
  const { flow, sleeps } = setup(script);
  const claim = flow.begin();
  flow.markSent();
  const states = [];
  const result = await flow.watch({ onState: (state) => states.push(state) });
  assert.equal(result.outcome, "paid");
  assert.deepEqual(states, Array(6).fill("unavailable"));
  assert.deepEqual(sleeps, [6_000, 12_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  assert.equal(flow.pending().claim, claim);
});

test("an outage longer than the give-up window does not drop a payment that is there", async () => {
  let polls = 0;
  const outageThenPaid = () => (++polls <= 30 ? answers.down : answers.paid);
  const { flow, clock } = setup([outageThenPaid]);
  flow.begin();
  flow.markSent();
  const result = await flow.watch();
  assert.equal(result.outcome, "paid");
  assert.ok(clock.now - 1_000_000 > GIVE_UP_AFTER_MS);
});

test("a spent, failed or mismatched payment ends the attempt and clears it", async () => {
  for (const [answer, expected] of [
    [answers.used, { outcome: "used", reason: "reused", message: "That payment was already used for a grind." }],
    [
      { status: 409, data: { ok: false, reason: "refunded", message: "Refunded." } },
      { outcome: "used", reason: "refunded", message: "Refunded." },
    ],
    [answers.failed, { outcome: "rejected", reason: "failed", message: "" }],
    [answers.wrongAmount, { outcome: "rejected", reason: "wrong_amount", message: "" }],
  ]) {
    const { flow } = setup([answer]);
    flow.begin();
    flow.markSent();
    assert.deepEqual(await flow.watch(), expected);
    assert.equal(flow.pending(), null);
  }
});

test("stopping the wait keeps the claim, so the payment is found next time", async () => {
  const controller = new AbortController();
  let polls = 0;
  const script = [
    () => {
      if (++polls === 3) controller.abort();
      return answers.pending;
    },
  ];
  const { flow, calls } = setup(script);
  const claim = flow.begin();
  flow.markSent();
  const result = await flow.watch({ signal: controller.signal });
  assert.deepEqual(result, { outcome: "stopped" });
  assert.equal(calls.length, 3);
  assert.equal(flow.pending().claim, claim);

  const already = new AbortController();
  already.abort();
  assert.deepEqual(await flow.watch({ signal: already.signal }), { outcome: "stopped" });
  assert.equal(calls.length, 3);
});

test("a saved claim survives a reload, and a claim that was never sent ages from when it was made", async () => {
  const first = setup([answers.unseen]);
  const claim = first.flow.begin();
  // The tab died while the wallet was open. A new page load finds the claim.
  const reloaded = setup([answers.unseen, answers.pending, answers.paid], {
    storage: first.storage,
    start: 1_000_000 + 30_000,
  });
  assert.equal(reloaded.flow.pending().claim, claim);
  assert.deepEqual(await reloaded.flow.watch(), { outcome: "paid", claim, token: "token-1", expiresAt: 1_600_000 });

  const abandoned = setup([answers.unseen]);
  abandoned.flow.begin();
  const later = setup([answers.unseen], { storage: abandoned.storage, start: 1_000_000 + GIVE_UP_AFTER_MS + 1 });
  assert.deepEqual(await later.flow.watch(), { outcome: "gone" });
  assert.equal(later.calls.length, 1);
});

test("with nothing saved there is nothing to check and no request is made", async () => {
  const { flow, calls } = setup([answers.paid]);
  assert.deepEqual(await flow.check(), { state: "none" });
  assert.deepEqual(await flow.watch(), { outcome: "none" });
  assert.equal(calls.length, 0);
});

test("a reference saved by the page before claims is kept for the customer until they dismiss it", () => {
  const old = "11111111111111111111111111111112";
  const storage = fakeStorage({ [RETIRED_REF_KEY]: old });
  const { flow } = setup([answers.unseen], { storage });
  // It cannot be redeemed any more, but it is the customer's only record of a payment they may be owed.
  assert.equal(RETIRED_REF_KEY, "vg-pay-ref");
  assert.equal(flow.retiredReference(), old);
  assert.equal(storage.map.get(RETIRED_REF_KEY), old);
  assert.equal(flow.pending(), null);
  flow.begin(); // starting a new payment does not touch it
  assert.equal(flow.retiredReference(), old);
  flow.dismissRetired();
  assert.equal(flow.retiredReference(), null);
  assert.equal(storage.map.has(RETIRED_REF_KEY), false);
});

test("damaged storage reads as nothing saved", () => {
  const storage = fakeStorage({ [CLAIM_KEY]: "{not json" });
  const { flow } = setup([answers.unseen], { storage });
  assert.equal(flow.pending(), null);
  for (const junk of ["null", "[]", '"claim"', '{"claim":5,"createdAt":1}', '{"claim":"abc"}']) {
    storage.map.set(CLAIM_KEY, junk);
    assert.equal(flow.pending(), null, junk);
  }
});

test("spending retries a lost response with the same token, then clears the claim", async () => {
  const ok = { status: 200, data: { ok: true } };
  const { flow, calls } = setup([answers.offline, answers.proxy502, ok]);
  const claim = flow.begin();
  assert.deepEqual(await flow.spend("token-1", claim), { ok: true });
  assert.deepEqual(
    calls.map((call) => [call.name, call.body.token]),
    [["consume", "token-1"], ["consume", "token-1"], ["consume", "token-1"]]
  );
  assert.equal(flow.pending(), null);
});

test("spending reports a used payment, an expired token, and an unreachable service apart", async () => {
  const used = setup([{ status: 409, data: { ok: false, reason: "reused", message: "Already used." } }]);
  const usedClaim = used.flow.begin();
  assert.deepEqual(await used.flow.spend("t", usedClaim), { ok: false, reason: "reused", message: "Already used." });
  assert.equal(used.flow.pending(), null);
  // A verdict clears the claim it was for, never one another tab has saved since.
  const other = setup([{ status: 409, data: { ok: false, reason: "reused" } }]);
  const newer = other.flow.begin();
  assert.equal((await other.flow.spend("t", "an-older-claim")).reason, "reused");
  assert.equal(other.flow.pending().claim, newer);

  for (const [status, reason] of [[401, "expired"], [400, "bad"]]) {
    const stale = setup([{ status, data: { ok: false, reason } }]);
    const claim = stale.flow.begin();
    assert.deepEqual(await stale.flow.spend("t"), { ok: false, reason, message: undefined });
    assert.equal(stale.calls.length, 1);
    // The payment is still there. Only the token was stale.
    assert.equal(stale.flow.pending().claim, claim);
  }

  const down = setup([answers.down]);
  const claim = down.flow.begin();
  assert.deepEqual(await down.flow.spend("t"), { ok: false, reason: "unavailable" });
  assert.equal(down.calls.length, 4);
  assert.equal(down.flow.pending().claim, claim);
});

test("a 200 without ok, or with the wrong shape, unlocks nothing", async () => {
  const { flow } = setup([{ status: 200, data: {} }]);
  flow.begin();
  assert.equal((await flow.spend("t")).ok, false);
  assert.deepEqual(await flow.check(), { state: "unavailable" });
  const odd = setup([{ status: 200, data: { ok: true, token: 5 } }]);
  odd.flow.begin();
  assert.deepEqual(await odd.flow.check(), { state: "unavailable" });
});

// ── Replies that carry no reason decide nothing ──────────────────────────────

test("a 400 or 409 without its reason, from a proxy or the edge, keeps the claim in check, watch and spend", async () => {
  const bare400 = { status: 400, data: {} };
  const bare409 = { status: 409, data: {} };
  const wrongReason = { status: 409, data: { reason: "something else" } };
  for (const answer of [bare400, bare409, wrongReason, { status: 400, data: { reason: 7 } }]) {
    const { flow } = setup([answer]);
    flow.begin();
    assert.deepEqual(await flow.check(), { state: "unavailable" }, JSON.stringify(answer));
  }
  const { flow, sleeps } = setup([bare400, bare409, wrongReason, answers.paid]);
  const claim = flow.begin();
  flow.markSent();
  assert.equal((await flow.watch()).outcome, "paid");
  assert.deepEqual(sleeps, [6_000, 12_000, MAX_BACKOFF_MS]);
  assert.equal(flow.pending().claim, claim);

  for (const answer of [bare400, bare409, { status: 401, data: {} }]) {
    const spender = setup([answer]);
    const kept = spender.flow.begin();
    assert.deepEqual(await spender.flow.spend("t"), { ok: false, reason: "unavailable" }, JSON.stringify(answer));
    assert.equal(spender.calls.length, 4);
    assert.equal(spender.flow.pending().claim, kept);
  }
});

// ── The unlock token survives a reload ───────────────────────────────────────

const consumed = { status: 200, data: { ok: true } };

test("the token is saved with its claim before consume is called, and a reload replays it after asking verify", async () => {
  const first = setup([answers.offline]);
  const claim = first.flow.begin();
  first.flow.markSent();
  const posts = [];
  // Watch what storage holds at the moment consume is called.
  const flow = createPayFlow({
    storage: first.storage,
    post: async (name, body) => {
      posts.push({ name, body, saved: JSON.parse(first.storage.getItem(CLAIM_KEY)) });
      throw new Error("network");
    },
    now: () => 1_000_000,
    sleep: async () => {},
    locks: locksFor(first.storage),
  });
  assert.deepEqual(await flow.unlock({ claim, token: "token-1", expiresAt: 1_600_000 }), { ok: false, reason: "unavailable" });
  assert.equal(posts.length, 4);
  for (const post of posts) {
    assert.equal(post.name, "consume");
    assert.equal(post.body.token, "token-1");
    assert.equal(post.saved.claim, claim);
    assert.equal(post.saved.token, "token-1");
    assert.equal(post.saved.tokenExpiresAt, 1_600_000);
  }
  assert.equal(first.flow.pending().claim, claim);

  // The page is reloaded. The consume did land, so verify says the payment is spent: the
  // saved token is what spent it, so it is handed back, and replaying it gets "ok".
  const reloaded = setup([answers.used, consumed], { storage: first.storage, start: 1_000_000 + 60 * 60_000 });
  assert.deepEqual(await reloaded.flow.watch(), { outcome: "paid", claim, token: "token-1", expiresAt: 1_600_000 });
  assert.deepEqual(await reloaded.flow.unlock({ claim, token: "token-1", expiresAt: 1_600_000 }), { ok: true });
  assert.deepEqual(
    reloaded.calls.map((c) => [c.name, c.body.token]),
    [["verify", undefined], ["consume", "token-1"]]
  );
  assert.equal(reloaded.flow.pending(), null);

  // The consume never landed: verify issues a fresh token, and the saved one is still sent first.
  const again = setup([answers.offline]);
  const unspent = again.flow.begin();
  again.flow.markSent();
  await again.flow.unlock({ claim: unspent, token: "token-1", expiresAt: 1_600_000 });
  const later = setup([{ status: 200, data: { ok: true, token: "token-2", expiresAt: 9 } }, consumed], { storage: again.storage });
  const watched = await later.flow.watch();
  assert.deepEqual(watched, { outcome: "paid", claim: unspent, token: "token-2", expiresAt: 9 });
  assert.deepEqual(await later.flow.unlock(watched), { ok: true });
  assert.deepEqual(later.calls.at(-1), { name: "consume", body: { token: "token-1" } });
});

test("a saved token is replayed before a newer one, and verify is asked only when it comes back stale", async () => {
  // The saved token won an earlier spend whose answer was lost; a newer token would be refused as "reused".
  const claim = "c".repeat(44);
  const storage = fakeStorage({
    [CLAIM_KEY]: JSON.stringify({ claim, createdAt: 1, sentAt: 2, token: "won", tokenExpiresAt: 5 }),
  });
  const replay = setup([consumed], { storage });
  assert.deepEqual(await replay.flow.unlock({ claim, token: "newer", expiresAt: 9 }), { ok: true });
  assert.deepEqual(replay.calls.map((c) => c.body.token), ["won"]);

  for (const stale of [{ status: 401, data: { reason: "expired" } }, { status: 400, data: { reason: "bad" } }]) {
    const fresh = { status: 200, data: { ok: true, token: "fresh", expiresAt: 99 } };
    const { flow, calls, storage: saved } = setup([stale, fresh, consumed]);
    const mine = flow.begin();
    flow.markSent();
    assert.deepEqual(await flow.unlock({ claim: mine, token: "old", expiresAt: 1 }), { ok: true });
    assert.deepEqual(
      calls.map((c) => [c.name, c.body.token]),
      [["consume", "old"], ["verify", undefined], ["consume", "fresh"]]
    );
    assert.equal(saved.map.has(CLAIM_KEY), false);
  }

  // Stale, and verify then says the payment was spent, or refunded: the attempt is over.
  for (const [answer, reason] of [
    [answers.used, "reused"],
    [{ status: 409, data: { ok: false, reason: "refunded", message: "Refunded." } }, "refunded"],
  ]) {
    const used = setup([{ status: 401, data: { reason: "expired" } }, answer]);
    const spentClaim = used.flow.begin();
    assert.equal((await used.flow.unlock({ claim: spentClaim, token: "old" })).reason, reason);
    assert.equal(used.flow.pending(), null);
  }
});

test("a token is only ever spent for the claim it was issued for (two tabs, a stale token, a newer payment)", async () => {
  // sim/two-tabs.mjs from the review: tab A holds T_A for C1 in memory. Tab B spends C1
  // with its own T_B, then the customer pays again in tab B (C2, sent). Tab A then starts a grind.
  const storage = fakeStorage();
  const tabA = setup([{ status: 200, data: { ok: true, token: "T_A", expiresAt: 9e15 } }, { status: 409, data: { ok: false, reason: "reused" } }], { storage });
  const tabB = setup([consumed], { storage });
  const c1 = tabB.flow.begin();
  tabB.flow.markSent(undefined, c1);
  const paidA = await tabA.flow.watch();
  assert.deepEqual(paidA, { outcome: "paid", claim: c1, token: "T_A", expiresAt: 9e15 });
  assert.deepEqual(await tabB.flow.unlock({ claim: c1, token: "T_B", expiresAt: 9e15 }), { ok: true });
  const c2 = tabB.flow.begin();
  tabB.flow.markSent([{ signature: new Uint8Array(64).fill(5) }], c2);
  const before = storage.map.get(CLAIM_KEY);

  assert.deepEqual(await tabA.flow.unlock(paidA), { ok: false, reason: "elsewhere" });
  // C2, a payment that was sent, is untouched, and tab A sent nothing to consume.
  assert.equal(storage.map.get(CLAIM_KEY), before);
  assert.deepEqual(tabA.calls.map((c) => c.name), ["verify"]);
  // A token without the claim it was issued for spends nothing.
  assert.deepEqual(await tabA.flow.unlock({ token: "T_A" }), { ok: false, reason: "unavailable" });
  assert.equal(storage.map.get(CLAIM_KEY), before);
});

/** The real consume, ledger and tokens, behind a post() that can hold a request in flight. */
function realServer() {
  const secret = "s".repeat(64);
  const ledger = memoryStore();
  const signature = newSignature();
  const issue = () => signUnlockToken({ signature, secret, now: 1_000_000 });
  const oks = [];
  const post = (tab, { hold } = {}) => async (name, body) => {
    if (name !== "consume") throw new Error(`unexpected ${name}`);
    if (hold) await hold;
    const result = await consumeUnlock({ token: body.token, store: ledger, secret, now: 1_000_000 });
    if (result.ok) oks.push(tab);
    return { status: result.status, data: { ok: result.ok, reason: result.reason } };
  };
  return { issue, post, oks, ledger };
}

test("one payment reaches one grind across tabs: a second tab never replays the token of a spend in flight", async () => {
  for (const locks of ["web locks", "lease in storage"]) {
    // sim/replay.mjs from the review: tab B's spend is in flight when tab A starts a grind.
    const storage = fakeStorage();
    const server = realServer();
    const flowLocks = locks === "web locks" ? locksFor(storage) : null;
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    const options = { storage, now: () => 1_000_000, sleep: yieldToTimers, locks: flowLocks };
    const B = createPayFlow({ ...options, post: server.post("B", { hold }) });
    const A = createPayFlow({ ...options, post: server.post("A") });
    const claim = B.begin();
    B.markSent(undefined, claim);
    const T_B = server.issue();
    const T_A = server.issue();
    const pb = B.unlock({ claim, ...T_B });
    await yieldToTimers();
    const pa = A.unlock({ claim, ...T_A });
    await yieldToTimers();
    release();
    const [b, a] = await Promise.all([pb, pa]);
    assert.deepEqual(b, { ok: true }, locks);
    assert.deepEqual(a, { ok: false, reason: "elsewhere" }, locks);
    assert.deepEqual(server.oks, ["B"], locks);
    assert.equal(storage.map.has(CLAIM_KEY), false, locks);
    assert.equal(storage.map.has(`${SPEND_LOCK}-lease`), false, locks);
  }
});

test("one payment reaches one grind across tabs: a spend left unanswered is finished by one tab only", async () => {
  // Tab A's consume never got an answer (service down), so its token stays saved with the claim.
  const storage = fakeStorage();
  const server = realServer();
  const A = setup([answers.down], { storage });
  const claim = A.flow.begin();
  A.flow.markSent(undefined, claim);
  const T_A = server.issue();
  assert.deepEqual(await A.flow.unlock({ claim, ...T_A }), { ok: false, reason: "unavailable" });
  // Tab B opens. verify says the payment is unspent and gives B its own token.
  const T_B = server.issue();
  const B = createPayFlow({
    storage,
    now: () => 1_000_000,
    sleep: yieldToTimers,
    locks: locksFor(storage),
    post: async (name, body) => (name === "verify" ? { status: 200, data: { ok: true, ...T_B } } : server.post("B")(name, body)),
  });
  const paidB = await B.watch();
  assert.equal(paidB.outcome, "paid");
  // B replays the saved T_A (it may have won), and wins. Tab A then retries its own T_A.
  assert.deepEqual(await B.unlock(paidB), { ok: true });
  const retryA = createPayFlow({ storage, now: () => 1_000_000, sleep: yieldToTimers, locks: locksFor(storage), post: server.post("A") });
  assert.deepEqual(await retryA.unlock({ claim, ...T_A }), { ok: false, reason: "elsewhere" });
  assert.deepEqual(server.oks, ["B"]);
});

test("without Web Locks a lease in storage keeps spends apart, and a lease left by a closed tab runs out", async () => {
  const storage = fakeStorage();
  const clock = { now: 1_000_000 };
  const stale = { owner: "a tab that was closed", until: clock.now + LEASE_MS };
  storage.setItem(`${SPEND_LOCK}-lease`, JSON.stringify(stale));
  const posts = [];
  let sleeps = 0;
  const flow = createPayFlow({
    storage,
    now: () => clock.now,
    sleep: async (ms) => {
      if (++sleeps > MAX_SLEEPS) throw new Error("never settled");
      clock.now += ms;
      await yieldToTimers();
    },
    locks: null,
    post: async (name, body) => {
      posts.push({ name, at: clock.now, lease: JSON.parse(storage.getItem(`${SPEND_LOCK}-lease`)) });
      return consumed;
    },
  });
  const claim = flow.begin();
  assert.deepEqual(await flow.unlock({ claim, token: "t" }), { ok: true });
  // It waited for the old lease to run out, then spent under its own.
  assert.equal(posts.length, 1);
  assert.ok(posts[0].at >= stale.until, String(posts[0].at - stale.until));
  assert.notEqual(posts[0].lease.owner, stale.owner);
  assert.equal(storage.getItem(`${SPEND_LOCK}-lease`), null);
});

test("a saved token never strands the browser: every look asks verify, a refused payment is dropped, and give-up stays on offer", async () => {
  const claim = encodeBase58(new Uint8Array(randomBytes(32)));
  const record = { claim, createdAt: 1_000_000, sentAt: 1_000_000, token: "stale", tokenExpiresAt: 1 };

  // After a payee change verify finds the claim's own transaction paid someone else.
  const refused = setup([answers.wrongAmount], { storage: fakeStorage({ [CLAIM_KEY]: JSON.stringify(record) }) });
  assert.deepEqual(await refused.flow.watch(), { outcome: "rejected", reason: "wrong_amount", message: "" });
  assert.equal(refused.calls[0].name, "verify");
  assert.equal(refused.flow.pending(), null);
  // The customer may be owed a refund: its reference (never the claim) is kept.
  const [note] = refused.flow.refundNotes();
  assert.equal(note.reference, await referenceOf(claim));
  assert.equal(note.why, "rejected");
  assert.doesNotMatch(refused.storage.map.get(REFUND_NOTES_KEY), new RegExp(claim));

  // A node that does not know the payment any more: a paid claim is never given up on its own,
  // and after ten minutes the customer is offered to give it up.
  const infos = [];
  const controller = new AbortController();
  const lost = setup(
    [
      () => {
        if (infos.length === 300) controller.abort();
        return answers.unseen;
      },
    ],
    { storage: fakeStorage({ [CLAIM_KEY]: JSON.stringify(record) }) }
  );
  assert.deepEqual(await lost.flow.watch({ signal: controller.signal, onState: (state, info) => infos.push(info) }), { outcome: "stopped" });
  assert.equal(lost.flow.pending().claim, claim);
  assert.ok(infos.every((info) => info.giveUpIn === null));
  assert.equal(infos[0].canAbandon, false);
  assert.equal(infos.at(-1).canAbandon, true);
});

// ── A long wait can be given up, and the page says how long ─────────────────

test("after ten minutes unresolved the customer may give the attempt up; before that they may not", async () => {
  const infos = [];
  let polls = 0;
  const controller = new AbortController();
  const script = [
    () => {
      if (++polls === 260) controller.abort();
      return answers.down;
    },
  ];
  const { flow, clock } = setup(script);
  const claim = flow.begin();
  flow.markSent();
  const sentAt = clock.now;
  await flow.watch({ signal: controller.signal, onState: (state, info) => infos.push({ at: clock.now, state, ...info }) });
  assert.ok(infos.length > 40);
  for (const info of infos) {
    assert.equal(info.claim, claim);
    assert.equal(info.canAbandon, info.at - sentAt >= ABANDON_OFFER_AFTER_MS, String(info.at - sentAt));
  }
  assert.equal(infos.at(-1).canAbandon, true);
  // Still saved: only the customer can give it up.
  assert.equal(flow.pending().claim, claim);
  assert.equal(await flow.abandon("someone-else"), null);
  assert.equal(flow.pending().claim, claim);
  const given = await flow.abandon(claim);
  assert.deepEqual(given, { reference: await referenceOf(claim), signature: null });
  assert.equal(flow.pending(), null);
  assert.doesNotThrow(() => flow.begin());
});

test("while a payment is unseen the page is told how long until it is given up, and why it is waiting", async () => {
  const infos = [];
  const { flow, clock } = setup([answers.unseen]);
  flow.begin();
  clock.now += 120_000; // two minutes in the wallet
  flow.markSent(undefined, undefined, { walletError: true });
  const sentAt = clock.now;
  assert.deepEqual(await flow.watch({ onState: (state, info) => infos.push({ at: clock.now, state, ...info }) }), { outcome: "gone" });
  assert.ok(infos.length > 50);
  for (const info of infos) {
    assert.equal(info.state, "unseen");
    assert.equal(info.walletError, true);
    assert.equal(info.signature, false);
    assert.equal(info.canAbandon, false);
    assert.equal(info.giveUpIn, Math.max(0, sentAt + GIVE_UP_AFTER_MS - info.at));
  }
});

// ── prepare → the page's check → the wallet ──────────────────────────────────

/** A server whose prepare builds the transfer for the claim it is sent, the way prepare.mjs does, to `payTo`. */
function preparing({ payTo = PAY_TO, then = [answers.unseen] } = {}) {
  return [
    (clock, body) => ({
      status: 200,
      data: {
        transaction: buildUnsignedTransaction({
          payer: body.payer,
          payTo,
          reference: referenceForClaim(body.claim),
          blockhash: encodeBase58(new Uint8Array(randomBytes(32))),
        }),
      },
    }),
    ...then,
  ];
}

/** A wallet that records what it was asked to sign, then answers with `result` (or throws it). */
function wallet(result) {
  const signed = [];
  return {
    signed,
    async signAndSend(bytes) {
      signed.push(bytes);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("only the transfer prepare built for this claim reaches the wallet, byte for byte", async () => {
  const signature = new Uint8Array(64).fill(9);
  const { flow, calls, replies, storage } = setup(preparing());
  const w = wallet([{ signature }]);
  const result = await flow.pay({ payer: PAYER, signAndSend: w.signAndSend });
  assert.equal(result.outcome, "sent");
  assert.equal(calls[0].name, "prepare");
  assert.deepEqual(calls[0].body, { payer: PAYER, claim: result.claim });
  assert.equal(w.signed.length, 1);
  const sent = Buffer.from(w.signed[0]).toString("base64");
  assert.equal(sent, replies[0].data.transaction);
  // The claim is the one the transaction was built for, with the wallet's signature and the clock started.
  const saved = JSON.parse(storage.map.get(CLAIM_KEY));
  assert.equal(saved.claim, result.claim);
  assert.equal(saved.signature, encodeBase58(signature));
  assert.equal(typeof saved.sentAt, "number");
});

test("a transfer that is not exactly the expected one is never handed to the wallet, and the claim is cleared", async () => {
  for (const payTo of [STRANGER, PAYER]) {
    const { flow, storage } = setup(preparing({ payTo }));
    const w = wallet([{ signature: new Uint8Array(64) }]);
    const result = await flow.pay({ payer: PAYER, signAndSend: w.signAndSend });
    assert.equal(result.outcome, "refused", payTo);
    assert.equal(typeof result.problem, "string");
    assert.equal(w.signed.length, 0);
    assert.equal(storage.map.has(CLAIM_KEY), false);
  }
  // A transaction for another attempt is refused too.
  const other = referenceForClaim(encodeBase58(new Uint8Array(randomBytes(32))));
  const { flow } = setup([
    () => ({ status: 200, data: { transaction: buildUnsignedTransaction({ payer: PAYER, payTo: PAY_TO, reference: other, blockhash: PAYER }) } }),
  ]);
  const w = wallet([]);
  assert.equal((await flow.pay({ payer: PAYER, signAndSend: w.signAndSend })).outcome, "refused");
  assert.equal(w.signed.length, 0);
});

test("when the page's check cannot run, nothing is signed", async () => {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  subtle.digest = async () => {
    throw new Error("no SubtleCrypto here");
  };
  try {
    const { flow, storage } = setup(preparing());
    const w = wallet([{ signature: new Uint8Array(64) }]);
    const result = await flow.pay({ payer: PAYER, signAndSend: w.signAndSend });
    assert.deepEqual(result, { outcome: "refused", problem: "check failed" });
    assert.equal(w.signed.length, 0);
    assert.equal(storage.map.has(CLAIM_KEY), false);
  } finally {
    subtle.digest = original;
  }
});

test("a wallet error nobody recognises keeps the claim and follows it; a known refusal clears it", async () => {
  const unknown = setup(preparing());
  const result = await unknown.flow.pay({ payer: PAYER, signAndSend: wallet(new Error("Unexpected error")).signAndSend });
  assert.equal(result.outcome, "unknown");
  const kept = unknown.flow.pending();
  assert.equal(kept.claim, result.claim);
  assert.equal(kept.walletError, true);
  assert.equal(kept.sentAt, unknown.clock.now);

  for (const [error, kind] of [
    [new Error("User rejected the request."), "rejected"],
    [new Error("Transfer: insufficient lamports 1000, need 2039280"), "insufficient_sol"],
  ]) {
    const { flow, storage } = setup(preparing());
    assert.deepEqual(await flow.pay({ payer: PAYER, signAndSend: wallet(error).signAndSend }), { outcome: "declined", kind });
    assert.equal(storage.map.has(CLAIM_KEY), false, kind);
    assert.ok(PAY_ERRORS[kind]);
  }
});

test("a wallet that answers after another tab replaced the attempt leaves the new attempt alone", async () => {
  const storage = fakeStorage();
  const other = createPayFlow({ storage, post: async () => ({ status: 202, data: {} }) });
  let replaced;
  for (const answer of [[{ signature: new Uint8Array(64).fill(3) }], new Error("User rejected the request.")]) {
    storage.map.clear();
    // Same browser storage as the other tab.
    const shared = createPayFlow({ storage, post: async (name, body) => preparing()[0](null, body) });
    const result = await shared.pay({
      payer: PAYER,
      async signAndSend() {
        // While the wallet is open, the other tab gives this attempt up and starts its own.
        other.forget(other.pending().claim);
        replaced = other.begin();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    assert.notEqual(result.claim, replaced);
    const now = JSON.parse(storage.map.get(CLAIM_KEY));
    assert.equal(now.claim, replaced);
    assert.equal(now.signature, undefined);
    assert.equal(now.sentAt, null);
  }
});

test("prepare that is unreachable, or refuses, starts nothing", async () => {
  for (const [answer, outcome] of [
    [answers.offline, "unreachable"],
    [{ status: 402, data: { reason: "insufficient_usdc", error: "no USDC" } }, "not_prepared"],
    [{ status: 400, data: { reason: "payee", error: "another wallet" } }, "not_prepared"],
    [{ status: 200, data: { transaction: "%%% not base64" } }, "unreachable"],
  ]) {
    const { flow, storage } = setup([answer]);
    const w = wallet([]);
    const result = await flow.pay({ payer: PAYER, signAndSend: w.signAndSend });
    assert.equal(result.outcome, outcome);
    assert.equal(w.signed.length, 0);
    assert.equal(storage.map.has(CLAIM_KEY), false);
  }
  const busy = setup([answers.unseen]);
  const claim = busy.flow.begin();
  assert.deepEqual(await busy.flow.pay({ payer: PAYER, signAndSend: wallet([]).signAndSend }), { outcome: "busy" });
  assert.equal(busy.flow.pending().claim, claim);
  assert.equal(busy.calls.length, 0);
});

// ── Round 4 ──────────────────────────────────────────────────────────────────

test("a resend refused at preflight is no proof nothing was sent: the claim is kept and the payment is found", async () => {
  for (const error of [
    new Error("Simulation failed. \nMessage: Transaction simulation failed: This transaction has already been processed."),
    new Error("Transaction simulation failed: Blockhash not found"),
  ]) {
    const { flow, calls } = setup(preparing({ then: [answers.paid] }));
    const result = await flow.pay({ payer: PAYER, signAndSend: wallet(error).signAndSend });
    assert.equal(result.outcome, "unknown", error.message);
    assert.equal(flow.pending().claim, result.claim);
    assert.equal(flow.pending().walletError, true);
    const found = await flow.watch();
    assert.deepEqual(found, { outcome: "paid", claim: result.claim, token: "token-1", expiresAt: 1_600_000 });
    assert.deepEqual(calls[1], { name: "verify", body: { claim: result.claim } });
  }
});

test("a given-up payment's reference is kept until the customer hides it, across reloads and later payments", async () => {
  const signature = new Uint8Array(64).fill(4);
  const first = setup([answers.down]);
  const claim = first.flow.begin();
  first.flow.markSent([{ signature }], claim);
  const given = await first.flow.abandon(claim);
  const reference = await referenceOf(claim);
  assert.deepEqual(given, { reference, signature: encodeBase58(signature) });

  // A reload, then a new payment that is found and spent: the note is still there.
  const later = setup([answers.paid, consumed], { storage: first.storage });
  assert.deepEqual(later.flow.refundNotes().map(({ reference: r, signature: s, why }) => ({ r, s, why })), [
    { r: reference, s: encodeBase58(signature), why: "abandoned" },
  ]);
  const next = later.flow.begin();
  later.flow.markSent(undefined, next);
  const paid = await later.flow.watch();
  assert.deepEqual(await later.flow.unlock(paid), { ok: true });
  assert.equal(later.flow.refundNotes().length, 1);
  // The claim, which would let anyone redeem the payment, is never kept with the note.
  assert.doesNotMatch(later.storage.map.get(REFUND_NOTES_KEY), new RegExp(claim));

  later.flow.dismissRefund("some other reference");
  assert.equal(later.flow.refundNotes().length, 1);
  later.flow.dismissRefund(reference);
  assert.deepEqual(later.flow.refundNotes(), []);
  assert.equal(later.storage.map.has(REFUND_NOTES_KEY), false);
  // Damaged notes read as none.
  later.storage.setItem(REFUND_NOTES_KEY, "{not json");
  assert.deepEqual(later.flow.refundNotes(), []);
});

test("a long reference history is followed with the cursor the server returns, across a reload", async () => {
  const cursor1 = newSignature();
  const cursor2 = newSignature();
  const searching = (cursor) => ({ status: 202, data: { ok: false, reason: "searching", cursor } });
  const first = setup([searching(cursor1), searching(cursor2)]);
  const claim = first.flow.begin();
  first.flow.markSent(undefined, claim);
  const states = [];
  const controller = new AbortController();
  await first.flow.watch({
    signal: controller.signal,
    onState: (state) => {
      states.push(state);
      if (states.length === 2) controller.abort();
    },
  });
  assert.deepEqual(states, ["searching", "searching"]);
  assert.deepEqual(first.calls.map((c) => c.body.cursor), [undefined, cursor1]);
  assert.equal(first.flow.pending().cursor, cursor2);

  // The page is reloaded: the search carries on from where it was.
  const reloaded = setup([answers.paid], { storage: first.storage });
  assert.equal((await reloaded.flow.watch()).outcome, "paid");
  assert.deepEqual(reloaded.calls[0].body, { claim, cursor: cursor2 });

  // "searching" without a cursor that is a signature decides nothing and saves nothing.
  for (const cursor of [undefined, "../x", 5]) {
    const odd = setup([searching(cursor)]);
    odd.flow.begin();
    assert.deepEqual(await odd.flow.check(), { state: "unavailable" });
    assert.equal(odd.flow.pending().cursor, null);
  }
});

test("a fresh token fetched while another tab replaced the attempt is never saved onto the new attempt", async () => {
  const storage = fakeStorage();
  const other = setup([answers.unseen], { storage });
  let newer = null;
  // Both flows draw the same test randomness: move the other tab past the claim this tab will draw.
  other.flow.forget(other.flow.begin());
  const replaceDuringVerify = () => {
    other.flow.forget(other.flow.pending().claim); // the other tab gave this payment up and began its own
    newer = other.flow.begin();
    return answers.paid;
  };
  const tab = setup([{ status: 401, data: { ok: false, reason: "expired" } }, replaceDuringVerify, consumed], { storage });
  const claim = tab.flow.begin();
  tab.flow.markSent(undefined, claim);
  const result = await tab.flow.unlock({ claim, token: "stale", expiresAt: 1 });
  assert.deepEqual(result, { ok: false, reason: "elsewhere" });
  assert.deepEqual(tab.calls.map((c) => c.name), ["consume", "verify"]);
  assert.notEqual(newer, claim);
  assert.equal(tab.flow.pending().claim, newer);
  assert.equal(tab.flow.pending().token, null);
});

// ── Round 5: a lease that lasts as long as its spend ──────────────────────────

/** A sleep on a clock two tabs share: time moves for both, and timers still run. */
function sharedSleep(clock) {
  let sleeps = 0;
  return async (ms) => {
    if (++sleeps > MAX_SLEEPS) throw new Error(`the flow never settled: ${MAX_SLEEPS} sleeps`);
    clock.now += ms;
    await yieldToTimers();
  };
}

test("without Web Locks a spend that outlasts LEASE_MS renews its lease before each request: the other tab waits, one grind", async () => {
  const storage = fakeStorage();
  const clock = { now: 1_000_000 };
  const server = realServer();
  const options = { storage, now: () => clock.now, sleep: sharedSleep(clock), locks: null };
  const B = createPayFlow({ ...options, post: server.post("B") });
  let pb = null;
  let attempts = 0;
  const A = createPayFlow({
    ...options,
    post: async (name, body) => {
      attempts += 1;
      if (attempts === 1) {
        clock.now += 100_000; // a slow answer that never came
        return answers.down;
      }
      // The second attempt is slow too, and tab B starts a grind while it is on its way.
      pb = B.unlock({ claim, ...server.issue() });
      for (let i = 0; i < 20; i++) {
        await yieldToTimers();
        clock.now += 5_000;
      }
      return server.post("A")(name, body);
    },
  });
  const claim = A.begin();
  A.markSent(undefined, claim);
  assert.deepEqual(await A.unlock({ claim, ...server.issue() }), { ok: true });
  assert.deepEqual(await pb, { ok: false, reason: "elsewhere" });
  assert.ok(clock.now - 1_000_000 > LEASE_MS, "the spend outlasted one lease");
  assert.deepEqual(server.oks, ["A"]);
  assert.equal(storage.map.has(`${SPEND_LOCK}-lease`), false);
});

test("without Web Locks a tab that lost its lease (frozen past LEASE_MS) sends nothing more", async () => {
  const storage = fakeStorage();
  const clock = { now: 1_000_000 };
  const server = realServer();
  const options = { storage, now: () => clock.now, sleep: sharedSleep(clock), locks: null };
  const B = createPayFlow({ ...options, post: server.post("B") });
  let pb = null;
  const sentByA = [];
  const A = createPayFlow({
    ...options,
    post: async (name, body) => {
      sentByA.push(body.token);
      if (sentByA.length === 1) {
        // The tab is frozen past its lease; tab B takes over and spends the saved token.
        clock.now += LEASE_MS + 1;
        pb = B.unlock({ claim, ...server.issue() });
        assert.deepEqual(await pb, { ok: true });
        return answers.down;
      }
      return server.post("A")(name, body);
    },
  });
  const claim = A.begin();
  A.markSent(undefined, claim);
  assert.deepEqual(await A.unlock({ claim, ...server.issue() }), { ok: false, reason: "elsewhere" });
  assert.equal(sentByA.length, 1);
  assert.deepEqual(server.oks, ["B"]);
});

test("without Web Locks two tabs that both find no lease and write one at once: only the last writer spends", async () => {
  const storage = fakeStorage();
  const leaseKey = `${SPEND_LOCK}-lease`;
  /** One tab's view of the shared storage: its first look at the lease happens before the other tab's write lands. */
  const tabView = () => {
    let looked = false;
    return {
      getItem: (key) => {
        if (key === leaseKey && !looked) {
          looked = true;
          return null;
        }
        return storage.getItem(key);
      },
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };
  };
  const clock = { now: 1_000_000 };
  const server = realServer();
  const sent = [];
  const tab = (name) =>
    createPayFlow({
      storage: tabView(),
      now: () => clock.now,
      sleep: sharedSleep(clock),
      random: (n) => Uint8Array.from({ length: n }, (_, i) => (i + name.charCodeAt(0)) % 256),
      locks: null,
      post: async (route, body) => {
        sent.push([name, body.token]);
        return server.post(name)(route, body);
      },
    });
  const A = tab("A");
  const B = tab("B");
  const claim = A.begin();
  A.markSent(undefined, claim);
  const tokenB = server.issue();
  const results = await Promise.all([A.unlock({ claim, ...server.issue() }), B.unlock({ claim, ...tokenB })]);
  // B spent its own token: A never ran its spend at all, so it saved no token of its own for B to find.
  assert.deepEqual(sent, [["B", tokenB.token]]);
  assert.deepEqual(server.oks, ["B"]);
  assert.deepEqual(results, [{ ok: false, reason: "elsewhere" }, { ok: true }]);
});

// ── Round 6: an answer that arrives after another tab took the spend over ─────

test("without Web Locks a tab frozen past its lease, whose consume reached the server, leaves the outcome to the tab that took over: one grind", async () => {
  const storage = fakeStorage();
  const clock = { now: 1_000_000 };
  const server = realServer();
  const options = { storage, now: () => clock.now, sleep: sharedSleep(clock), locks: null };
  const B = createPayFlow({ ...options, post: server.post("B") });
  let b = null;
  const A = createPayFlow({
    ...options,
    post: async (name, body) => {
      // The token is spent on the server, then the tab freezes before the answer reaches it.
      const answer = await server.post("A")(name, body);
      clock.now += LEASE_MS + 1;
      // Tab B takes the lease and replays the saved token, which the server answers "ok" again.
      b = await B.unlock({ claim, ...server.issue() });
      return answer;
    },
  });
  const claim = A.begin();
  A.markSent(undefined, claim);
  const a = await A.unlock({ claim, ...server.issue() });
  assert.deepEqual(b, { ok: true });
  assert.deepEqual(a, { ok: false, reason: "elsewhere" });
  assert.equal([a, b].filter((result) => result.ok).length, 1, "one payment, one grind");
});

test("without Web Locks a fresh token that verify returns after another tab took the lease is neither saved nor spent", async () => {
  const storage = fakeStorage();
  const clock = { now: 1_000_000 };
  const sent = [];
  const A = createPayFlow({
    storage,
    now: () => clock.now,
    sleep: sharedSleep(clock),
    locks: null,
    post: async (name) => {
      sent.push(name);
      if (name === "consume") return { status: 401, data: { ok: false, reason: "expired" } };
      // verify answers after the tab froze past its lease and another tab took the spend over.
      clock.now += LEASE_MS + 1;
      storage.setItem(`${SPEND_LOCK}-lease`, JSON.stringify({ owner: "another tab", until: clock.now + LEASE_MS }));
      return { status: 200, data: { ok: true, token: "fresh", expiresAt: clock.now + 600_000 } };
    },
  });
  const claim = A.begin();
  A.markSent(undefined, claim);
  assert.deepEqual(await A.unlock({ claim, token: "stale" }), { ok: false, reason: "elsewhere" });
  assert.deepEqual(sent, ["consume", "verify"]);
  assert.equal(A.pending().token, "stale", "the other tab's saved token is left alone");
});

test("without Web Locks the spend of a fresh token stops when another tab takes the lease while it backs off", async () => {
  const storage = fakeStorage();
  const clock = { now: 1_000_000 };
  const sent = [];
  const A = createPayFlow({
    storage,
    now: () => clock.now,
    sleep: sharedSleep(clock),
    locks: null,
    post: async (name, body) => {
      sent.push([name, body.token]);
      if (name === "verify") return { status: 200, data: { ok: true, token: "fresh", expiresAt: clock.now + 600_000 } };
      if (body.token === "stale") return { status: 401, data: { ok: false, reason: "expired" } };
      // The fresh token's first consume gets no answer; while the tab waits to retry, another takes over.
      setImmediate(() => storage.setItem(`${SPEND_LOCK}-lease`, JSON.stringify({ owner: "another tab", until: clock.now + LEASE_MS })));
      return answers.down;
    },
  });
  const claim = A.begin();
  A.markSent(undefined, claim);
  assert.deepEqual(await A.unlock({ claim, token: "stale" }), { ok: false, reason: "elsewhere" });
  assert.deepEqual(sent.map(([name]) => name), ["consume", "verify", "consume"]);
});
