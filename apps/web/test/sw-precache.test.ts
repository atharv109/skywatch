/**
 * Service-worker precache integrity. Hermetic (filesystem only, no network).
 *
 * Why this exists: sw-v11 listed "b/index.html" in PRECACHE. At deploy the API's
 * GET /b/:id route shadows that path (id "index.html" fails the hex check → 404
 * before the static layer runs), and cache.addAll is all-or-nothing — one miss
 * rejected the entire install, so the SW never activated on the live site and
 * offline maps broke on real phones while desktop dev (server.mjs) kept working.
 * These tests pin the invariants that must hold for a clean install: every
 * precached and map-requested URL must be a real, directly served file, and the
 * sw.js / app.js / on-disk tile sets must never drift apart.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");

type TileRange = { z: number; x0: number; x1: number; y0: number; y1: number };

function expandTiles(ranges: TileRange[]): string[] {
  const out: string[] = [];
  for (const { z, x0, x1, y0, y1 } of ranges) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`tiles/${z}/${x}/${y}.png`);
  }
  return out;
}

function constArrayLiteral(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
  if (!m) throw new Error(`const ${name} not found in sw.js`);
  return m[1];
}

/** string literals in a const array literal ("a", "b", ...) — comments and spreads ignored. */
function stringEntries(literal: string): string[] {
  const uncommented = literal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...uncommented.matchAll(/"([^"]+)"/g)].map((g) => g[1]);
}

const swSrc = readFileSync(join(WEB, "sw.js"), "utf8");
const swTileRanges: TileRange[] = (() => {
  return [...constArrayLiteral(swSrc, "TILE_RANGES").matchAll(/\{([^}]+)\}/g)].map((m) => {
    const kv = Object.fromEntries(
      [...m[1].matchAll(/(\w+):\s*(\d+)/g)].map((e) => [e[1], Number(e[2])]),
    );
    const r = { z: kv.z, x0: kv.x0, x1: kv.x1, y0: kv.y0, y1: kv.y1 };
    if (Object.values(r).some((n) => Number.isNaN(n))) throw new Error("TILE_RANGES range not fully parsed: " + m[1]);
    return r;
  });
})();
const swTiles = expandTiles(swTileRanges);
const swPrecacheLiteral = constArrayLiteral(swSrc, "PRECACHE");
if (!swPrecacheLiteral.includes("...TILES")) throw new Error("PRECACHE no longer spreads TILES — test needs updating");
const swPrecache = [...stringEntries(swPrecacheLiteral), ...swTiles];

/** "z/x/y" tile keys the map actually requests, straight out of app.js. */
const appSrc = readFileSync(join(WEB, "app.js"), "utf8");
const appTileKeys = (() => {
  const m = appSrc.match(/const tileKeys = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error("tileKeys manifest not found in app.js");
  return stringEntries(m[1]).sort();
})();

const tilesOnDisk = (() => {
  const out: string[] = [];
  const tilesRoot = join(WEB, "tiles");
  for (const z of readdirSync(tilesRoot)) {
    for (const x of readdirSync(join(tilesRoot, z))) {
      for (const y of readdirSync(join(tilesRoot, z, x))) out.push(`tiles/${z}/${x}/${y}`);
    }
  }
  return out.sort();
})();

describe("sw.js precache — install must never 404", () => {
  it("every precache entry exists as a file under apps/web", () => {
    const missing = swPrecache.filter((p) => !existsSync(join(WEB, p)));
    expect(missing).toEqual([]);
  });

  it("no precache entry lives under /b/ (API route /b/:id shadows it at deploy)", () => {
    // Regression: "b/index.html" here 404'd at deploy and killed the whole SW install.
    expect(swPrecache.filter((p) => p.startsWith("b/"))).toEqual([]);
  });
});

describe("tile pack — sw.js, app.js and tiles/ on disk stay in sync", () => {
  it("every SW precache tile exists on disk", () => {
    const missing = swTiles.filter((p) => !existsSync(join(WEB, p)));
    expect(missing).toEqual([]);
  });

  it("no tile on disk is missing from the SW precache", () => {
    const precached = new Set(swTiles);
    expect(tilesOnDisk.filter((p) => !precached.has(p))).toEqual([]);
  });

  it("every tile the map requests (app.js tileKeys) is on disk", () => {
    const onDisk = new Set(tilesOnDisk.map((p) => p.replace(/^tiles\//, "").replace(/\.png$/, "")));
    expect(appTileKeys.filter((k) => !onDisk.has(k))).toEqual([]);
  });

  it("SW tile set and app.js tileKeys set are identical", () => {
    expect([...swTiles].map((p) => p.replace(/^tiles\//, "").replace(/\.png$/, "")).sort()).toEqual(appTileKeys);
  });
});
