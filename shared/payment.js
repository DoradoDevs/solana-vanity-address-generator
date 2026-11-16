/**
 * What one grind costs and where the money goes, pinned in code.
 *
 * The page checks every transfer it is asked to sign against these values,
 * and the functions refuse to run if PAY_TO_ADDRESS names any other payee.
 * Changing the payee means changing PAY_TO here and deploying, so the page
 * and the functions always agree. All of this is public.
 */

/** The public address that receives each payment. */
export const PAY_TO = "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp";

/** Mainnet USDC, a classic SPL Token mint with 6 decimals. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** The price of one grind: 1.00 USDC in base units. */
export const PRICE_BASE_UNITS = 1_000_000n;

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
