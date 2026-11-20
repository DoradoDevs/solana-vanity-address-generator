/**
 * The payment gate: Wallet Standard discovery (@wallet-standard/app) and the
 * page around it. Phantom, Solflare, Backpack, and other Solana wallets
 * register on this page. The browser does not receive the RPC URL: the server
 * builds the 1.00 USDC transfer, transfer-check.js confirms it is exactly
 * that before the wallet sees it, and the connected wallet is the fee payer
 * that signs and sends it. What a payment is, the order prepare → check →
 * wallet, and how a payment is followed to the end live in pay-flow.js; this
 * file is wallets, buttons and wording.
 */
import { getWallets } from "@wallet-standard/app";
import { NETWORK_FEE_NOTE, PAY_ERRORS, messageForWalletError } from "../../shared/pay-copy.js";
import { browserStorage, createPayFlow } from "./pay-flow.js";
import { offerInAppBrowserLinks, phantomBrowseUrl, solflareBrowseUrl } from "./wallet-links.js";

const PREFERRED = ["Phantom", "Solflare", "Backpack"];

const WATCHING = {
  unseen: "Looking for your payment on chain. This usually takes a few seconds.",
  pending: "Payment found. Waiting for the network to finalize it, about 15 seconds.",
  searching: "Many transactions name this payment. Looking through them for yours…",
  unavailable: "The payment check is not answering. Your payment is saved in this browser. Trying again…",
};
const GONE = "No payment from that attempt landed on chain, so no USDC was charged. Choose a wallet to pay again.";
const ABANDONED = "That payment was given up. Choose a wallet to pay again.";
// What DEPLOY.md, "Refund requests", delivers: a payment never used for a grind goes back to
// the wallet that paid it, once it is a day old. Nothing secret is ever asked for.
const REFUND_HOW =
  "you can ask for a refund: open an issue on the project's GitHub page (the Source link at the foot of this page) quoting the reference. A payment that was never used for a grind is refunded to the wallet that paid it, once it is a day old. Post nothing else from this page";
const FAILED =
  "The payment transaction failed on chain, so no USDC moved. Choose a wallet to try again. " + NETWORK_FEE_NOTE;
const NOT_A_PAYMENT =
  "A transaction was found for that attempt, but it did not pay exactly 1.00 USDC, so it cannot unlock a grind.";
const USED = "That payment was already used for a grind.";
const ELSEWHERE = "That payment was already used, or given up, in another tab of this browser.";
const STOPPED =
  "Stopped waiting. If a payment was sent, it is saved in this browser and will be found the next time you reach this step.";
const CANCELLED = "Payment cancelled. Nothing was charged for this attempt.";
const ALREADY_PAID = "This browser already holds a paid grind. Finish the setup in the terminal to start it.";
const RESUMING = "Checking the payment you already started…";
const REFUSED =
  "The payment the server built is not exactly 1.00 USDC to VanityGrinder's address, so this page did not send it to your wallet. Nothing was charged. If the site was just updated, reload the page and try again.";

async function post(name, body) {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const flow = createPayFlow({ storage: browserStorage(), post });

/** The unlock this visit was given: { claim, token, expiresAt }. Only ever spent for that claim. */
let paidUnlock = null;
let spending = false;
let waiters = [];
let walletsApi = null;
let paying = false;
let listingWallets = false;
/** The one follower of the saved payment: { promise, controller }. */
let watching = null;

function setStatus(text) {
  const el = document.getElementById("pay-status");
  if (el) el.textContent = text;
}

function minutesAndSeconds(ms) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the page is waiting for, in words that are true for this attempt. */
function watchingText(state, info) {
  if (state !== "unseen" || info.signature || info.giveUpIn === null) return WATCHING[state];
  const left = minutesAndSeconds(info.giveUpIn);
  if (info.walletError) {
    return `Your wallet reported an error, so this page is making sure no payment went out before you pay again. Up to ${left} left.`;
  }
  return `Looking for a payment from this attempt. If none has landed, you can pay again in ${left} at most.`;
}

/**
 * A note under the payment buttons, with one action. One per kind; a new one replaces the old.
 * `text` is a string, or a list of strings and { id } parts: an id (a reference or a
 * signature) gets its own element, which wraps on a narrow screen and selects whole on a tap.
 */
function showNotice(kind, text, actionLabel, onAction) {
  const gate = document.getElementById("pay-gate");
  const status = document.getElementById("pay-status");
  if (!gate || !status) return;
  clearNotice(kind);
  const box = document.createElement("div");
  box.id = `pay-notice-${kind}`;
  box.className = "pay-mobile-help";
  const note = document.createElement("p");
  note.className = "pay-mobile-note";
  for (const part of Array.isArray(text) ? text : [text]) {
    if (typeof part === "string") {
      note.append(part);
      continue;
    }
    const id = document.createElement("code");
    id.className = "pay-id";
    id.textContent = part.id;
    note.append(id);
  }
  box.appendChild(note);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pay-wallet";
  button.textContent = actionLabel;
  button.addEventListener("click", onAction);
  box.appendChild(button);
  gate.insertBefore(box, status);
}

function clearNotice(kind) {
  document.getElementById(`pay-notice-${kind}`)?.remove();
}

/** A payment from the version of this page before claims: show its reference until the customer hides it. */
function showRetiredNotice() {
  const reference = flow.retiredReference();
  if (!reference) return;
  showNotice(
    "retired",
    [
      "A payment started on an earlier version of this page was never used for a grind, and it cannot unlock one now. Its reference is ",
      { id: reference },
      `. If 1.00 USDC left your wallet for it, ${REFUND_HOW}.`,
    ],
    "Hide this note",
    () => {
      flow.dismissRetired();
      clearNotice("retired");
    }
  );
}

const REFUND_WHY = {
  abandoned: "You gave up a payment from this browser.",
  rejected: "A payment from this browser was found on chain, but it did not pay exactly 1.00 USDC to VanityGrinder, so it cannot unlock a grind.",
};

/**
 * Payments this browser gave up, or whose own transaction paid the wrong amount: each is
 * shown with what to quote for a refund until the customer hides it, across reloads and
 * later payments (pay-flow keeps them). Never the claim, which would let anyone redeem.
 */
function showRefundNotes() {
  for (const note of flow.refundNotes()) {
    const kind = `refund-${note.reference}`;
    showNotice(
      kind,
      [
        `${REFUND_WHY[note.why] ?? REFUND_WHY.abandoned} Its reference is `,
        { id: note.reference },
        ...(note.signature ? [" and its transaction ", { id: note.signature }] : []),
        `. If 1.00 USDC left your wallet for it, ${REFUND_HOW}.`,
      ],
      "Hide this note",
      () => {
        flow.dismissRefund(note.reference);
        clearNotice(kind);
      }
    );
  }
}

/** After a long wait, let the customer give the saved payment up, with a warning, and say how to be refunded. */
function offerAbandon(claim) {
  if (document.getElementById("pay-notice-abandon")) return;
  showNotice(
    "abandon",
    "This payment has been neither confirmed nor ruled out for over ten minutes. You can give it up and pay again.",
    "Give up this payment",
    () =>
      showNotice(
        "abandon",
        "If that payment did go through, this browser will no longer be able to use it, and you will have to ask for a refund. Give it up?",
        "Yes, give it up",
        () => abandonPayment(claim)
      )
  );
}

async function abandonPayment(claim) {
  const given = await flow.abandon(claim);
  watching?.controller.abort();
  clearNotice("abandon");
  if (!given) return;
  showRefundNotes();
  setStatus(ABANDONED);
}

function offerWalletBrowser() {
  return offerInAppBrowserLinks({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    narrow: window.matchMedia("(max-width: 800px)").matches,
  });
}

function renderInAppHelp(list) {
  const help = document.createElement("div");
  help.className = "pay-mobile-help";
  const note = document.createElement("p");
  note.className = "pay-mobile-note";
  note.textContent =
    "On a phone, connect from the Phantom or Solflare in-app browser. Open this page there, then tap Connect wallet.";
  const pageUrl = location.href;
  for (const [label, href] of [
    ["Open in Phantom", phantomBrowseUrl(pageUrl)],
    ["Open in Solflare", solflareBrowseUrl(pageUrl)],
  ]) {
    const link = document.createElement("a");
    link.className = "pay-wallet";
    link.href = href;
    link.rel = "noopener noreferrer";
    link.textContent = label;
    help.appendChild(link);
  }
  help.prepend(note);
  list.appendChild(help);
}

function walletList() {
  if (!walletsApi) {
    walletsApi = getWallets();
    const refresh = () => {
      if (listingWallets) renderWallets();
    };
    walletsApi.on("register", refresh);
    walletsApi.on("unregister", refresh);
  }
  const found = walletsApi.get().filter((wallet) => {
    const chains = wallet.chains || [];
    const features = wallet.features || {};
    return (
      chains.some((chain) => String(chain).startsWith("solana:")) &&
      features["solana:signAndSendTransaction"]
    );
  });
  return found.sort((a, b) => {
    const ai = PREFERRED.indexOf(a.name);
    const bi = PREFERRED.indexOf(b.name);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

function warmWallets() {
  try {
    walletList();
  } catch {
    /* this browser has no Wallet Standard hook */
  }
}

function renderWallets() {
  const list = document.getElementById("pay-wallet-list");
  if (!list) return;
  listingWallets = true;
  list.replaceChildren();
  let wallets = [];
  try {
    wallets = walletList();
  } catch {
    wallets = [];
  }
  if (wallets.length === 0) {
    if (offerWalletBrowser()) {
      renderInAppHelp(list);
      setStatus(
        `No Solana wallet was detected in this browser. Open this page in Phantom or Solflare, then connect. ${NETWORK_FEE_NOTE}`
      );
    } else {
      setStatus(PAY_ERRORS.no_wallet);
    }
    return;
  }
  for (const wallet of wallets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pay-wallet";
    button.textContent = wallet.name;
    button.addEventListener("click", () => payWithWallet(wallet));
    list.appendChild(button);
  }
  setStatus(`Choose Phantom, Solflare, Backpack, or another Solana wallet. ${NETWORK_FEE_NOTE}`);
}

function markPaid(claim, token, expiresAt) {
  paidUnlock = { claim, token, expiresAt };
  listingWallets = false;
  document.getElementById("pay-wallet-list")?.replaceChildren();
  setStatus("Paid. Starting this grind.");
  document.getElementById("pay-gate")?.classList.add("paid");
  settleWaiters({ ok: true });
}

/**
 * Follow the saved payment to its end and put the result on screen.
 * Only one follower runs at a time; later callers share it.
 * @returns {Promise<"paid" | "gone" | "used" | "rejected" | "stopped" | "none">}
 */
function follow() {
  if (watching) return watching.promise;
  const controller = new AbortController();
  const promise = flow
    .watch({
      signal: controller.signal,
      onState: (state, info) => {
        setStatus(watchingText(state, info));
        if (info.canAbandon) offerAbandon(info.claim);
      },
    })
    .then((result) => {
      if (result.outcome !== "stopped") clearNotice("abandon");
      if (result.outcome === "paid") markPaid(result.claim, result.token, result.expiresAt);
      else if (result.outcome === "gone") setStatus(GONE);
      else if (result.outcome === "used") setStatus(result.message || USED);
      else if (result.outcome === "rejected") {
        setStatus(result.reason === "failed" ? FAILED : NOT_A_PAYMENT);
        showRefundNotes();
      }
      // Stopped with nothing left saved: the customer gave the payment up.
      else if (result.outcome === "stopped" && !flow.pending()) return "abandoned";
      return result.outcome;
    })
    .catch(() => {
      // Nothing was decided, so nothing is cleared: the claim stays saved for the next look.
      setStatus(WATCHING.unavailable);
      return "stopped";
    })
    .finally(() => {
      watching = null;
    });
  watching = { promise, controller };
  return promise;
}

async function payWithWallet(wallet) {
  if (paying) return;
  if (paidUnlock) {
    setStatus(ALREADY_PAID);
    return;
  }
  const connect = wallet.features["standard:connect"]?.connect;
  const signAndSend = wallet.features["solana:signAndSendTransaction"]?.signAndSendTransaction;
  if (!connect || !signAndSend) {
    setStatus(`This wallet cannot send a Solana transaction from this page. ${NETWORK_FEE_NOTE}`);
    return;
  }
  paying = true;
  try {
    // A payment that is saved and unresolved is followed to its end before another
    // can be made. If it never landed, the status says so and the next click pays.
    if (flow.pending()) {
      setStatus(RESUMING);
      await follow();
      return;
    }

    setStatus(`Connecting ${wallet.name}…`);
    let accounts;
    try {
      ({ accounts } = await connect());
    } catch (error) {
      setStatus(messageForWalletError(error));
      return;
    }
    if (!accounts?.length) {
      setStatus(PAY_ERRORS.rejected);
      return;
    }
    const account = accounts.find((item) => (item.chains || []).includes("solana:mainnet"));
    if (!account?.address) {
      setStatus(`Switch the wallet to Solana mainnet and try again. ${NETWORK_FEE_NOTE}`);
      return;
    }

    setStatus("Building the 1.00 USDC transfer…");
    // prepare, then this page's check of what prepare built, then the wallet: see flow.pay.
    const result = await flow.pay({
      payer: account.address,
      signAndSend: (transaction) => {
        setStatus(`Approve 1.00 USDC in ${wallet.name}. ${NETWORK_FEE_NOTE}`);
        return signAndSend({ account, chain: "solana:mainnet", transaction });
      },
    });
    switch (result.outcome) {
      case "busy":
        setStatus("Another tab in this browser is already paying. Finish there, or try again shortly.");
        return;
      case "unreachable":
        setStatus("Payment setup is unreachable. Nothing was charged.");
        return;
      case "not_prepared":
        setStatus(PAY_ERRORS[result.reason] || result.error || "Could not build the payment. Try again in a minute.");
        return;
      case "refused":
        console.warn(`payment refused before signing: ${result.problem}`);
        setStatus(REFUSED);
        return;
      case "declined":
        setStatus(PAY_ERRORS[result.kind]);
        return;
      case "unknown":
        setStatus(`${wallet.name} reported a problem. Checking whether the payment went out…`);
        break;
    }
    await follow();
  } finally {
    paying = false;
  }
}

/** The Connect wallet button. With a payment already under way it resumes that one instead. */
function chooseWallet() {
  if (paidUnlock) {
    setStatus(ALREADY_PAID);
    return;
  }
  if (paying) return;
  if (flow.pending()) {
    setStatus(RESUMING);
    follow();
    return;
  }
  renderWallets();
}

export function initPay() {
  document.getElementById("pay-wallet")?.addEventListener("click", () => chooseWallet());
  document.getElementById("pay-cancel")?.addEventListener("click", () => cancelPaymentWait());
  // The price and the tip address are this bundle's own (shared/payment.js, site.config.js). Nothing the server says replaces them.
  const line = document.getElementById("pay-quote");
  if (line) line.textContent = "$1 in USDC per grind, paid from your wallet.";
  warmWallets();
  showRetiredNotice();
  showRefundNotes();
  // A payment from an earlier visit, or one the page was closed on, is picked up straight away.
  if (flow.pending()) {
    setStatus("Checking the payment saved in this browser…");
    follow();
  }
}

function settleWaiters(result) {
  const pending = waiters.splice(0);
  for (const resolve of pending) resolve(result);
}

/** Resolves once this browser holds an unlock, or the user chooses not to pay now. */
export async function ensurePaid() {
  if (paidUnlock) return { ok: true };
  let explained = false;
  if (flow.pending()) {
    const outcome = await follow();
    if (paidUnlock) return { ok: true };
    if (outcome === "stopped") return { ok: false, message: STOPPED };
    // Gone, used or rejected: the status line now says why, so leave it there.
    explained = outcome !== "none";
  }
  if (!explained) {
    setStatus(`Waiting for the $1 USDC payment. Connect a wallet below, or choose Not now. ${NETWORK_FEE_NOTE}`);
  }
  showRetiredNotice();
  showRefundNotes();
  document.getElementById("pay-gate")?.scrollIntoView({ block: "nearest" });
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function cancelPaymentWait() {
  listingWallets = false;
  const message = flow.pending() ? STOPPED : CANCELLED;
  watching?.controller.abort();
  setStatus(message);
  settleWaiters({ ok: false, message });
}

/** True while a spend is on its way to /api/consume: closing the tab then could lose its answer. */
export function spendInProgress() {
  return spending;
}

/**
 * Spend the unlock this browser holds. The grind starts only when this returns ok.
 * flow.unlock spends only for the claim the unlock was issued for, one tab at a
 * time, and saves the token with the claim first, so a spend whose answer was
 * lost is not lost with the page. Whatever it answers short of ok, this visit's
 * unlock is dropped: the saved attempt is the truth, and the next step follows
 * it again (with the give-up offer) instead of holding on to a token.
 */
export async function consumePaidGrind() {
  if (!paidUnlock) return { ok: false, message: "Pay $1 before grinding." };

  spending = true;
  let spent;
  try {
    spent = await flow.unlock(paidUnlock);
  } finally {
    spending = false;
  }

  paidUnlock = null;
  document.getElementById("pay-gate")?.classList.remove("paid");
  if (spent.ok) {
    setStatus("Grind unlocked. Pay again for another run.");
    return { ok: true };
  }
  let message;
  if (spent.reason === "reused" || spent.reason === "refunded") message = spent.message || USED;
  else if (spent.reason === "elsewhere") message = ELSEWHERE;
  else if (spent.reason === "rejected") {
    message = NOT_A_PAYMENT;
    showRefundNotes();
  } else {
    message = "The payment check is not answering. Your payment is saved in this browser. Try again in a moment.";
  }
  setStatus(message);
  return { ok: false, message };
}
