/**
 * One-off converter: NOAA HMS Smoke KML -> GeoJSON fixture.
 *
 * Input: a day file from https://satespsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/<yyyy>/<mm>/hms_smokeYYYYMMDD.kml
 * (verified structure, 2026-10-17): Document -> <Placemark> per plume, each with a
 * description CDATA holding "Start Time: <YYYYDDD> <HHMM>UTC / End Time: ... / Density: <word> /
 * Satellite: ..." and a single <Polygon><outerBoundaryIs> (this file has no MultiGeometry
 * or inner rings). Times use NOAA day-of-year format: `2020255 1100` = day 255 of 2020, 11:00 UTC.
 *
 * The committed fixture (sept-2020-smoke.geojson) only covers the demo region: plumes whose
 * bbox intersects Washington are kept and rings are clipped to a WA border buffer with a
 * Sutherland-Hodgman polygon clip (HMS plumes routinely span the continent — clipping keeps
 * the fixture committable and the map renderable).
 *
 * Usage: npx tsx apps/api/scripts/convert-hms-kml.ts <in.kml> <out.geojson>
 */
import { readFileSync, writeFileSync } from "node:fs";

/** WA bounding region (slightly buffered from the state's actual extent ~[-124.73,45.54]..[-116.92,49.00]). */
const CLIP = { minX: -125.0, minY: 45.3, maxX: -116.8, maxY: 49.2 };

type Ring = [number, number][];

/** Sutherland-Hodgman clip of one ring against an axis-aligned rectangle. */
function clipRing(ring: Ring): Ring {
  // clip against each edge in order (left, right, bottom, top)
  const edges: Array<["x" | "y", number, number]> = [
    ["x", CLIP.minX, 1],
    ["x", CLIP.maxX, -1],
    ["y", CLIP.minY, 1],
    ["y", CLIP.maxY, -1],
  ];
  let out: Ring = ring;
  for (const [axis, bound, sign] of edges) {
    const input = out;
    out = [];
    if (input.length === 0) return [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i]!;
      const prev = input[(i - 1 + input.length) % input.length]!;
      const inside = (pt: Ring[number]) => sign * (pt[axis === "x" ? 0 : 1] as number) >= sign * bound;
      const intersect = (a: Ring[number], b: Ring[number]): Ring[number] => {
        const ax = a[0], ay = a[1], bx = b[0], by = b[1];
        if (axis === "x") return [bound, ay + (by - ay) * ((bound - ax) / (bx - ax))];
        return [ax + (bx - ax) * ((bound - ay) / (by - ay)), bound];
      };
      if (inside(p)) {
        if (!inside(prev)) out.push(intersect(p, prev) as [number, number]);
        out.push(p);
      } else if (inside(prev)) {
        out.push(intersect(p, prev) as [number, number]);
      }
    }
  }
  return out;
}

function ringBbox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function overlaps(box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  return box.minX <= CLIP.maxX && box.maxX >= CLIP.minX && box.minY <= CLIP.maxY && box.maxY >= CLIP.minY;
}

/** NOAA day-of-year time `2020255 1100` -> epoch ms (UTC). */
function parseDoy(yearDoy: string, hhmm: string): number {
  const year = Number(yearDoy.slice(0, 4));
  const doy = Number(yearDoy.slice(4));
  if (!Number.isFinite(year) || !Number.isFinite(doy) || doy < 1 || doy > 366) {
    throw new Error(`Bad day-of-year time: "${yearDoy}"`);
  }
  const hh = Number(hhmm.slice(0, 2));
  const mm = Number(hhmm.slice(2, 4));
  return Date.UTC(year, 0, doy, hh, mm);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function main(): void {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: npx tsx convert-hms-kml.ts <in.kml> <out.geojson>");
    process.exit(1);
  }
  const kml = readFileSync(inPath, "utf8");
  const placemarks = kml.match(/<Placemark>[\s\S]*?<\/Placemark>/g) ?? [];
  const features: unknown[] = [];
  for (const pm of placemarks) {
    const desc = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(pm)?.[1] ?? "";
    const start = /Start Time:\s*(\d{7})\s*(\d{4})UTC/.exec(desc);
    const end = /End Time:\s*(\d{7})\s*(\d{4})UTC/.exec(desc);
    const density = /Density:\s*(\w+)/.exec(desc)?.[1];
    const satellite = /Satellite:\s*([\w-]+)/.exec(desc)?.[1];
    if (!start || !end || !density) {
      throw new Error(`Placemark missing Start/End/Density in CDATA:\n${desc.slice(0, 200)}`);
    }
    const coordBlock = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(pm)?.[1];
    if (!coordBlock) throw new Error("Placemark has no <coordinates>");
    const ring: Ring = coordBlock
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((tok) => {
        const [lon, lat] = tok.split(",").map(Number);
        return [lon, lat] as [number, number];
      });
    if (!overlaps(ringBbox(ring))) continue;
    const clipped = clipRing(ring);
    if (clipped.length < 4) continue; // fully outside after clipping
    // close the ring and round to 3 decimals (~110 m) to keep the fixture small
    const coords = [clipped.map(([x, y]) => [r3(x), r3(y)] as [number, number])];
    if (coords[0]!.length === 0) continue;
    features.push({
      type: "Feature",
      properties: {
        Density: density,
        Start: `${start[1]} ${start[2]}`,
        End: `${end[1]} ${end[2]}`,
        Satellite: satellite ?? "",
      },
      geometry: { type: "Polygon", coordinates: [coords[0]!] },
    });
  }
  const geojson = {
    type: "FeatureCollection",
    properties: {
      origin: `NOAA HMS Smoke_Polygons KML, converted by apps/api/scripts/convert-hms-kml.ts from ${inPath}`,
    },
    features,
  };
  writeFileSync(outPath, `${JSON.stringify(geojson, null, 1)}\n`);
  console.log(`wrote ${features.length} clipped plumes to ${outPath} (${Buffer.byteLength(JSON.stringify(geojson))} bytes)`);
}

main();