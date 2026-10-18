/**
 * Skywatch demo service worker — small and boring on purpose.
 *
 * Cache-first for the static app shell (app.css / app.js / icons / manifest):
 * a dead Wi-Fi moment must not blank the installed app. Everything else —
 * especially every API prefix — passes straight through to the network
 * (never cached; the API is live state, and /mesh/* and /map/* must always hit it).
 *
 * Bump CACHE_VERSION when you change the precache list to force a refresh.
 */
const CACHE_VERSION = "sw-v1";
const PRECACHE = [
  "app.html",
  "app.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-512.png",
];

/** API prefixes — identical to the harness proxy in apps/web/server.mjs. Never cached. */
const API_PREFIXES = [
  "/map", "/mesh", "/scenario", "/webhooks", "/tools", "/verify", "/roads", "/health",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // navigation POSTs / API writes / webhooks always pass through

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts etc — network only
  if (API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) return;

  if (PRECACHE.includes(url.pathname.replace(/^\//, ""))) {
    // cache-first with background refresh: serve instantly, revalidate quietly
    const cachedPath = url.pathname.replace(/^\//, "");
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const hit = await cache.match(cachedPath);
        const fresh = fetch(req).then((res) => {
          if (res && res.ok) cache.put(cachedPath, res.clone());
          return res;
        }).catch(() => null);
        return hit || (await fresh) || Response.error();
      }),
    );
  }
  // anything else static (other pages): plain network — no caching layer
});