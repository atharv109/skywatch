/**
 * Offline turn-by-turn pins (hermetic). nav.js exposes its pure logic on globalThis.SkyNav when loaded
 * without a DOM; snapToPolyline is cut out of app.js (source-extraction, like offline-directions.test.ts)
 * and injected, exactly as the app does.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../nav.js";

const WEB = join(import.meta.dirname, "..");
const appSrc = readFileSync(join(WEB, "app.js"), "utf8");
const navSrc = readFileSync(join(WEB, "nav.js"), "utf8");
const N = (globalThis as any).SkyNav;

const snapToPolyline: (pt: any, coords: any) => any = new Function(
  appSrc.slice(appSrc.indexOf("function snapToPolyline("), appSrc.indexOf("/** defensive collector")) + "\nreturn snapToPolyline;",
)();

// real prepared-pack route in WIRE shape (coords [lat,lon], steps[].instruction, to{})
const pack = JSON.parse(readFileSync(join(WEB, "..", "api", "fixtures", "demo-routes.json"), "utf8"));
const wire = pack.routes.find((r: any) => r.to.shelterId === "seed-shelter-3" && r.from.lat === 47.605);
const withTo = { ...wire, to: { ...wire.to, status: "unknown", confidence: 0.2, verified: false } };

describe("maneuver -> icon", () => {
  it.each([
    ["turn", "left", "left"], ["turn", "right", "right"], ["turn", "slight left", "slight-left"], ["turn", "slight right", "slight-right"],
    ["turn", "sharp left", "sharp-left"], ["turn", "sharp right", "sharp-right"], ["turn", "uturn", "uturn"], ["turn", "straight", "straight"],
    ["depart", "", "straight"], ["arrive", "left", "arrive"], ["roundabout", "right", "roundabout"], ["rotary", "", "roundabout"],
    ["end of road", "left", "left"], ["fork", "left", "slight-left"], ["on ramp", "right", "slight-right"], ["new name", "", "straight"], ["merge", "slight left", "slight-left"],
  ])("%s %s -> %s", (t, m, icon) => expect(N.maneuverIcon(t, m)).toBe(icon));
  it("every icon key has an SVG", () => {
    for (const k of ["left", "right", "slight-left", "slight-right", "sharp-left", "sharp-right", "uturn", "straight", "roundabout", "arrive"]) {
      expect(N.iconSvg(k, 24)).toContain("<path");
    }
  });
  it("parses the wire instruction strings the API emits", () => {
    expect(N.parseInstruction("turn left on Alaskan Way", "Alaskan Way")).toEqual({ type: "turn", modifier: "left" });
    expect(N.parseInstruction("depart left", "")).toEqual({ type: "depart", modifier: "left" });
    expect(N.parseInstruction("end of road sharp right on 5th Ave", "5th Ave")).toEqual({ type: "end of road", modifier: "sharp right" });
    expect(N.parseInstruction("arrive", "")).toEqual({ type: "arrive", modifier: "" });
    expect(N.parseInstruction("turn straight on 4th Avenue South", "4th Avenue South")).toEqual({ type: "turn", modifier: "straight" });
  });
});

describe("route normalisation", () => {
  const r = N.normalizeRoute(withTo);
  it("wire -> [lon,lat] geometry + human steps with monotonic boundaries ending at the polyline length", () => {
    expect(r.coords[0][0]).toBeCloseTo(wire.coords[0][1], 6);
    expect(r.geometry.coordinates).toBe(r.coords);
    expect(r.steps[0].type).toBe("depart");
    expect(r.steps[r.steps.length - 1].type).toBe("arrive");
    expect(r.steps[r.steps.length - 1].b).toBeCloseTo(r.totalM, 3);
    r.steps.forEach((s: any, i: number) => { if (i) expect(s.b).toBeGreaterThanOrEqual(r.steps[i - 1].b); });
    expect(r.steps.some((s: any) => /^Turn (left|right)/.test(s.text))).toBe(true);
    expect(r.verified).toBe(false);
  });
  it("is memoised per input object and accepts the client geometry shape", () => {
    expect(N.normalizeRoute(withTo)).toBe(r);
    const g = N.normalizeRoute({ geometry: { type: "LineString", coordinates: [[-122.33, 47.6], [-122.33, 47.602]] }, dest: { lat: 47.602, lon: -122.33 }, steps: [{ text: "x", distanceM: 220 }] });
    expect(g.totalM).toBeGreaterThan(200);
    expect(g.steps[g.steps.length - 1].type).toBe("arrive");
  });
  it("a truncated step list gets a synthetic 'continue' before arrive", () => {
    const t = N.normalizeRoute({ coords: [[47.6, -122.33], [47.61, -122.33]], to: { lat: 47.61, lon: -122.33, name: "Hall" }, steps: [{ distanceM: 200, name: "A", instruction: "depart" }] });
    expect(t.steps.map((s: any) => s.type)).toEqual(["depart", "synthetic", "arrive"]);
    expect(t.steps[1].text).toBe("Continue to Hall");
  });
});

describe("distance + ETA formatting", () => {
  it("imperial: feet then miles", () => {
    expect(N.fmtNavDist(91, "imperial")).toBe("300 ft");
    expect(N.fmtNavDist(20, "imperial")).toBe("70 ft");
    expect(N.fmtNavDist(644, "imperial")).toBe("0.4 mi");
    expect(N.fmtNavDist(17000, "imperial")).toBe("11 mi");
    expect(N.fmtNavDist(91, "imperial", true)).toBe("300 feet");
    expect(N.fmtNavDist(644, "imperial", true)).toBe("0.4 miles");
  });
  it("metric: meters then km", () => {
    expect(N.fmtNavDist(84, "metric")).toBe("80 m");
    expect(N.fmtNavDist(310, "metric")).toBe("300 m");
    expect(N.fmtNavDist(1234, "metric")).toBe("1.2 km");
    expect(N.fmtNavDist(300, "metric", true)).toBe("300 meters");
  });
  it("locale default: imperial for en-US, metric elsewhere", () => {
    expect(N.defaultUnits("en-US")).toBe("imperial");
    expect(N.defaultUnits("en")).toBe("imperial");
    expect(N.defaultUnits("en-GB")).toBe("metric");
    expect(N.defaultUnits("fr-FR")).toBe("metric");
    expect(N.defaultUnits("es-US")).toBe("imperial");
  });
  it("ETA scales the carried duration by distance remaining; falls back to walk/drive pace", () => {
    const rt = { durationMin: 20, totalM: 2000, profile: "foot", straight: false };
    expect(N.etaMath(1000, rt, 0).sec).toBeCloseTo(600, 5);
    expect(N.etaMath(1000, rt, 1_000).arriveAt).toBe(1_000 + 600_000);
    expect(N.etaMath(1400, { profile: "foot" }, 0).sec).toBeCloseTo(1000, 5);
    expect(N.etaMath(1100, { profile: "driving" }, 0).sec).toBeCloseTo(100, 5);
    expect(N.etaMath(-5, rt, 0).sec).toBe(0);
    expect(N.fmtDuration(30)).toBe("1 min");
    expect(N.fmtDuration(3900)).toBe("1 h 5 min");
  });
});

/** north 300 m, east ~250 m, north 300 m; 4 OSRM-style steps */
const road = N.normalizeRoute({
  coords: [[47.6, -122.33], [47.6027, -122.33], [47.6027, -122.3266], [47.6054, -122.3266]],
  to: { lat: 47.6054, lon: -122.3266, name: "Yesler Hall", verified: true },
  profile: "foot", distanceKm: 0.85, durationMin: 10,
  steps: [
    { distanceM: 300, name: "1st Ave", instruction: "depart on 1st Ave" },
    { distanceM: 250, name: "Yesler Way", instruction: "turn right on Yesler Way" },
    { distanceM: 300, name: "2nd Ave", instruction: "turn left on 2nd Ave" },
    { distanceM: 0, name: "", instruction: "arrive" },
  ],
});
const at = (along: number, off = 0) => N.simFix(road, along, off);
const engine = () => N.createEngine(road, { snap: snapToPolyline });

describe("progress engine", () => {
  it("auto-advances steps by distance along the route", () => {
    const e = engine();
    let v = e.update(at(10), [], "imperial");
    expect(v.curIdx).toBe(0);
    expect(v.nextIdx).toBe(1);
    expect(v.distToNext).toBeGreaterThan(250);
    v = e.update(at(road.steps[1].b + 20), [], "imperial");
    expect(v.curIdx).toBe(1);
    expect(v.nextIdx).toBe(2);
    v = e.update(at(road.steps[2].b + 20), [], "imperial");
    expect(v.nextIdx).toBe(3);
    expect(road.steps[v.nextIdx].type).toBe("arrive");
  });
  it("progress never goes backwards on GPS jitter", () => {
    const e = engine();
    e.update(at(200), [], "imperial");
    const v = e.update(at(180), [], "imperial");
    expect(v.progress).toBeGreaterThanOrEqual(199);
  });
  it("off-route needs >50 m for 3 consecutive fixes, then offers a rejoin bearing; back on route clears it", () => {
    const e = engine();
    e.update(at(100), [], "imperial");
    expect(e.update(at(110, 80), [], "imperial").offRoute).toBe(false);
    expect(e.update(at(120, 80), [], "imperial").offRoute).toBe(false);
    const v = e.update(at(130, 80), [], "imperial");
    expect(v.offRoute).toBe(true);
    expect(v.rejoin.distM).toBeGreaterThan(70);
    expect(v.announce.join(" ")).toMatch(/off route.*no signal to re-route/i);
    const back = e.update(at(140, 0), [], "imperial");
    expect(back.offRoute).toBe(false);
    expect(back.announce.join(" ")).toMatch(/back on route/i);
  });
  it("a single good fix resets the off-route counter", () => {
    const e = engine();
    e.update(at(100), [], "imperial");
    e.update(at(110, 90), [], "imperial");
    e.update(at(120, 90), [], "imperial");
    expect(e.update(at(130, 0), [], "imperial").offRoute).toBe(false);
    expect(e.update(at(140, 90), [], "imperial").offRoute).toBe(false);
  });
  it("starting away from the route is 'joining', not an alarm", () => {
    const e = engine();
    const v = e.update({ lat: 47.6, lon: -122.3335 }, [], "imperial"); // ~250 m west of the start
    expect(v.joining).toBe(true);
    expect(v.offRoute).toBe(false);
    expect(v.rejoin.bearing).toBeGreaterThan(60);
    expect(v.rejoin.bearing).toBeLessThan(120);
  });
  it("arrives within 30 m of the end", () => {
    const e = engine();
    e.update(at(50), [], "imperial");
    expect(e.update(at(road.totalM - 60), [], "imperial").arrived).toBe(false);
    const v = e.update(at(road.totalM - 20), [], "imperial");
    expect(v.arrived).toBe(true);
    expect(v.announce.join(" ")).toMatch(/arrived at Yesler Hall/);
  });
  it("announces 'In N feet, ...' once per threshold and the bare instruction at the last one", () => {
    const e = engine();
    const said: string[] = [];
    for (let a = 5; a < 330; a += 5) said.push(...e.update(at(a), [], "imperial").announce);
    expect(said[0]).toMatch(/^Starting navigation\. Head north on 1st Ave/);
    const turn = said.filter((s) => /urn right onto Yesler Way/.test(s));
    expect(turn).toHaveLength(2);
    expect(turn[0]).toMatch(/^In \d+ (feet|miles?), turn right onto Yesler Way\.$/);
    expect(turn[1]).toBe("Turn right onto Yesler Way.");
  });
  it("hazard within 150 m ahead on the route: announced once; not when far ahead or behind us", () => {
    const e = engine();
    const bridge = { lat: 47.6027, lon: -122.33, kind: "bridge_out", label: "bridge", ts: Date.now() - 12 * 60000, confidence: 0.87 }; // 300 m along
    expect(e.update(at(100), [bridge], "imperial").hazard).toBeNull();
    const near = e.update(at(200), [bridge], "imperial");
    expect(near.hazard).toMatchObject({ kind: "bridge_out", confidence: 0.87 });
    expect(near.hazard.aheadM).toBeGreaterThan(80);
    expect(near.hazard.aheadM).toBeLessThanOrEqual(150);
    expect(near.announce.join(" ")).toMatch(/Bridge out reported ahead/);
    expect(e.update(at(210), [bridge], "imperial").announce.join(" ")).not.toMatch(/Bridge out/);
    expect(e.update(at(340), [bridge], "imperial").hazard).toBeNull();
    expect(N.relTime(Date.now() - 12 * 60000)).toBe("12m ago");
  });
  it("straight-line mode: direct distance, never off-route, arrival under 30 m", () => {
    const sr = N.straightRoute({ lat: 47.6, lon: -122.33 }, { lat: 47.603, lon: -122.33 }, "Hall");
    const e = N.createEngine(sr, { snap: snapToPolyline });
    const v = e.update({ lat: 47.6005, lon: -122.3345 }, [], "imperial");
    expect(v.straight).toBe(true);
    expect(v.offRoute).toBe(false);
    expect(v.remainingM).toBeGreaterThan(250);
    expect(e.update({ lat: 47.60295, lon: -122.33 }, [], "imperial").arrived).toBe(true);
  });
});

describe("simulation stepping", () => {
  it("advances at pace x multiplier, clamps at the end, and every fake fix lies on the polyline", () => {
    expect(N.routePace(road)).toBeCloseTo(road.totalM / 600, 5);
    let along = 0;
    const mps = N.routePace(road) * 3;
    const e = engine();
    let last = 0, arrived = false, guard = 0;
    while (!arrived && guard++ < 1000) {
      along = N.simStep(road, along, 1, mps);
      expect(along).toBeGreaterThanOrEqual(last);
      last = along;
      const f = N.simFix(road, along, 0);
      expect(snapToPolyline(f, road.coords).m).toBeLessThan(1);
      arrived = e.update(f, [], "imperial").arrived;
    }
    expect(arrived).toBe(true);
    expect(guard).toBeLessThan(200);
    expect(N.simStep(road, road.totalM - 1, 10, 5)).toBe(road.totalM);
  });
  it("the same engine walks the steps in order while simulated", () => {
    const e = engine();
    const seen: number[] = [];
    for (let a = 0; a <= road.totalM; a += 12) {
      const v = e.update(N.simFix(road, a, 0), [], "imperial");
      if (seen[seen.length - 1] !== v.nextIdx) seen.push(v.nextIdx);
    }
    expect(seen).toEqual([1, 2, 3]);
  });
  it("wrong-turn offset displaces the fix sideways by the requested distance", () => {
    const f = N.simFix(road, 100, 100);
    const m = snapToPolyline(f, road.coords).m;
    expect(m).toBeGreaterThan(95);
    expect(m).toBeLessThan(105);
  });
});

describe("offline guarantees", () => {
  it("nav.js has no network or external-maps calls", () => {
    expect(navSrc).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts/);
    expect(navSrc).not.toMatch(/https?:\/\//);
    expect(navSrc).not.toMatch(/google\.com\/maps|maps\.apple|geo:/);
  });
  it("service worker precaches nav.js and app.html loads it before app.js", () => {
    expect(readFileSync(join(WEB, "sw.js"), "utf8")).toMatch(/"nav\.js"/);
    const html = readFileSync(join(WEB, "app.html"), "utf8");
    expect(html.indexOf("nav.js")).toBeGreaterThan(0);
    expect(html.indexOf("nav.js")).toBeLessThan(html.indexOf('src="app.js"'));
  });
  it("the pin sheet offers Start for routed and straight-line pins, and badges unverified shelters", () => {
    expect(appSrc).toContain('id="navStart"');
    expect(appSrc).toContain("Shelter not verified");
    expect(appSrc).toContain("straight-line guide)");
  });
});
