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
const CACHE_VERSION = "sw-v5";

/* offline tile pack — the ONLY map tiles the demo may ever load (no network
 * tiles at runtime; the pack ships with the app). Keep in sync with the tileKeys
 * manifest in app.js and the files under tiles/ on disk. */
const TILE_RANGES = [
  { z: 13, x0: 1310, x1: 1314, y0: 2858, y1: 2863 },  // full Seattle bbox (coarse context)
  { z: 14, x0: 2620, x1: 2626, y0: 5716, y1: 5723 },  // downtown through the eastside
  { z: 15, x0: 5249, x1: 5251, y0: 11442, y1: 11444 }, // Capitol Hill / First Hill cluster
];
const TILES = TILE_RANGES.flatMap(({ z, x0, x1, y0, y1 }) => {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`tiles/${z}/${x}/${y}.png`);
  return out;
});

const PRECACHE = [
  "app.html",
  "b.html",
  "b/index.html",
  "app.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-512.png",
  "icons/icon-32.png",
  "brand/logo.png",
  ...TILES,
];

/** API prefixes — identical to the harness proxy in apps/web/server.mjs. Never cached. */
const API_PREFIXES = [
  "/map", "/mesh", "/scenario", "/webhooks", "/tools", "/verify", "/roads", "/health", "/demo", /* demo round-trip: /demo/signup · /demo/area-brief */
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