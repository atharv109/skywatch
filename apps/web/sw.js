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
const CACHE_VERSION = "sw-v14";

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
  /* NOT "b/index.html": at deploy the API's GET /b/:id route (apps/api/src/routes/index.ts)
   * shadows that path — /b/index.html parses as id "index.html", fails the hex check and
   * 404s before the static layer runs. cache.addAll is all-or-nothing, so that one miss
   * rejected the whole install and the SW was discarded entirely (no offline anything on
   * the live site; dev server.mjs serves the file, so only production broke). */
  "app.css",
  "app.js",
  "nav.js",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-512.png",
  "icons/icon-32.png",
  "brand/logo.png",
  /* on-device damage vision (small: the ~86 MB model weights are NOT here — see VISION_CACHE) */
  "vision.js",
  "vision-core.js",
  "vision-worker.js",
  "vision-labels.json",
  ...TILES,
];

/* On-device vision runtime cache. The pinned transformers.js + onnxruntime-web files come from
 * jsdelivr and are cached on first use (never at install: the SW install must not block on them).
 * The ~86 MB model weights are kept by transformers.js itself in the Cache API ("transformers-cache");
 * both caches are unversioned and must SURVIVE CACHE_VERSION bumps (see activate). */
const VISION_CACHE = "sw-vision-v1";
const KEEP_CACHES = [CACHE_VERSION, VISION_CACHE, "transformers-cache"];
const VISION_CDN_RE = /^\/npm\/(@huggingface\/transformers|onnxruntime-web)@/;

/** API prefixes — identical to the harness proxy in apps/web/server.mjs. Never cached. */
const API_PREFIXES = [
  "/map", "/mesh", "/scenario", "/webhooks", "/tools", "/verify", "/roads", "/health", "/demo", /* demo round-trip: /demo/signup · /demo/area-brief */
];

/* app shell — everything in PRECACHE that is not a tile. */
const SHELL = PRECACHE.filter((p) => !p.startsWith("tiles/"));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // Shell is all-or-nothing: a broken shell means a broken app, so failing
      // install loudly there is correct. Tiles, though, are cached individually:
      // one bad tile URL must never again reject the entire install and silently
      // discard the SW (app.js already degrades a missing tile to the dot-grid).
      await cache.addAll(SHELL);
      await Promise.all(
        TILES.map((t) => cache.add(t).catch((err) => console.warn("sw: tile precache skipped", t, err))),
      );
      await self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // navigation POSTs / API writes / webhooks always pass through

  const url = new URL(req.url);
  if (url.origin === "https://cdn.jsdelivr.net" && VISION_CDN_RE.test(url.pathname)) {
    // pinned vision libs: cache-first, filled lazily the first time the photo flow loads them
    event.respondWith(
      caches.open(VISION_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
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