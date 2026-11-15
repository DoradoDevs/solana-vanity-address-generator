import { getWallets } from "@wallet-standard/app";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encode } from "uqr";
import { encodeBase58 } from "../../shared/base58.js";

const PREFERRED = ["Phantom", "Solflare", "Backpack"];

let quote = null;
let unlockToken = null;
let waiters = [];
let walletsApi = null;
let watchGeneration = 0;

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

function solanaPayUrl(asset, reference) {
  const params = new URLSearchParams();
  params.set("reference", reference);
  params.set("label", quote?.label || "VanityGrinder");
  params.set("message", quote?.message || "One vanity grind ($1)");
  if (asset === "usdc") {
    params.set("amount", quote.usdc.amount);
    params.set("spl-token", quote.usdc.mint);
  } else {
    params.set("amount", quote.sol.amount);
  }
  return `solana:${quote.payTo}?${params.toString()}`;
}

function drawQr(text) {
  const canvas = document.getElementById("pay-qr");
  if (!canvas) return;
  const qr = encode(text, { ecc: "M", border: 2 });
  const size = qr.size;
  const scale = Math.max(2, Math.floor(280 / size));
  canvas.width = size * scale;
  canvas.height = size * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#07070b";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.data[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  canvas.hidden = false;
}

function showUrl(url) {
  const el = document.getElementById("pay-url");
  if (!el) return;
  el.replaceChildren();
  const label = document.createElement("span");
  label.textContent = url;
  el.appendChild(label);
}

function walletList() {
  if (!walletsApi) walletsApi = getWallets();
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

function renderWallets(asset) {
  const list = document.getElementById("pay-wallet-list");
  if (!list) return;
  list.replaceChildren();
  const wallets = walletList();
  if (wallets.length === 0) {
    const note = document.createElement("p");
    note.textContent =
      "No wallet-standard Solana wallet was detected. Install Phantom, Solflare, or Backpack, or use the QR.";
    list.appendChild(note);
    return;
  }
  for (const wallet of wallets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pay-wallet";
    button.textContent = wallet.name;
    button.addEventListener("click", () => payWithWallet(wallet, asset));
    list.appendChild(button);
  }
}

function markPaid(token) {
  unlockToken = token;
  setStatus("Paid. Starting this grind.");
  document.getElementById("pay-gate")?.classList.add("paid");
  settleWaiters({ ok: true });
}

async function watch(reference, asset) {
  const generation = ++watchGeneration;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (generation !== watchGeneration) return;
    let result;
    try {
      result = await post("verify", { reference, asset });
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
  setStatus("Still waiting on finality. Use the same button again to keep checking this payment.");
}

async function startQr(asset) {
  if (!quote) {
    setStatus("The price quote has not loaded.");
    return;
  }
  if (asset === "sol" && !quote.sol) {
    setStatus("The SOL price is unavailable. Pay 1.00 USDC instead.");
    return;
  }
  const reference = newReference();
  const url = solanaPayUrl(asset, reference);
  drawQr(url);
  showUrl(url);
  document.getElementById("pay-wallet-list")?.replaceChildren();
  setStatus(
    asset === "usdc"
      ? "Scan the QR and send exactly 1.00 USDC. Verification starts when the transfer is finalized."
      : `Scan the QR and send ${quote.sol.amount} SOL (about $1). A few percent of price movement is allowed.`
  );
  await watch(reference, asset);
}

async function payWithWallet(wallet, asset) {
  if (!quote) {
    setStatus("The price quote has not loaded.");
    return;
  }
  if (asset === "sol" && !quote.sol) {
    setStatus("The SOL price is unavailable. Pay 1.00 USDC instead.");
    return;
  }
  const connect = wallet.features["standard:connect"]?.connect;
  const signAndSend = wallet.features["solana:signAndSendTransaction"]?.signAndSendTransaction;
  if (!connect || !signAndSend) {
    setStatus(`${wallet.name} cannot send a Solana transaction from this page. Use the QR.`);
    return;
  }
  setStatus(`Connecting ${wallet.name}…`);
  let accounts;
  try {
    ({ accounts } = await connect());
  } catch {
    setStatus("The wallet connection was cancelled.");
    return;
  }
  const account = (accounts || []).find((item) => (item.chains || []).includes("solana:mainnet"));
  if (!account?.address) {
    setStatus("Switch the wallet to Solana mainnet and try again.");
    return;
  }
  const reference = newReference();
  setStatus("Building the $1 transfer…");
  let prepared;
  try {
    prepared = await post("prepare", { payer: account.address, reference, asset });
  } catch {
    setStatus("Payment setup is unreachable.");
    return;
  }
  if (!prepared.data.transaction) {
    setStatus(prepared.data.error || "Could not build the payment.");
    return;
  }
  const bytes = Uint8Array.from(atob(prepared.data.transaction), (char) => char.charCodeAt(0));
  try {
    await signAndSend({ account, chain: "solana:mainnet", transaction: bytes });
  } catch {
    setStatus("The wallet did not send the payment.");
    return;
  }
  await watch(reference, asset);
}

function startWallet(asset) {
  const canvas = document.getElementById("pay-qr");
  if (canvas) canvas.hidden = true;
  document.getElementById("pay-url")?.replaceChildren();
  renderWallets(asset);
  setStatus("Choose Phantom, Solflare, Backpack, or another Solana wallet.");
}

async function loadQuote() {
  try {
    const response = await fetch("/.netlify/functions/quote");
    if (!response.ok) throw new Error("quote failed");
    quote = await response.json();
  } catch {
    quote = null;
    setStatus("Quote unavailable. Run this site with Netlify so /.netlify/functions/quote can answer.");
    return;
  }
  const line = document.getElementById("pay-quote");
  if (line) {
    const sol = quote.sol
      ? `${quote.sol.amount} SOL at $${quote.sol.priceUsd}`
      : "SOL price unavailable";
    line.textContent = `Send 1.00 USDC, or ${sol}, to ${quote.payTo}.`;
  }
  const tip = document.getElementById("tip-address");
  if (tip && quote.payTo) tip.textContent = quote.payTo;
}

export function initPay() {
  document.getElementById("pay-wallet-usdc")?.addEventListener("click", () => startWallet("usdc"));
  document.getElementById("pay-wallet-sol")?.addEventListener("click", () => startWallet("sol"));
  document.getElementById("pay-qr-usdc")?.addEventListener("click", () => startQr("usdc"));
  document.getElementById("pay-qr-sol")?.addEventListener("click", () => startQr("sol"));
  document.getElementById("pay-cancel")?.addEventListener("click", () => cancelPaymentWait());
  loadQuote();
}

function settleWaiters(result) {
  const pending = waiters.splice(0);
  for (const resolve of pending) resolve(result);
}

export function ensurePaid() {
  if (import.meta.env.DEV) {
    const devQuery = new URLSearchParams(window.location.search).get("dev") === "1";
    if (devQuery) {
      unlockToken = "vg-dev-bypass";
      setStatus("Local dev bypass is on (?dev=1). No payment was sent.");
      return Promise.resolve({ ok: true });
    }
  }
  if (unlockToken) return Promise.resolve({ ok: true });
  setStatus("Waiting for the $1 payment. Use the buttons here, or choose Not now.");
  document.getElementById("pay-gate")?.scrollIntoView({ block: "nearest" });
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function cancelPaymentWait() {
  settleWaiters({
    ok: false,
    message: "Payment cancelled. Nothing was charged for this attempt.",
  });
}

export async function consumePaidGrind() {
  if (import.meta.env.DEV) {
    if (unlockToken === "vg-dev-bypass") {
      unlockToken = null;
      return { ok: true };
    }
  }
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
