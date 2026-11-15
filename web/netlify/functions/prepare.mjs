import { Connection, PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PAY_ERRORS } from "../../../shared/pay-copy.js";
import { payToAddress, solanaRpcUrl, USDC_MINT } from "./lib/constants.js";
import { isAddress } from "./lib/address.js";
import { assessFunds, readTokenAmount } from "./lib/funds.js";
import { json, readJson } from "./lib/http.js";
import { buildUnsignedTransaction } from "./lib/tx.js";

/**
 * Build the unsigned 1.00 USDC transfer on the server.
 * The browser never receives SOLANA_RPC_URL. The connected wallet is the fee
 * payer: it signs this transaction and submits it.
 */
export default async function prepare(request) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const rpcUrl = solanaRpcUrl();
  if (!rpcUrl) return json({ error: "SOLANA_RPC_URL is not set on the server." }, 500);

  const body = await readJson(request);
  const payer = body?.payer;
  const reference = body?.reference;
  if (!isAddress(payer) || !isAddress(reference)) {
    return json({ error: "Send payer and reference." }, 400);
  }
  if (body?.asset != null && body.asset !== "usdc") {
    return json({ error: "Only USDC is accepted.", reason: "invalid" }, 400);
  }

  const payTo = payToAddress();
  if (!isAddress(payTo)) return json({ error: "Payment address is not configured." }, 500);

  const connection = new Connection(rpcUrl, "confirmed");
  const payerKey = new PublicKey(payer);
  const payToKey = new PublicKey(payTo);
  const mint = new PublicKey(USDC_MINT);
  const source = getAssociatedTokenAddressSync(mint, payerKey, true);
  const destination = getAssociatedTokenAddressSync(mint, payToKey, true);

  let solLamports;
  let sourceInfo;
  let destInfo;
  let rentLamports;
  let blockhash;
  try {
    [solLamports, sourceInfo, destInfo, rentLamports, { blockhash }] = await Promise.all([
      connection.getBalance(payerKey, "confirmed"),
      connection.getAccountInfo(source, "confirmed"),
      connection.getAccountInfo(destination, "confirmed"),
      connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "confirmed"),
      connection.getLatestBlockhash("confirmed"),
    ]);
  } catch {
    return json({ error: "The Solana network is unreachable from the server." }, 503);
  }

  const destinationExists = Boolean(destInfo);
  if (!destinationExists && !(Number(rentLamports) > 0)) {
    return json({ error: "The Solana network is unreachable from the server." }, 503);
  }

  const funds = assessFunds({
    solLamports,
    usdcBaseUnits: readTokenAmount(sourceInfo?.data, mint.toBytes()),
    destinationExists,
    rentLamports,
  });
  if (!funds.ok) {
    return json({ error: PAY_ERRORS[funds.reason], reason: funds.reason }, 402);
  }

  const transaction = buildUnsignedTransaction({
    payer,
    payTo,
    reference,
    blockhash,
  });

  return json({
    transaction,
    payTo,
    asset: "usdc",
    usdcMint: USDC_MINT,
    amount: "1.00",
  });
}
