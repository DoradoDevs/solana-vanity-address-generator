// The page's side of a payment, driven with a fake clock and a scripted server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase58, encodeBase58 } from "../../shared/base58.js";
import { CLAIM_KEY, GIVE_UP_AFTER_MS, MAX_BACKOFF_MS, POLL_MS, createPayFlow } from "../src/pay-flow.js";

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
  paid: { status: 200, data: { ok: true, token: "token-1" } },
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
  const sleeps = [];
  const post = async (name, body) => {
    calls.push({ name, body });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    const answer = typeof step === "function" ? step(clock) : step;
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
  return { flow, storage, clock, calls, sleeps };
}

test("a claim is 32 random bytes in Base58, saved before anything is sent", () => {
  const { flow, storage } = setup([answers.unseen]);
  assert.equal(flow.pending(), null);
  const claim = flow.begin();
  assert.equal(decodeBase58(claim).length, 32);
  assert.deepEqual(JSON.parse(storage.map.get(CLAIM_KEY)), { claim, createdAt: 1_000_000, sentAt: null });
  assert.deepEqual(flow.pending(), { claim, createdAt: 1_000_000, sentAt: null, signature: null });
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
  assert.deepEqual(result, { outcome: "paid", token: "token-1" });
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
  assert.deepEqual(flow.pending(), { claim, createdAt: 1_000_000, sentAt: clock.now, signature });
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
  assert.deepEqual(await reloaded.flow.watch(), { outcome: "paid", token: "token-1" });

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

test("old saved references are removed, and damaged storage reads as nothing saved", () => {
  const storage = fakeStorage({ "vg-pay-ref": "11111111111111111111111111111111", [CLAIM_KEY]: "{not json" });
  const { flow } = setup([answers.unseen], { storage });
  assert.equal(storage.map.has("vg-pay-ref"), false);
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
