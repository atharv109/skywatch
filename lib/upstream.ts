export function apiOrigin() {
  return (process.env.SKYWATCH_API || "https://skywatch-9kvd.onrender.com").replace(/\/$/, "");
}

/** The tool endpoints (briefs, check-ins, verify) take the shared secret server-side — it never reaches the browser. */
export function toolHeaders(): Record<string, string> {
  const secret = process.env.SKYWATCH_TOOL_SECRET;
  return secret ? { "x-skywatch-tool-secret": secret, authorization: `Bearer ${secret}` } : {};
}

export async function postUpstream(path: string, body: unknown) {
  const response = await fetch(`${apiOrigin()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await response.text();
  return { status: response.status, text };
}

/** POST with the shared-secret headers injected (the browser client never carries the secret). */
export async function postToolUpstream(path: string, body: unknown) {
  const response = await fetch(`${apiOrigin()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...toolHeaders() },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await response.text();
  return { status: response.status, text };
}

/** GET with the shared-secret headers injected (the browser client never carries the secret). */
export async function getToolUpstream(path: string) {
  const response = await fetch(`${apiOrigin()}${path}`, {
    headers: toolHeaders(),
    cache: "no-store",
  });
  const text = await response.text();
  return { status: response.status, text };
}

export async function getUpstream(path: string) {
  const response = await fetch(`${apiOrigin()}${path}`, { cache: "no-store" });
  const text = await response.text();
  return { status: response.status, text };
}