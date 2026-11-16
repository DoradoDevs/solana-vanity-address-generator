import { payToAddress, USDC_MINT } from "./lib/constants.js";
import { json } from "./lib/http.js";

export const config = { path: "/api/quote" };

/** The fixed price and where it goes. No RPC call and nothing secret. */
export default async function quote() {
  const payTo = payToAddress();
  if (!payTo) return json({ error: "Payment address is not configured." }, 503);

  return json({
    payTo,
    label: "VanityGrinder",
    message: "One vanity grind ($1 in USDC)",
    usdc: {
      mint: USDC_MINT,
      amount: "1.00",
      baseUnits: "1000000",
    },
  });
}
