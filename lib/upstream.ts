export function apiOrigin() {
  return (process.env.SKYWATCH_API || "https://skywatch-9kvd.onrender.com").replace(/\/$/, "");
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

export async function getUpstream(path: string) {
  const response = await fetch(`${apiOrigin()}${path}`, { cache: "no-store" });
  const text = await response.text();
  return { status: response.status, text };
}
