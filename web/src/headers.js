/**
 * The response headers of the deployed site, defined once.
 *
 * The build writes `dist/_headers` from this file (see vite.config.js), and
 * `vite preview` serves the same rules, so there is no second copy to drift.
 *
 * The page may load code, styles and fonts only from its own origin, and may
 * connect only back to its own origin: the payment functions under /api/.
 * No other host is named. There are no inline scripts or styles, so there
 * are no hashes and no 'unsafe-inline'; the build fails if one appears.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

/**
 * The grind worker's own policy. A worker loaded from a URL is governed by
 * the headers of its script, not by the page's. This one allows nothing: no
 * fetch, no socket, no imported script. Private keys are made in that
 * worker, and the browser itself now refuses to let it open a connection.
 */
export const WORKER_CSP = "default-src 'none'; frame-ancestors 'none'";

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const REVALIDATE = "public, max-age=0, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** What Vite names the bundled grind worker. */
export const WORKER_FILE_PATTERN = /^assets\/grind-worker-[A-Za-z0-9_-]+\.js$/;

/**
 * Header rules for the static files, general to specific. Every rule carries
 * the complete set, so the result is the same whether the host applies all
 * matching rules or only the closest one. The functions under /api/ are not
 * static files and set their own headers (see netlify/functions/lib/http.js).
 * @param {string[]} workerPaths URL paths of the built grind worker, e.g. "/assets/grind-worker-abc.js"
 */
export function headerRules(workerPaths) {
  const page = { ...BASE_HEADERS, "Content-Security-Policy": PRODUCTION_CSP };
  return [
    { path: "/*", headers: { ...page, "Cache-Control": REVALIDATE } },
    { path: "/assets/*", headers: { ...page, "Cache-Control": IMMUTABLE } },
    ...workerPaths.map((path) => ({
      path,
      headers: { ...BASE_HEADERS, "Content-Security-Policy": WORKER_CSP, "Cache-Control": IMMUTABLE },
    })),
  ];
}

/** Netlify `_headers` syntax. */
export function renderNetlifyHeaders(rules) {
  return (
    rules
      .map(({ path, headers }) =>
        [path, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)].join("\n")
      )
      .join("\n\n") + "\n"
  );
}

/** Parse `_headers` text back into rules. Used to check what a build actually wrote. */
export function parseNetlifyHeaders(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), headers: {} });
      continue;
    }
    const colon = line.indexOf(":");
    if (!rules.length || colon === -1) throw new Error(`unreadable _headers line: ${line}`);
    rules.at(-1).headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return rules;
}

function matches(rulePath, pathname) {
  if (rulePath.endsWith("/*")) return pathname.startsWith(rulePath.slice(0, -1));
  return pathname === rulePath;
}

/** The headers a path is served with: every matching rule, the more specific one last. */
export function headersForPath(rules, pathname) {
  const headers = {};
  for (const rule of rules) {
    if (matches(rule.path, pathname)) Object.assign(headers, rule.headers);
  }
  return headers;
}

/** The page-level headers, for servers that take one fixed set. */
export const SECURITY_HEADERS = { ...BASE_HEADERS, "Content-Security-Policy": PRODUCTION_CSP };

const DATA_BLOCK_TYPES = new Set(["application/ld+json", "application/json"]);

/**
 * Everything in an HTML document that the policy above would refuse to run or
 * apply: inline scripts, inline styles, style attributes, inline event
 * handlers and javascript: URLs. Data blocks such as JSON-LD are not code and
 * are left alone. An empty list means the document needs no CSP exception.
 */
export function inlineCodeIn(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attributes, body] = match;
    const typed = attributes.match(/\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const type = (typed?.[1] ?? typed?.[2] ?? typed?.[3] ?? "").trim().toLowerCase();
    if (DATA_BLOCK_TYPES.has(type)) continue;
    if (body.trim()) found.push(`inline <script>: ${body.trim().slice(0, 60)}`);
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    found.push(`inline <style>: ${match[1].trim().slice(0, 60)}`);
  }
  const markup = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const match of markup.matchAll(/<[a-z][^>]*>/gi)) {
    const tag = match[0];
    if (/\sstyle\s*=/i.test(tag)) found.push(`style attribute: ${tag.slice(0, 60)}`);
    if (/\son[a-z]+\s*=/i.test(tag)) found.push(`inline event handler: ${tag.slice(0, 60)}`);
    if (/=\s*["']?\s*javascript:/i.test(tag)) found.push(`javascript: URL: ${tag.slice(0, 60)}`);
  }
  return found;
}
