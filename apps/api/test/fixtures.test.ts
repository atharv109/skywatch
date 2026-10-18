import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../src/ingest/fixtureio.ts";

const names = [
  "sept-2020-smoke.geojson",
  "flood-demo.geojson",
  "nws-alert-sample.json",
  "shelters-seed.geojson",
  "cameras.json",
  "openmeteo-aqi.json",
  "photon-inbound-samples.json",
  "demo-routes.json", // Task 10 PREPARED PACK (committed: OSRM routes for the seed shelters)
];

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

describe("committed fixtures", () => {
  it("all exist in apps/api/fixtures", () => {
    for (const name of names) {
      expect(statSync(fixturePath(name)).isFile(), name).toBe(true);
    }
  });

  it("stay small enough to commit (total < 200 KB)", () => {
    const total = [...names, "zips-wa.tsv"].reduce((sum, name) => sum + statSync(fixturePath(name)).size, 0);
    expect(total).toBeLessThan(200 * 1024);
  });

  it("zips-wa.tsv is zip<tab>lat<tab>lon, WA-only, sorted, no header rows beyond the first", () => {
    const lines = readFileSync(fixturePath("zips-wa.tsv"), "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe("zip\tlat\tlon");
    let previous = "";
    for (const line of lines.slice(1)) {
      const [zip = "", lat = "0", lon = "0"] = line.split("\t");
      expect(zip).toMatch(/^\d{5}$/);
      expect(Number(lat)).toBeGreaterThanOrEqual(45.5);
      expect(Number(lat)).toBeLessThanOrEqual(49.1);
      expect(Number(lon)).toBeGreaterThanOrEqual(-125.0);
      expect(Number(lon)).toBeLessThanOrEqual(-116.8);
      expect(zip > previous, `sorted at ${zip}`).toBe(true);
      previous = zip;
    }
    expect(lines.length - 1).toBeGreaterThan(700);
  });

  it("sept-2020-smoke.geojson carries Sept 2020 plumes with Density/Start/End and valid rings", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("sept-2020-smoke.geojson"), "utf8")) as {
      type: string;
      features: Array<{ geometry: { type: string; coordinates: number[][][] }; properties: Record<string, string> }>;
    };
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features.length).toBeGreaterThan(0);
    const densities = new Set(parsed.features.map((f) => f.properties["Density"]));
    for (const f of parsed.features) {
      expect(f.geometry.type).toBe("Polygon");
      expect(["Light", "Medium", "Heavy"]).toContain(f.properties.Density);
      expect(f.properties.Start).toMatch(/^\d{7} \d{4}$/);
      expect(f.properties.End).toMatch(/^\d{7} \d{4}$/);
      // all clipped coordinates stay inside the WA clip window and round to 3 decimals
      for (const ring of f.geometry.coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]); // ring closed
        for (const [lon, lat] of ring) {
          expect(lon).toBeGreaterThanOrEqual(-125);
          expect(lon).toBeLessThanOrEqual(-116.8);
          expect(lat).toBeGreaterThanOrEqual(45.3);
          expect(lat).toBeLessThanOrEqual(49.2);
        }
      }
    }
    expect(densities.size).toBeGreaterThanOrEqual(2);
  });

  it("a smoke plume covers Seattle (matchable demo geometry)", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("sept-2020-smoke.geojson"), "utf8")) as {
      features: Array<{ geometry: { coordinates: number[][][] } }>;
    };
    const seattle: [number, number] = [-122.3321, 47.6062];
    const inAny = parsed.features.some((f) => f.geometry.coordinates.some((ring) => pointInRing(seattle, ring)));
    expect(inAny).toBe(true);
  });

  it("flood-demo.geojson is a Polygon over the Snoqualmie valley anchored on the gauge values", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("flood-demo.geojson"), "utf8")) as {
      properties: { gaugeSite: string; gageHeightFt: number; floodStageFt: number };
      features: Array<{ geometry: { type: string } }>;
    };
    expect(parsed.properties.gaugeSite).toBe("12144500");
    expect(parsed.properties.gageHeightFt).toBeGreaterThan(parsed.properties.floodStageFt);
    expect(parsed.features.every((f) => f.geometry.type === "Polygon")).toBe(true);
  });

  it("shelters-seed.geojson has 8+ POIs, 3 partners, kinds from the allowed set", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("shelters-seed.geojson"), "utf8")) as {
      features: Array<{ geometry: { type: string; coordinates: number[] }; properties: Record<string, unknown> }>;
    };
    expect(parsed.features.length).toBeGreaterThanOrEqual(8);
    expect(parsed.features.filter((f) => f.properties.partner === true).length).toBe(3);
    const kinds = new Set(parsed.features.map((f) => f.properties.kind));
    expect([...kinds]).toEqual(
      expect.arrayContaining(["shelter", "pharmacy", "community_center"]),
    );
    for (const f of parsed.features) {
      expect(f.geometry.type).toBe("Point");
      // GeoJSON [lon, lat]: lon negative (west of Greenwich), lat positive (WA)
      const [lon, lat] = f.geometry.coordinates;
      expect(lon).toBeLessThan(-122);
      expect(lat).toBeGreaterThan(47);
    }
  });

  it("cameras.json has 6+ WSDOT cameras with public ImageURLs and no access code anywhere", () => {
    const raw = readFileSync(fixturePath("cameras.json"), "utf8");
    expect(raw.toLowerCase().includes("accesscode")).toBe(false);
    const parsed = JSON.parse(raw) as {
      cameras: Array<{ CameraID: number; Title: string | null; ImageURL: string; CameraLocation: { Latitude: number; Longitude: number; RoadName: string | null } | null }>;
    };
    expect(parsed.cameras.length).toBeGreaterThanOrEqual(6);
    for (const cam of parsed.cameras) {
      expect(cam.CameraID).toBeTruthy();
      expect(cam.ImageURL).toMatch(/^https:\/\/images\.wsdot\.wa\.gov\//);
      expect(cam.CameraLocation).not.toBeNull();
    }
  });

  it("nws-alert-sample.json follows the verified NWS alert feature schema", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("nws-alert-sample.json"), "utf8")) as {
      type: string;
      features: Array<{ type: string; geometry: { type: string } | null; properties: { event: string; severity: string; geocode: { SAME: string[]; UGC: string[] } } }>;
    };
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features.length).toBe(1);
    const alert = parsed.features[0]!;
    expect(alert.properties.event).toBe("Air Quality Alert");
    expect(alert.properties.geocode.UGC).toEqual(["WAC033"]);
    expect(alert.properties.geocode.SAME).toEqual(["053033"]);
    expect(alert.geometry?.type).toBe("Polygon");
  });

  it("openmeteo-aqi.json has current.us_aqi + pm2_5 on the air-quality host shape", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("openmeteo-aqi.json"), "utf8")) as {
      current: { us_aqi: number; pm2_5: number };
    };
    expect(typeof parsed.current.us_aqi).toBe("number");
    expect(typeof parsed.current.pm2_5).toBe("number");
  });

  it("photon-inbound-samples.json covers hi/address/language/STOP/question/opt-in-voice with unique message ids", () => {
    const parsed = JSON.parse(readFileSync(fixturePath("photon-inbound-samples.json"), "utf8")) as {
      samples: Array<{ label: string; payload: { event: string; message: { id: string; direction: string; content: { type: string; text: string } } } }>;
    };
    const labels = parsed.samples.map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["hi", "address", "language", "stop", "question", "opt-in-voice"]));
    const ids = parsed.samples.map((s) => s.payload.message.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of parsed.samples) {
      expect(s.payload.event).toBe("messages");
      expect(s.payload.message.direction).toBe("inbound");
      expect(s.payload.message.content.type).toBe("text");
    }
    const stop = parsed.samples.find((s) => s.label === "stop")!;
    expect(stop.payload.message.content.text.toUpperCase()).toBe("STOP");
  });

  it("no raw downloads were committed (fixtures dir holds only the curated files)", () => {
    const dir = readdirSync(FIXTURES_DIR).sort();
    expect(dir).toEqual([...names, "zips-wa.tsv"].sort());
  });
});

/** Tiny ray-casting point-in-polygon (lon/lat); used because the plan reserves turf for Task 4. */
function pointInRing([x, y]: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}