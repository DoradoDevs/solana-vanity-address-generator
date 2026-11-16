import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PAY_ERRORS } from "../../../shared/pay-copy.js";
import { isAddress } from "./lib/address.js";
import { referenceForClaim } from "./lib/claim.js";
import { payToAddress, solanaRpcUrl, USDC_MINT } from "./lib/constants.js";
import { assessFunds, readTokenAmount } from "./lib/funds.js";
import { describeFailure, json, postOnly, readJson } from "./lib/http.js";
import { createRpc } from "./lib/rpc.js";
import { buildUnsignedTransaction } from "./lib/tx.js";

// Each call costs two RPC requests, so the edge limits it per visitor.
// A person pays once per grind.
export const config = {
  path: "/api/prepare",
  rateLimit: { windowLimit: 12, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

const UNAVAILABLE = "The Solana network is unreachable from the server.";

/**
 * Build the unsigned 1.00 USDC transfer on the server.
 * The browser never receives SOLANA_RPC_URL. The connected wallet is the fee
 * payer: it signs this transaction and submits it. The reference account in
 * the transfer is derived here from the caller's claim, so every payment
 * this function builds can only be redeemed by the browser that asked.
 */
export default async function prepare(request) {
  if (request.method !== "POST") return postOnly();
  const rpcUrl = solanaRpcUrl();
  const payTo = payToAddress();
  if (!rpcUrl || !isAddress(payTo)) return json({ error: "Payments are not configured." }, 500);

  const body = await readJson(request);
  const payer = body?.payer;
  const reference = referenceForClaim(body?.claim);
  if (!isAddress(payer) || !reference) {
    return json({ error: "The payment request was not valid. Reload the page, then pay.", reason: "invalid" }, 400);
  }

  const mint = new PublicKey(USDC_MINT);
  const source = getAssociatedTokenAddressSync(mint, new PublicKey(payer), true);
  const destination = getAssociatedTokenAddressSync(mint, new PublicKey(payTo), true);
  const rpc = createRpc(rpcUrl);

  let payerAccount;
  let sourceAccount;
  let destinationAccount;
  let blockhash;
  let rentLamports = 0;
  try {
    [[payerAccount, sourceAccount, destinationAccount], blockhash] = await Promise.all([
      rpc.getMultipleAccounts([payer, source.toBase58(), destination.toBase58()]),
      rpc.getLatestBlockhash(),
    ]);
    // Rent only matters the first time, before the payee's USDC account exists.
    if (!destinationAccount) rentLamports = await rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  } catch (error) {
    console.log(`prepare failure ${describeFailure(error)}`);
    return json({ error: UNAVAILABLE, reason: "unavailable" }, 503);
  }

  const funds = assessFunds({
    solLamports: payerAccount?.lamports ?? 0,
    usdcBaseUnits: readTokenAmount(sourceAccount?.data, mint.toBytes()),
    destinationExists: Boolean(destinationAccount),
    rentLamports,
  });
  if (!funds.ok) {
    return json({ error: PAY_ERRORS[funds.reason], reason: funds.reason }, 402);
  }

  return json({
    transaction: buildUnsignedTransaction({ payer, payTo, reference, blockhash }),
    payTo,
    usdcMint: USDC_MINT,
    amount: "1.00",
  });
}
