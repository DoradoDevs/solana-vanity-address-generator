// The page's side of a payment, driven with a fake clock and a scripted server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";
import { PAY_ERRORS } from "../../shared/pay-copy.js";
import { referenceForClaim } from "../netlify/functions/lib/claim.js";
import { buildUnsignedTransaction } from "../netlify/functions/lib/tx.js";
import { PAYER, PAY_TO, STRANGER } from "./helpers/chain.js";
import {
  ABANDON_OFFER_AFTER_MS,
  CLAIM_KEY,
  GIVE_UP_AFTER_MS,
  MAX_BACKOFF_MS,
  POLL_MS,
  RETIRED_REF_KEY,
  createPayFlow,
} from "../src/pay-flow.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

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
function setup(script, { storage = fakeStorage(), start = 1_000_000 } = {}) {
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
    clock.now += ms;
  };
  let seed = 1;
  const random = (n) => Uint8Array.from({ length: n }, () => seed++ % 256);
  const flow = createPayFlow({ storage, post, now: () => clock.now, sleep, random });
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
  });
});

test("a second payment cannot be started while one is unresolved", () => {
  const { flow } = setup([answers.unseen]);
  const claim = flow.begin();
  assert.throws(() => flow.begin(), /already pending/);
  assert.equal(flow.pending().claim, claim);
  flow.forget();
  assert.notEqual(flow.begin(), claim);
});

test("a payment that is not visible yet is waited for, through finality, to the unlock", async () => {
  // What a real chain does: nothing for a moment, then seen, then final.
  const { flow, calls, sleeps } = setup([answers.unseen, answers.unseen, answers.pending, answers.pending, answers.paid]);
  const claim = flow.begin();
  flow.markSent();
  const states = [];
  const result = await flow.watch({ onState: (state) => states.push(state) });
  assert.deepEqual(result, { outcome: "paid", token: "token-1", expiresAt: 1_600_000 });
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
  flow.forget(); // another tab gave the old attempt up and started its own
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
    [answers.used, { outcome: "used", message: "That payment was already used for a grind." }],
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
  assert.deepEqual(await reloaded.flow.watch(), { outcome: "paid", token: "token-1", expiresAt: 1_600_000 });

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
  flow.begin();
  assert.deepEqual(await flow.spend("token-1"), { ok: true });
  assert.deepEqual(
    calls.map((call) => [call.name, call.body.token]),
    [["consume", "token-1"], ["consume", "token-1"], ["consume", "token-1"]]
  );
  assert.equal(flow.pending(), null);
});

test("spending reports a used payment, an expired token, and an unreachable service apart", async () => {
  const used = setup([{ status: 409, data: { ok: false, reason: "reused", message: "Already used." } }]);
  used.flow.begin();
  assert.deepEqual(await used.flow.spend("t"), { ok: false, reason: "reused", message: "Already used." });
  assert.equal(used.flow.pending(), null);

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

test("the token is saved with the claim before consume is called, so a lost answer survives a reload", async () => {
  const first = setup([answers.offline]);
  const claim = first.flow.begin();
  first.flow.markSent();
  const posts = [];
  const seen = setup([], { storage: first.storage });
  // Watch what storage holds at the moment consume is called.
  const flow = createPayFlow({
    storage: first.storage,
    post: async (name, body) => {
      posts.push({ name, body, saved: JSON.parse(first.storage.getItem(CLAIM_KEY)) });
      throw new Error("network");
    },
    now: () => 1_000_000,
    sleep: async () => {},
  });
  assert.deepEqual(await flow.unlock({ token: "token-1", expiresAt: 1_600_000 }), { ok: false, reason: "unavailable" });
  assert.equal(posts.length, 4);
  for (const post of posts) {
    assert.equal(post.name, "consume");
    assert.equal(post.body.token, "token-1");
    assert.equal(post.saved.token, "token-1");
    assert.equal(post.saved.tokenExpiresAt, 1_600_000);
  }
  assert.equal(seen.flow.pending().claim, claim);

  // The page is reloaded. The saved token is the answer: no verify, and consume gets that same token.
  const reloaded = setup([consumed], { storage: first.storage, start: 1_000_000 + 60 * 60_000 });
  assert.deepEqual(await reloaded.flow.watch(), { outcome: "paid", token: "token-1", expiresAt: 1_600_000 });
  assert.equal(reloaded.calls.length, 0);
  assert.deepEqual(await reloaded.flow.unlock({ token: "token-1", expiresAt: 1_600_000 }), { ok: true });
  assert.deepEqual(reloaded.calls, [{ name: "consume", body: { token: "token-1" } }]);
  assert.equal(reloaded.flow.pending(), null);
});

test("a saved token is replayed before a newer one, and verify is asked only when it comes back stale", async () => {
  // The saved token won an earlier spend whose answer was lost; a newer token would be refused as "reused".
  const storage = fakeStorage({
    [CLAIM_KEY]: JSON.stringify({ claim: "c".repeat(44), createdAt: 1, sentAt: 2, token: "won", tokenExpiresAt: 5 }),
  });
  const replay = setup([consumed], { storage });
  assert.deepEqual(await replay.flow.unlock({ token: "newer", expiresAt: 9 }), { ok: true });
  assert.deepEqual(replay.calls.map((c) => c.body.token), ["won"]);

  for (const stale of [{ status: 401, data: { reason: "expired" } }, { status: 400, data: { reason: "bad" } }]) {
    const fresh = { status: 200, data: { ok: true, token: "fresh", expiresAt: 99 } };
    const { flow, calls, storage: saved } = setup([stale, fresh, consumed]);
    flow.begin();
    flow.markSent();
    assert.deepEqual(await flow.unlock({ token: "old", expiresAt: 1 }), { ok: true });
    assert.deepEqual(
      calls.map((c) => [c.name, c.body.token]),
      [["consume", "old"], ["verify", undefined], ["consume", "fresh"]]
    );
    assert.equal(saved.map.has(CLAIM_KEY), false);
  }

  // Stale, and verify then says the payment was spent: the attempt is over.
  const used = setup([{ status: 401, data: { reason: "expired" } }, answers.used]);
  used.flow.begin();
  assert.equal((await used.flow.unlock({ token: "old" })).reason, "reused");
  assert.equal(used.flow.pending(), null);
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
  assert.equal(flow.abandon("someone-else"), null);
  assert.equal(flow.pending().claim, claim);
  const given = flow.abandon(claim);
  assert.equal(given.claim, claim);
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
    [new Error("Transaction simulation failed: Blockhash not found"), "not_sent"],
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
        other.forget();
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
