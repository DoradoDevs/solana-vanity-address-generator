/**
 * Production CSP. connect-src allows only this site's Netlify Function
 * paths (quote, prepare, verify, consume). Workers stay on worker-src
 * and do not get an RPC host. SOLANA_RPC_URL is never listed here.
 */
export const CONNECT_SRC = [
  "https://vanitygrinder.com/.netlify/functions/",
  "https://*.netlify.app/.netlify/functions/",
  "http://localhost:8888/.netlify/functions/",
  "http://127.0.0.1:8888/.netlify/functions/",
].join(" ");

export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src ${CONNECT_SRC}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy": PRODUCTION_CSP,
};
