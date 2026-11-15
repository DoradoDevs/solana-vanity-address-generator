/**
 * Wallet Standard discovery (@wallet-standard/app). Phantom, Solflare,
 * Backpack, and other Solana wallets register on this page. The browser
 * does not receive the RPC URL: the server builds the 1.00 USDC transfer,
 * and the connected wallet is the fee payer that signs and sends it.
 */
import { getWallets } from "@wallet-standard/app";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeBase58 } from "../../shared/base58.js";
import { NETWORK_FEE_NOTE, PAY_ERRORS, messageForWalletError } from "../../shared/pay-copy.js";
import { isAddress } from "../netlify/functions/lib/address.js";
import { offerInAppBrowserLinks, phantomBrowseUrl, solflareBrowseUrl } from "./wallet-links.js";

const PREFERRED = ["Phantom", "Solflare", "Backpack"];
const REF_KEY = "vg-pay-ref";

let quote = null;
let unlockToken = null;
let memoryRef = "";
let waiters = [];
let walletsApi = null;
let watchGeneration = 0;
let paying = false;
let listingWallets = false;
let resumeTask = null;
let cancelDuringResume = false;

function setStatus(text) {
  const el = document.getElementById("pay-status");
  if (el) el.textContent = text;
}

export function referenceFromSearch(search) {
  const ref = new URLSearchParams(search).get("ref");
  return isAddress(ref) ? ref : null;
}

export function shouldRetryConsume(reason) {
  return reason === "expired" || reason === "invalid";
}

function rememberReference(reference) {
  if (!isAddress(reference)) return;
  memoryRef = reference;
  try {
    localStorage.setItem(REF_KEY, reference);
  } catch {
    /* private mode */
  }
}

function storedReference() {
  if (isAddress(memoryRef)) return memoryRef;
  try {
    const value = localStorage.getItem(REF_KEY) || "";
    if (isAddress(value)) {
      memoryRef = value;
      return value;
    }
  } catch {
    /* private mode */
  }
  return "";
}

function clearReference() {
  memoryRef = "";
  try {
    localStorage.removeItem(REF_KEY);
  } catch {
    /* private mode */
  }
}

function stripRefParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("ref")) return;
    url.searchParams.delete("ref");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

function newReference() {
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  seed.fill(0);
  return encodeBase58(pub);
}

async function post(name, body) {
  const response = await fetch(`/.netlify/functions/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
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

async function watch(reference) {
  const generation = ++watchGeneration;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (generation !== watchGeneration) return;
    let result;
    try {
      result = await post("verify", { reference });
    } catch {
      setStatus("Payment verification is unreachable. On the live site this is /.netlify/functions/verify.");
      return;
    }
    if (generation !== watchGeneration) return;
    if (result.status === 200 && result.data.token) {
      markPaid(result.data.token);
      return;
    }
    if (result.status === 202) {
      setStatus(result.data.message || "Waiting for the payment to finalize.");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      continue;
    }
    if (result.data?.reason === "reused" || result.status === 409) clearReference();
    setStatus(result.data.message || result.data.error || "Payment was not accepted.");
    return;
  }
  setStatus("Still waiting on finality. Connect the wallet again to keep checking this payment.");
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function payWithWallet(wallet) {
  if (paying) return;
  const connect = wallet.features["standard:connect"]?.connect;
  const signAndSend = wallet.features["solana:signAndSendTransaction"]?.signAndSendTransaction;
  if (!connect || !signAndSend) {
    setStatus(`This wallet cannot send a Solana transaction from this page. ${NETWORK_FEE_NOTE}`);
    return;
  }
  paying = true;
  try {
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
    const reference = newReference();
    setStatus("Building the 1.00 USDC transfer…");
    let prepared;
    try {
      prepared = await post("prepare", { payer: account.address, reference });
    } catch {
      setStatus("Payment setup is unreachable.");
      return;
    }
    if (!prepared.data.transaction) {
      const reason = prepared.data.reason;
      setStatus(PAY_ERRORS[reason] || prepared.data.error || "Could not build the payment.");
      return;
    }
    let bytes;
    try {
      bytes = bytesFromBase64(prepared.data.transaction);
    } catch {
      setStatus("Could not build the payment.");
      return;
    }
    setStatus(`Approve 1.00 USDC in ${wallet.name}. ${NETWORK_FEE_NOTE}`);
    try {
      await signAndSend({ account, chain: "solana:mainnet", transaction: bytes });
    } catch (error) {
      setStatus(messageForWalletError(error));
      return;
    }
    rememberReference(reference);
    await watch(reference);
  } finally {
    paying = false;
  }
}

function startWallet() {
  renderWallets();
}

async function loadQuote() {
  const line = document.getElementById("pay-quote");
  if (line) line.textContent = "$1 in USDC per grind, paid from your wallet.";
  try {
    const response = await fetch("/.netlify/functions/quote");
    if (!response.ok) return;
    quote = await response.json();
  } catch {
    return;
  }
  const tip = document.getElementById("tip-address");
  if (tip && quote?.payTo) tip.textContent = quote.payTo;
}

async function resumeReference(reference) {
  if (!isAddress(reference)) return false;
  rememberReference(reference);
  setStatus("Checking the saved payment…");
  let result;
  try {
    result = await post("verify", { reference });
  } catch {
    setStatus("Payment verification is unreachable. On the live site this is /.netlify/functions/verify.");
    return false;
  }
  if (result.status === 200 && result.data.token) {
    markPaid(result.data.token);
    return true;
  }
  if (result.data?.reason === "reused" || result.status === 409) {
    clearReference();
    setStatus(result.data?.message || "That payment was already used for a grind.");
    return false;
  }
  if (result.status === 202) {
    await watch(reference);
    return Boolean(unlockToken);
  }
  setStatus(result.data?.message || result.data?.error || "No payment was found for that reference.");
  return false;
}

function startResume() {
  if (unlockToken) return null;
  if (resumeTask) return resumeTask;
  const reference = storedReference();
  if (!reference) return null;
  resumeTask = resumeReference(reference).finally(() => {
    resumeTask = null;
  });
  return resumeTask;
}

export function initPay() {
  document.getElementById("pay-wallet")?.addEventListener("click", () => startWallet());
  document.getElementById("pay-cancel")?.addEventListener("click", () => cancelPaymentWait());
  loadQuote();
  warmWallets();
  const fromUrl = referenceFromSearch(location.search);
  if (fromUrl) {
    rememberReference(fromUrl);
    stripRefParam();
  }
  if (storedReference()) startResume();
}

function settleWaiters(result) {
  const pending = waiters.splice(0);
  for (const resolve of pending) resolve(result);
}

function waitForUserPayment() {
  setStatus(`Waiting for the $1 USDC payment. Connect a wallet below, or choose Not now. ${NETWORK_FEE_NOTE}`);
  document.getElementById("pay-gate")?.scrollIntoView({ block: "nearest" });
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function ensurePaid() {
  if (unlockToken) return Promise.resolve({ ok: true });
  cancelDuringResume = false;
  const pending = startResume();
  return Promise.resolve(pending).then(() => {
    if (unlockToken) return { ok: true };
    if (cancelDuringResume) {
      return { ok: false, message: "Payment cancelled. Nothing was charged for this attempt." };
    }
    return waitForUserPayment();
  });
}

export function cancelPaymentWait() {
  watchGeneration += 1;
  cancelDuringResume = true;
  listingWallets = false;
  settleWaiters({
    ok: false,
    message: "Payment cancelled. Nothing was charged for this attempt.",
  });
}

async function consumeOnce(token) {
  try {
    const result = await post("consume", { token });
    return {
      ok: Boolean(result.data?.ok),
      reason: result.data?.reason,
      message: result.data?.message,
    };
  } catch {
    return { ok: false, reason: "unreachable", message: "Could not reach payment verification." };
  }
}

export async function consumePaidGrind() {
  if (!unlockToken && storedReference()) {
    await resumeReference(storedReference());
  }
  if (!unlockToken) return { ok: false, message: "Pay $1 before grinding." };

  let spent = await consumeOnce(unlockToken);
  if (!spent.ok && shouldRetryConsume(spent.reason)) {
    setStatus("Payment still settling, retrying…");
    const reference = storedReference();
    if (reference) {
      let verified;
      try {
        verified = await post("verify", { reference });
      } catch {
        verified = { status: 0, data: {} };
      }
      if (verified.status === 200 && verified.data?.token) {
        unlockToken = verified.data.token;
        spent = await consumeOnce(unlockToken);
      } else if (verified.data?.reason === "reused" || verified.status === 409) {
        clearReference();
        unlockToken = null;
        return {
          ok: false,
          message: verified.data?.message || "That payment was already used for a grind.",
        };
      }
    }
  }

  if (spent.ok) {
    unlockToken = null;
    clearReference();
    setStatus("Grind unlocked. Pay again for another run.");
    document.getElementById("pay-gate")?.classList.remove("paid");
    return { ok: true };
  }
  if (spent.reason === "expired" || spent.reason === "reused") unlockToken = null;
  if (spent.reason === "reused") clearReference();
  return { ok: false, message: spent.message || "The payment could not be spent." };
}
