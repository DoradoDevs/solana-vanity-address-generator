/**
 * The payment gate: Wallet Standard discovery (@wallet-standard/app) and the
 * page around it. Phantom, Solflare, Backpack, and other Solana wallets
 * register on this page. The browser does not receive the RPC URL: the server
 * builds the 1.00 USDC transfer, transfer-check.js confirms it is exactly
 * that before the wallet sees it, and the connected wallet is the fee payer
 * that signs and sends it. What a payment is and how it is followed to the
 * end lives in pay-flow.js; this file is wallets, buttons and wording.
 */
import { getWallets } from "@wallet-standard/app";
import { NETWORK_FEE_NOTE, PAY_ERRORS, classifyWalletError, messageForWalletError } from "../../shared/pay-copy.js";
import { browserStorage, createPayFlow } from "./pay-flow.js";
import { checkPreparedTransfer } from "./transfer-check.js";
import { offerInAppBrowserLinks, phantomBrowseUrl, solflareBrowseUrl } from "./wallet-links.js";

const PREFERRED = ["Phantom", "Solflare", "Backpack"];

const WATCHING = {
  unseen: "Looking for your payment on chain. This usually takes a few seconds.",
  pending: "Payment found. Waiting for the network to finalize it, about 15 seconds.",
  unavailable: "The payment check is not answering. Your payment is saved in this browser. Trying again…",
};
const GONE = "That payment never reached the chain, so nothing was charged. Choose a wallet to pay again.";
const FAILED =
  "The payment transaction failed on chain, so no USDC moved. Choose a wallet to try again. " + NETWORK_FEE_NOTE;
const NOT_A_PAYMENT =
  "A transaction was found for that attempt, but it did not pay exactly 1.00 USDC, so it cannot unlock a grind.";
const USED = "That payment was already used for a grind.";
const STOPPED =
  "Stopped waiting. If a payment was sent, it is saved in this browser and will be found the next time you reach this step.";
const CANCELLED = "Payment cancelled. Nothing was charged for this attempt.";
const ALREADY_PAID = "This browser already holds a paid grind. Finish the setup in the terminal to start it.";
const RESUMING = "Checking the payment you already started…";
const REFUSED =
  "The payment the server built is not exactly 1.00 USDC to VanityGrinder's address, so this page did not send it to your wallet. Nothing was charged.";

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

let unlockToken = null;
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

function markPaid(token) {
  unlockToken = token;
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
    .watch({ signal: controller.signal, onState: (state) => setStatus(WATCHING[state]) })
    .then((result) => {
      if (result.outcome === "paid") markPaid(result.token);
      else if (result.outcome === "gone") setStatus(GONE);
      else if (result.outcome === "used") setStatus(result.message || USED);
      else if (result.outcome === "rejected") setStatus(result.reason === "failed" ? FAILED : NOT_A_PAYMENT);
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

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function payWithWallet(wallet) {
  if (paying) return;
  if (unlockToken) {
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
    let claim;
    try {
      claim = flow.begin();
    } catch {
      // Another tab of this browser started a payment a moment ago.
      setStatus("Another tab in this browser is already paying. Finish there, or try again shortly.");
      return;
    }
    let bytes;
    try {
      const prepared = await post("prepare", { payer: account.address, claim });
      if (!prepared.data.transaction) {
        flow.forget();
        setStatus(PAY_ERRORS[prepared.data.reason] || prepared.data.error || "Could not build the payment. Try again in a minute.");
        return;
      }
      bytes = bytesFromBase64(prepared.data.transaction);
    } catch {
      flow.forget();
      setStatus("Payment setup is unreachable. Nothing was charged.");
      return;
    }

    // The server builds the transfer; this page decides whether it is the one to sign.
    let problem;
    try {
      problem = await checkPreparedTransfer(bytes, { payer: account.address, claim });
    } catch {
      problem = "check failed";
    }
    if (problem) {
      flow.forget();
      console.warn(`payment refused before signing: ${problem}`);
      setStatus(REFUSED);
      return;
    }

    setStatus(`Approve 1.00 USDC in ${wallet.name}. ${NETWORK_FEE_NOTE}`);
    let sent;
    try {
      sent = await signAndSend({ account, chain: "solana:mainnet", transaction: bytes });
    } catch (error) {
      const kind = classifyWalletError(error);
      if (kind) {
        // Declined, or refused for lack of funds: the wallet sent nothing.
        flow.forget();
        setStatus(PAY_ERRORS[kind]);
        return;
      }
      // Any other failure leaves it unknown whether the transfer went out, so look for it.
      setStatus(`${wallet.name} reported a problem. Checking whether the payment went out…`);
    }
    flow.markSent(sent, claim);
    await follow();
  } finally {
    paying = false;
  }
}

/** The Connect wallet button. With a payment already under way it resumes that one instead. */
function chooseWallet() {
  if (unlockToken) {
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

async function loadQuote() {
  const line = document.getElementById("pay-quote");
  if (line) line.textContent = "$1 in USDC per grind, paid from your wallet.";
  let quote;
  try {
    const response = await fetch("/api/quote");
    if (!response.ok) return;
    quote = await response.json();
  } catch {
    return;
  }
  const tip = document.getElementById("tip-address");
  if (tip && typeof quote?.payTo === "string") tip.textContent = quote.payTo;
}

export function initPay() {
  document.getElementById("pay-wallet")?.addEventListener("click", () => chooseWallet());
  document.getElementById("pay-cancel")?.addEventListener("click", () => cancelPaymentWait());
  loadQuote();
  warmWallets();
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
  if (unlockToken) return { ok: true };
  let explained = false;
  if (flow.pending()) {
    const outcome = await follow();
    if (unlockToken) return { ok: true };
    if (outcome === "stopped") return { ok: false, message: STOPPED };
    // Gone, used or rejected: the status line now says why, so leave it there.
    explained = outcome !== "none";
  }
  if (!explained) {
    setStatus(`Waiting for the $1 USDC payment. Connect a wallet below, or choose Not now. ${NETWORK_FEE_NOTE}`);
  }
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

/** Spend the unlock this browser holds. The grind starts only when this returns ok. */
export async function consumePaidGrind() {
  if (!unlockToken) return { ok: false, message: "Pay $1 before grinding." };

  let spent = await flow.spend(unlockToken);
  if (!spent.ok && (spent.reason === "expired" || spent.reason === "bad")) {
    // Tokens last ten minutes. The payment is still there; ask for a fresh one.
    unlockToken = null;
    const fresh = await flow.check();
    if (fresh.state === "paid") {
      unlockToken = fresh.token;
      spent = await flow.spend(unlockToken);
    } else if (fresh.state === "used") {
      flow.forget();
      spent = { ok: false, reason: "reused" };
    } else {
      spent = { ok: false, reason: "unavailable" };
    }
  }

  if (spent.ok) {
    unlockToken = null;
    setStatus("Grind unlocked. Pay again for another run.");
    document.getElementById("pay-gate")?.classList.remove("paid");
    return { ok: true };
  }
  if (spent.reason === "reused") {
    unlockToken = null;
    document.getElementById("pay-gate")?.classList.remove("paid");
    setStatus(USED);
    return { ok: false, message: USED };
  }
  const message = "The payment check is not answering. Your payment is saved in this browser. Try again in a moment.";
  setStatus(message);
  return { ok: false, message };
}
