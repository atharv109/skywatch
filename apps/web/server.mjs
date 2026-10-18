/**
 * Zero-dependency dev server for the Skywatch demo harness (apps/web).
 *
 * Why this and not `npx serve` alone: apps/api is Hono on its own port and sends
 * NO CORS headers, so a static page on a different origin cannot call it. This
 * server pages from its own directory AND proxies the API route prefixes to the
 * backend, so the browser talks same-origin and ?api= stays empty.
 *
 *   node server.mjs                          # static :8080, API http://localhost:3000
 *   SKYWATCH_API_URL=https://x.onrender.com PORT=9999 node server.mjs
 *
 * `npx serve apps/web -l 4444` also works for same-origin setups; with a true
 * cross-origin API base you would need CORS headers on the API (not touched here).
 */
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const API_URL = new URL(process.env.SKYWATCH_API_URL || "http://localhost:3000");
const PORT = Number(process.env.PORT || 8080);

/** API route prefixes proxied to the backend (mirrors apps/api/src/routes/index.ts + /health). */
const API_PREFIXES = ["/map", "/mesh", "/scenario", "/webhooks", "/tools", "/verify", "/roads", "/health", "/demo"];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".geojson": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function proxy(req, res, body) {
  const target = new URL(req.url, API_URL);
  const headers = { ...req.headers, host: API_URL.host };
  const up = request(
    target,
    { method: req.method, headers },
    (ures) => {
      res.writeHead(ures.statusCode || 502, ures.headers);
      ures.pipe(res); // streams SSE (/map/stream) as well
    },
  );
  up.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `proxy to ${API_URL.origin} failed: ${err.message}` }));
  });
  if (body && body.length) up.write(body);
  up.end();
}

function staticFile(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/" || path === "") path = "/index.html";
  const file = resolve(join(ROOT, "." + path));
  if (!file.startsWith(ROOT) || file === join(ROOT, "server.mjs")) {
    res.writeHead(404).end("not found");
    return;
  }
  readFile(file)
    .then((data) => {
      res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "text/plain; charset=utf-8" });
      res.end(data);
    })
    .catch(() => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
}

createServer((req, res) => {
  const isApi = API_PREFIXES.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?"));
  if (isApi) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => proxy(req, res, Buffer.concat(chunks)));
  } else {
    staticFile(req, res);
  }
}).listen(PORT, () => {
  console.log(`skywatch web harness: http://localhost:${PORT}  (API proxy target: ${API_URL.origin})`);
});