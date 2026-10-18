/**
 * Offline directions pins (hermetic, source-extraction pattern like web-client-fixes.test.ts).
 * app.js is a classic-script IIFE, so the pure guidance helpers are cut out by marker and
 * evaluated with stubbed dependencies.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const appSrc = readFileSync(join(WEB, "app.js"), "utf8");

function section(from: string, to: string): string {
  const a = appSrc.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = appSrc.indexOf(to, a);
  if (b < 0) throw new Error(`end marker not found after ${from}: ${to}`);
  return appSrc.slice(a, b);
}

function load(stateOverride: Record<string, unknown> = {}, cache: Record<string, unknown> = {}) {
  const src = section("function bearingDeg(", "/** steps list html");
  const factory = new Function(
    "state", "cached", "haversineKm", "esc",
    src + "\nreturn { bearingDeg, compassWord, snapToPolyline, hazardMarkersAll, routeHazardsNear, navLiveHtml, hazardWarnHtml };",
  );
  const haversineKm = (a: any, b: any) => {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  return factory(stateOverride, (k: string) => cache[k] ?? null, haversineKm, (s: unknown) => String(s));
}

// ~111 m per 0.001 deg lat; straight north-south line at lon -122.33
const line = [[-122.33, 47.6], [-122.33, 47.601], [-122.33, 47.602]];
const route = { geometry: { type: "LineString", coordinates: line } };

describe("no external maps handoff", () => {
  it("app.js never references Google/Apple Maps or geo: intents", () => {
    expect(appSrc).not.toMatch(/google\.com\/maps|maps\.apple\.com|["'`]geo:/);
    expect(appSrc).not.toContain("directionsUrl");
    expect(appSrc).not.toContain("Open in Maps");
  });
  it("the pin sheet renders the on-device live guidance card", () => {
    const sheet = section("function openPinSheet(", "function haversineKm(");
    expect(sheet).toContain("navLiveHtml(");
    expect(sheet).toContain("watchPosition");
  });
  it("closeSheet stops the GPS watch", () => {
    expect(section("function closeSheet()", "wireSheetGrip")).toContain("stopNavWatch()");
  });
});

describe("compass fallback maths", () => {
  const h = load();
  it("bearings are cardinal-correct", () => {
    const o = { lat: 47.6, lon: -122.33 };
    expect(Math.round(h.bearingDeg(o, { lat: 47.61, lon: -122.33 }))).toBe(0);
    expect(Math.round(h.bearingDeg(o, { lat: 47.6, lon: -122.32 }))).toBe(90);
    expect(h.compassWord(225)).toBe("SW");
  });
  it("no route: straight-line guide with live distance", () => {
    const html = h.navLiveHtml({ lat: 47.6, lon: -122.33 }, { name: "Yesler Hall", lat: 47.61, lon: -122.33 }, null);
    expect(html).toContain("straight-line guide");
    expect(html).toMatch(/1\.11 km/);
  });
  it("on the route: snaps and reports remaining distance", () => {
    const html = h.navLiveHtml({ lat: 47.6005, lon: -122.33001 }, { name: "Yesler Hall", lat: 47.602, lon: -122.33 }, route);
    expect(html).toContain("On the cached route");
    expect(html).toMatch(/1[67]\d m to go/);
  });
  it("far from the route: points at the nearest route point", () => {
    const html = h.navLiveHtml({ lat: 47.601, lon: -122.335 }, { name: "Yesler Hall", lat: 47.602, lon: -122.33 }, route);
    expect(html).toContain("off the cached route");
    expect(html).toContain("head E");
  });
});

describe("hazard-on-route flagging", () => {
  it("works with no hazard layer at all", () => {
    const h = load();
    expect(h.hazardMarkersAll()).toEqual([]);
    expect(h.routeHazardsNear(route, [])).toEqual([]);
    expect(h.hazardWarnHtml([])).toBe("");
  });
  it("flags road_blocked / bridge_out within 60 m, ignores far or other kinds", () => {
    const h = load({
      hazardMarkers: [
        { lat: 47.6005, lon: -122.32995, kind: "road_blocked" }, // ~38 m east of the line
        { lat: 47.6015, lon: -122.3292, kind: "bridge_out" }, // ~ 55+ m? far enough to miss
        { lat: 47.601, lon: -122.33, kind: "smoke" },
      ],
    });
    const hits = h.routeHazardsNear(route, h.hazardMarkersAll());
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("road_blocked");
    expect(hits[0].offM).toBeLessThanOrEqual(60);
    expect(h.hazardWarnHtml(hits)).toContain("route flagged");
  });
  it("also reads blocked roads from map state and photo hazard reports", () => {
    const h = load({}, {
      mapState: { data: { roads: [{ lat: 47.601, lon: -122.33, status: "blocked", confidence: 0.9 }, { lat: 47.601, lon: -122.33, status: "flooded", confidence: 0.9 }] } },
      mesh: { data: { hazardReports: [{ lat: 47.6012, lon: -122.33, photoVision: { kind: "bridge_out" } }] } },
    });
    const kinds = h.hazardMarkersAll().map((m: any) => m.kind).sort();
    expect(kinds).toEqual(["bridge_out", "road_blocked"]);
  });
});
