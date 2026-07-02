import { defineConfig } from "vite";

// Production-grade security headers (applied to preview server and via _headers file for hosting).
// In dev mode, CSP is relaxed because Vite serves worker module imports as separate HTTP requests.
const productionHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",       // No network requests allowed
    "worker-src 'self' blob:",  // Web Workers only from same origin
    "frame-ancestors 'none'",   // Prevent embedding in iframes
    "form-action 'none'",       // No form submissions
    "base-uri 'self'",
  ].join("; "),
};

// Dev mode headers — CSP allows 'self' connections for Vite's module serving and HMR
const devHeaders = {
  ...productionHeaders,
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Vite injects inline scripts for HMR
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws:",            // Vite HMR websocket + module serving
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'self'",
  ].join("; "),
};

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
  },
  server: {
    headers: devHeaders,
  },
  preview: {
    headers: productionHeaders,
  },
});
