/**
 * Pure-logic tests for the on-device damage vision (apps/web/vision-core.js).
 * The model is MOCKED: an "image embedding" is synthesized from the shipped label embeddings,
 * so these pin the mapping / threshold / dedupe / payload contract, not model accuracy
 * (zero-shot accuracy is unvalidated - see the vision report).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain ES module (no types)
import * as V from "../vision-core.js";

const WEB = join(import.meta.dirname, "..");
const labelsJson = JSON.parse(readFileSync(join(WEB, "vision-labels.json"), "utf8")) as { embeddings: Record<string, number[]>; dim: number };

/** mock model: embedding pointing at one label, plus a bit of another */
function mockImageEmb(main: string, other?: string, otherW = 0): number[] {
  const m = labelsJson.embeddings[main];
  const o = other ? labelsJson.embeddings[other] : null;
  return m.map((x, i) => x + (o ? otherW * o[i] : 0));
}
const loc = { lat: 47.6, lon: -122.33 };

describe("label -> kind mapping", () => {
  it("maps hazardous labels to kinds and non-hazard labels to null", () => {
    expect(V.labelToKind("bridge-damaged")).toBe("bridge");
    expect(V.labelToKind("road-flooded")).toBe("flood");
    expect(V.labelToKind("road-blocked")).toBe("blocked");
    expect(V.labelToKind("road-damaged")).toBe("road-damage");
    expect(V.labelToKind("landslide")).toBe("landslide");
    expect(V.labelToKind("power-line-down")).toBe("power-line");
    expect(V.labelToKind("wildfire")).toBe("fire");
    for (const id of ["road-intact", "bridge-intact", "none"]) expect(V.labelToKind(id)).toBeNull();
    expect(V.labelToKind("nope")).toBeNull();
  });
  it("every hazard kind has a server photo-label from the existing enum and the label set covers every kind", () => {
    const serverEnum = ["road-broken", "fire", "safe-place", "flood", "other"];
    for (const k of V.HAZARD_KINDS) expect(serverEnum).toContain(V.serverPhotoLabel(k));
    const kinds = new Set(V.LABELS.map((l: { kind: string | null }) => l.kind).filter(Boolean));
    expect([...kinds].sort()).toEqual([...V.HAZARD_KINDS].sort());
  });
  it("routeKind uses the directions vocabulary (road_blocked | bridge_out | undefined)", () => {
    expect(V.routeKind("bridge")).toBe("bridge_out");
    for (const k of ["flood", "blocked", "road-damage", "landslide"]) expect(V.routeKind(k)).toBe("road_blocked");
    expect(V.routeKind("fire")).toBeUndefined();
    expect(V.routeKind("power-line")).toBeUndefined();
  });
  it("shipped label embeddings cover every label, 512-d, unit length", () => {
    for (const l of V.LABELS) {
      const e = labelsJson.embeddings[l.id];
      expect(e, l.id).toBeTruthy();
      expect(e.length).toBe(labelsJson.dim);
      expect(Math.hypot(...e)).toBeCloseTo(1, 2);
    }
  });
});

describe("rank + confidence threshold (mock model)", () => {
  it("ranks the label the embedding points at first; scores sum to 1", () => {
    const r = V.rankLabels(mockImageEmb("bridge-damaged"), labelsJson.embeddings);
    expect(r[0].id).toBe("bridge-damaged");
    expect(r.reduce((s: number, x: { score: number }) => s + x.score, 0)).toBeCloseTo(1, 6);
  });
  it("reports a confident hazard", () => {
    const r = V.rankLabels(mockImageEmb("road-flooded"), labelsJson.embeddings);
    const d = V.decide(r, loc, 1000);
    expect(d).toMatchObject({ kind: "flood", label: "Flooded road", lat: 47.6, lon: -122.33, ts: 1000 });
    expect(d.confidence).toBeGreaterThanOrEqual(V.CONFIDENCE_THRESHOLD);
  });
  it("returns null when the top label is not a hazard", () => {
    expect(V.decide(V.rankLabels(mockImageEmb("none"), labelsJson.embeddings), loc, 1)).toBeNull();
    expect(V.decide(V.rankLabels(mockImageEmb("bridge-intact"), labelsJson.embeddings), loc, 1)).toBeNull();
  });
  it("returns null below the threshold (ambiguous between two labels)", () => {
    const r = V.rankLabels(mockImageEmb("road-flooded", "road-blocked", 0.97), labelsJson.embeddings);
    expect(r[0].score).toBeLessThan(V.CONFIDENCE_THRESHOLD);
    expect(V.decide(r, loc, 1)).toBeNull();
  });
  it("threshold is a parameter and empty input is safe", () => {
    const ranked = [{ id: "wildfire", kind: "fire", label: "Wildfire or smoke", score: 0.6 }];
    expect(V.decide(ranked, loc, 1)).toBeNull(); // 0.6 < default 0.7
    expect(V.decide(ranked, loc, 1, 0.5)).not.toBeNull();
    expect(V.decide([], loc, 1)).toBeNull();
  });
});

describe("payload shape", () => {
  const r = { kind: "bridge", label: "Bridge damaged", confidence: 0.87, lat: 47.6123, lon: -122.3345, ts: 5 };
  it("carries m.hazard {kind,lat,lon,confidence,label}, a human text, bare photoRef and server label", () => {
    const p = V.buildHazardPayload(r, "ph-abc");
    expect(p.hazard).toEqual({ kind: "bridge", lat: 47.6123, lon: -122.3345, confidence: 0.87, label: "Bridge damaged" });
    expect(p.text).toContain("Bridge damaged (87%)");
    expect(p.photoRef).toBe("ph-abc");
    expect(p.label).toBe("road-broken");
    expect(V.buildHazardPayload(r).photoRef).toBeNull();
  });
  it("confirm sheet text", () => {
    expect(V.confirmText(r)).toBe("Looks like: Bridge damaged 87%");
  });
});

describe("marker dedupe / merge", () => {
  const base = { kind: "bridge", label: "Bridge damaged", confidence: 0.7, lat: 47.6, lon: -122.33, ts: 1_000_000 };
  it("adds a marker with routeKind + source", () => {
    const m = V.mergeMarker([], base);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "bridge", count: 1, routeKind: "bridge_out", source: "on-device" });
  });
  it("merges same kind within 40 m and 30 min: max confidence wins, count increments, no mutation", () => {
    const first = V.mergeMarker([], base);
    const snapshot = JSON.stringify(first);
    const second = V.mergeMarker(first, { ...base, confidence: 0.9, lat: 47.60015, ts: base.ts + 60_000 });
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(second).toHaveLength(1);
    expect(second[0].confidence).toBe(0.9);
    expect(second[0].count).toBe(2);
    expect(second[0].ts).toBe(base.ts + 60_000);
  });
  it("keeps lower-confidence repeat from moving the marker", () => {
    const m = V.mergeMarker(V.mergeMarker([], base), { ...base, confidence: 0.6, lat: 47.60015, ts: base.ts + 1 });
    expect(m[0].lat).toBe(47.6);
    expect(m[0].confidence).toBe(0.7);
  });
  it("does NOT merge across kind, distance (>40 m) or time (>30 min)", () => {
    let m = V.mergeMarker([], base);
    m = V.mergeMarker(m, { ...base, kind: "flood", label: "Flooded road" });
    m = V.mergeMarker(m, { ...base, lat: 47.6005 }); // ~55 m
    m = V.mergeMarker(m, { ...base, ts: base.ts + V.MERGE_WINDOW_MS + 1 });
    expect(m).toHaveLength(4);
  });
  it("sorts newest first and caps the list", () => {
    let m: unknown[] = [];
    for (let i = 0; i < V.MAX_MARKERS + 10; i++) m = V.mergeMarker(m, { ...base, lat: 47.6 + i * 0.01, ts: base.ts + i * 10 });
    expect(m).toHaveLength(V.MAX_MARKERS);
    expect((m as { ts: number }[])[0].ts).toBeGreaterThan((m as { ts: number }[])[1].ts);
  });
});

describe("route proximity (directions contract)", () => {
  const mk = { id: "a", kind: "bridge", lat: 47.6, lon: -122.33 };
  it("haversine sanity: 0.001 deg lat ~ 111 m", () => {
    expect(V.distanceM(47.6, -122.33, 47.601, -122.33)).toBeGreaterThan(110);
    expect(V.distanceM(47.6, -122.33, 47.601, -122.33)).toBeLessThan(112);
  });
  it("flags markers within 60 m of a route and ignores far ones", () => {
    const near = [[47.5995, -122.3301], [47.6004, -122.3299]]; // passes ~6-45 m away
    const far = [[47.61, -122.34], [47.611, -122.34]];
    expect(V.hazardsNearPath([mk], near)).toHaveLength(1);
    expect(V.hazardsNearPath([mk], far)).toHaveLength(0);
    expect(V.hazardsNearPath([mk], [])).toHaveLength(0);
  });
  it("checks segment midpoints so a long segment over the marker is caught", () => {
    expect(V.hazardsNearPath([mk], [[47.5995, -122.33], [47.6005, -122.33]])).toHaveLength(1);
  });
});
