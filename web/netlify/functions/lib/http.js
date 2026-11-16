import { RpcError } from "./rpc.js";

const MAX_BODY_BYTES = 4_096;

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

export function postOnly() {
  return json({ error: "POST only." }, 405, { allow: "POST" });
}

/**
 * The JSON object in a request body, or null.
 *
 * Only `application/json` is read. A cross-site page can make a visitor's
 * browser POST text or a form here without asking, but it cannot send JSON
 * without a preflight, and these functions answer no preflight. So another
 * site cannot spend our RPC quota through its visitors.
 */
export async function readJson(request) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return null;
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** A log-safe label for a failure. Only RpcError messages are known to be free of the RPC URL. */
export function describeFailure(error) {
  if (error instanceof RpcError) return error.message;
  return error?.name || "error";
}
