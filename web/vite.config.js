import { defineConfig } from "vite";
import { CONNECT_SRC, SECURITY_HEADERS } from "./src/headers.js";

// Dev keeps Vite's module graph and HMR websocket working.
// Preview uses the production policy: functions only, no public RPC.
const devHeaders = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${CONNECT_SRC} 'self' ws: http://localhost:5173 http://127.0.0.1:5173`,
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
