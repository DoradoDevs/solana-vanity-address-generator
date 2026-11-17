/** User-facing payment errors. Every one tells the payer they need a little SOL for the fee. */
export const NETWORK_FEE_NOTE = "You need a little SOL for the network fee.";

export const PAY_ERRORS = {
  no_wallet: `No Solana wallet is installed. Install Phantom, Solflare, or Backpack. ${NETWORK_FEE_NOTE}`,
  rejected: `The signature was rejected, so nothing was sent. ${NETWORK_FEE_NOTE}`,
  insufficient_usdc: `This wallet does not have 1.00 USDC. ${NETWORK_FEE_NOTE}`,
  insufficient_sol: `This wallet does not have enough SOL to submit the transfer. ${NETWORK_FEE_NOTE}`,
  not_sent: `The wallet could not send the payment (the transfer failed its check before sending, or it expired while waiting for approval), so nothing was charged. Try again. ${NETWORK_FEE_NOTE}`,
  payee: `This wallet is the address that receives VanityGrinder payments, so it cannot pay itself. Connect another wallet. ${NETWORK_FEE_NOTE}`,
};

function errorText(error) {
  if (error == null) return "";
  if (typeof error === "string") return error.toLowerCase();
  const parts = [];
  const seen = new Set();
  const push = (value) => {
    if (value == null) return;
    const text = typeof value === "string" ? value : String(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };
  const walk = (value, depth) => {
    if (!value || depth > 3) return;
    if (typeof value === "string") {
      push(value);
      return;
    }
    push(value.message);
    push(value.name);
    push(value.code);
    if (Array.isArray(value.logs)) push(value.logs.join("\n"));
    walk(value.error, depth + 1);
    walk(value.cause, depth + 1);
    walk(value.data, depth + 1);
  };
  walk(error, 0);
  return parts.join("\n").toLowerCase();
}

function isRejection(error, text) {
  if (text.includes("simulation") || text.includes("insufficient")) return false;
  const code = error?.code ?? error?.error?.code;
  if (code === 4001 || code === "4001") return true;
  return (
    text.includes("user rejected") ||
    text.includes("rejected the request") ||
    text.includes("user declined") ||
    text.includes("user denied") ||
    text.includes("user cancelled") ||
    text.includes("user canceled") ||
    text.includes("connection cancelled") ||
    text.includes("connection canceled") ||
    text.includes("connection rejected") ||
    text.includes("request cancelled") ||
    text.includes("request canceled") ||
    text.includes("transaction cancelled") ||
    text.includes("transaction canceled") ||
    text.includes("transaction rejected") ||
    text.includes("approval denied") ||
    text.includes("signature request declined")
  );
}

function isInsufficientSol(text) {
  return (
    text.includes("insufficient funds for fee") ||
    text.includes("insufficient funds for rent") ||
    text.includes("insufficient lamports") ||
    text.includes("insufficient sol") ||
    text.includes("not enough sol") ||
    text.includes("no record of a prior credit")
  );
}

function isInsufficientUsdc(text) {
  if (text.includes("error: insufficient funds")) return true;
  if (text.includes("custom program error: 0x1")) return true;
  if (text.includes("insufficient funds") && !text.includes("fee") && !text.includes("rent")) {
    return true;
  }
  return false;
}

/**
 * The RPC node refused the transaction before forwarding it: its preflight
 * simulation failed, for example because the blockhash expired while the
 * approval was open. A transaction refused at preflight is never broadcast.
 * A confirmation that timed out is not this: that transaction was sent.
 */
function isNotSent(text) {
  return text.includes("blockhash not found") || text.includes("simulation failed");
}

/**
 * Map a wallet connect/sign failure onto one of the known payment errors:
 * each one means the wallet sent nothing. null means it is unknown whether
 * the transfer went out, and the payment must be looked for before another.
 */
export function classifyWalletError(error) {
  const text = errorText(error);
  if (isRejection(error, text)) return "rejected";
  if (isInsufficientSol(text)) return "insufficient_sol";
  if (isInsufficientUsdc(text)) return "insufficient_usdc";
  if (isNotSent(text)) return "not_sent";
  return null;
}

export function messageForWalletError(error) {
  const kind = classifyWalletError(error);
  if (kind && PAY_ERRORS[kind]) return PAY_ERRORS[kind];
  return `The wallet did not send the payment. ${NETWORK_FEE_NOTE}`;
}
