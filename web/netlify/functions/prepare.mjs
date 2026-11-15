import { payToAddress, solanaRpcUrl, TOLERANCE_BPS, USDC_MINT } from "./lib/constants.js";
import { isAddress } from "./lib/address.js";
import { json, readJson } from "./lib/http.js";
import { fetchSolPriceUsd, formatSolAmount, lamportsForOneUsd } from "./lib/price.js";

export default async function prepare(request) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const rpcUrl = solanaRpcUrl();
  if (!rpcUrl) return json({ error: "SOLANA_RPC_URL is not set on the server." }, 500);

  const body = await readJson(request);
  const payer = body?.payer;
  const reference = body?.reference;
  const asset = body?.asset;
  if (!isAddress(payer) || !isAddress(reference) || (asset !== "sol" && asset !== "usdc")) {
    return json({ error: "Send payer, reference, and asset (sol or usdc)." }, 400);
  }

  const payTo = payToAddress();
  if (!isAddress(payTo)) return json({ error: "Payment address is not configured." }, 500);

  let lamports = 0;
  let solAmount = null;
  let priceUsd = null;
  if (asset === "sol") {
    try {
      priceUsd = await fetchSolPriceUsd();
      lamports = lamportsForOneUsd(priceUsd);
      solAmount = formatSolAmount(lamports);
    } catch {
      return json({ error: "The SOL price is unavailable. Pay 1.00 USDC instead." }, 503);
    }
  }

  const { Connection } = await import("@solana/web3.js");
  const { buildUnsignedTransaction } = await import("./lib/tx.js");
  const connection = new Connection(rpcUrl, "confirmed");
  let blockhash;
  try {
    ({ blockhash } = await connection.getLatestBlockhash("confirmed"));
  } catch {
    return json({ error: "The Solana network is unreachable from the server." }, 503);
  }

  const transaction = buildUnsignedTransaction({
    asset,
    payer,
    payTo,
    reference,
    lamports,
    blockhash,
  });

  return json({
    transaction,
    payTo,
    asset,
    usdcMint: USDC_MINT,
    solAmount,
    priceUsd,
    toleranceBps: TOLERANCE_BPS,
  });
}
