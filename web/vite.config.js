import { defineConfig } from "vite";
import { SECURITY_HEADERS } from "./src/headers.js";

// Dev keeps Vite's module graph and HMR websocket working.
// Preview and production stay on connect-src 'none'.
const devHeaders = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws:",
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
    sourcemap: false,
    modulePreload: false,
  },
  worker: {
    format: "iife",
  },
  server: {
    headers: devHeaders,
  },
  preview: {
    headers: SECURITY_HEADERS,
  },
});
