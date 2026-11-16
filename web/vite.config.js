import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import {
  PRODUCTION_CSP,
  WORKER_FILE_PATTERN,
  headerRules,
  headersForPath,
  inlineCodeIn,
  parseNetlifyHeaders,
  renderNetlifyHeaders,
} from "./src/headers.js";

/**
 * Writes dist/_headers, the file Netlify reads the response headers from.
 * The grind worker's file name changes with its content, so its rule can only
 * be written once the build knows the name. The build stops if it cannot find
 * exactly one worker, or if any published page contains inline code, because
 * the policy has no exception for either and the live page would silently break.
 */
function netlifyHeaders() {
  return {
    name: "vanitygrinder-netlify-headers",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir;
      const workers = fs
        .readdirSync(path.join(outDir, "assets"))
        .map((file) => `assets/${file}`)
        .filter((file) => WORKER_FILE_PATTERN.test(file));
      if (workers.length !== 1) {
        this.error(`expected exactly one grind worker in ${outDir}/assets, found ${workers.length}`);
      }
      for (const file of fs.readdirSync(outDir).filter((name) => name.endsWith(".html"))) {
        const inline = inlineCodeIn(fs.readFileSync(path.join(outDir, file), "utf8"));
        if (inline.length > 0) {
          this.error(`${file} has inline code that the Content-Security-Policy blocks:\n  ${inline.join("\n  ")}`);
        }
      }
      const rules = headerRules(workers.map((file) => `/${file}`));
      fs.writeFileSync(path.join(outDir, "_headers"), renderNetlifyHeaders(rules));
    },
  };
}

/** `vite preview` serves the built site with the headers the build wrote for Netlify. */
function previewWithBuiltHeaders() {
  return {
    name: "vanitygrinder-preview-headers",
    configurePreviewServer(server) {
      const file = path.join(server.config.build.outDir, "_headers");
      const rules = parseNetlifyHeaders(fs.readFileSync(path.resolve(server.config.root, file), "utf8"));
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        for (const [name, value] of Object.entries(headersForPath(rules, pathname))) res.setHeader(name, value);
        next();
      });
    },
  };
}

// Dev keeps Vite's module graph and HMR websocket working. It is never deployed.
const devHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace("connect-src 'self'", "connect-src 'self' ws:")
    .replace("worker-src 'self'", "worker-src 'self' blob:"),
};

export default defineConfig({
  root: ".",
  plugins: [netlifyHeaders(), previewWithBuiltHeaders()],
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
  // Without this, preview would fall back to the dev headers above.
  preview: {
    headers: {},
  },
});
