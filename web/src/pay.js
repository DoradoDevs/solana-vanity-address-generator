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

const PREFERRED = ["Phantom", "Solflare", "Backpack"];

let quote = null;
let unlockToken = null;
let waiters = [];
let walletsApi = null;
let watchGeneration = 0;
let paying = false;
let listingWallets = false;

function setStatus(text) {
  const el = document.getElementById("pay-status");
  if (el) el.textContent = text;
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

function walletList() {
  if (!walletsApi) {
    walletsApi = getWallets();
    walletsApi.on("change", () => {
      if (listingWallets) renderWallets();
    });
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
    setStatus(PAY_ERRORS.no_wallet);
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

export function initPay() {
  document.getElementById("pay-wallet")?.addEventListener("click", () => startWallet());
  document.getElementById("pay-cancel")?.addEventListener("click", () => cancelPaymentWait());
  loadQuote();
}

function settleWaiters(result) {
  const pending = waiters.splice(0);
  for (const resolve of pending) resolve(result);
}

export function ensurePaid() {
  if (unlockToken) return Promise.resolve({ ok: true });
  setStatus(`Waiting for the $1 USDC payment. Connect a wallet below, or choose Not now. ${NETWORK_FEE_NOTE}`);
  document.getElementById("pay-gate")?.scrollIntoView({ block: "nearest" });
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function cancelPaymentWait() {
  watchGeneration += 1;
  listingWallets = false;
  settleWaiters({
    ok: false,
    message: "Payment cancelled. Nothing was charged for this attempt.",
  });
}

export async function consumePaidGrind() {
  if (!unlockToken) return { ok: false, message: "Pay $1 before grinding." };
  let result;
  try {
    result = await post("consume", { token: unlockToken });
  } catch {
    return { ok: false, message: "Could not reach payment verification." };
  }
  if (result.data.ok) {
    unlockToken = null;
    setStatus("Grind unlocked. Pay again for another run.");
    document.getElementById("pay-gate")?.classList.remove("paid");
    return { ok: true };
  }
  if (result.data.reason === "expired" || result.data.reason === "reused") unlockToken = null;
  return { ok: false, message: result.data.message || "The payment could not be spent." };
}
