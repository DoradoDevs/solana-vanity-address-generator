import { payToAddress, TOLERANCE_BPS, USDC_MINT } from "./lib/constants.js";
import { json } from "./lib/http.js";
import { fetchSolPriceUsd, formatSolAmount, lamportsForOneUsd } from "./lib/price.js";
import { isAddress } from "./lib/tx.js";

export default async function quote() {
  const payTo = payToAddress();
  if (!isAddress(payTo)) return json({ error: "Payment address is not configured." }, 500);

  let sol = null;
  try {
    const priceUsd = await fetchSolPriceUsd();
    const lamports = lamportsForOneUsd(priceUsd);
    sol = {
      lamports: String(lamports),
      amount: formatSolAmount(lamports),
      priceUsd,
    };
  } catch {
    sol = null;
  }

  return json({
    payTo,
    label: "VanityGrinder",
    message: "One vanity grind ($1)",
    toleranceBps: TOLERANCE_BPS,
    usdc: {
      mint: USDC_MINT,
      amount: "1",
      baseUnits: "1000000",
    },
    sol,
  });
}
