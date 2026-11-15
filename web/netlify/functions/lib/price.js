import { TOLERANCE_BPS } from "./constants.js";

const PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

export async function fetchSolPriceUsd(fetchImpl = fetch) {
  const response = await fetchImpl(PRICE_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("price lookup failed");
  const data = await response.json();
  const usd = data?.solana?.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new Error("price lookup failed");
  }
  return usd;
}

/** Lamports equal to $1 at this SOL price. */
export function lamportsForOneUsd(priceUsd) {
  if (typeof priceUsd !== "number" || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("bad price");
  }
  const lamports = Math.round((1 / priceUsd) * 1_000_000_000);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("bad price");
  return lamports;
}

export function minAcceptableLamports(lamports, toleranceBps = TOLERANCE_BPS) {
  return Math.floor((lamports * (10_000 - toleranceBps)) / 10_000);
}

export function formatSolAmount(lamports) {
  const text = (lamports / 1_000_000_000).toFixed(9);
  return text.replace(/0+$/, "").replace(/\.$/, "");
}
