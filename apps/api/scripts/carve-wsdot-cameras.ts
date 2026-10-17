/**
 * Carves apps/api/fixtures/cameras.json from the full WSDOT HighwayCameras list.
 *
 * Source (verified 2026-10-17): http://wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode=<code>
 * (help: .../GetCamerasAsJson). Row schema: CameraID, CameraLocation{Description, Direction,
 * Latitude, Longitude, MilePost, RoadName}, ImageURL, IsActive, Region, Title.
 *
 * The access code is emailed by WSDOT and is NEVER committed — download the full list once
 * to a TEMP folder outside the repo, pass it in as argv, and only the trimmed public entries
 * (CameraID/Title/Region/RoadName/Direction/lat/lon/public ImageURL/IsActive) get committed.
 * The AccessCode field is dropped here; fixtures/cameras.json contains no secrets.
 *
 * Usage: npx tsx apps/api/scripts/carve-wsdot-cameras.ts <cameras_all.json> <out/cameras.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Demo-neighborhood cameras: Seattle downtown/Lake City via I-5/SR 99, Rainier Valley
 * (I-90/SR 599), and Snoqualmie Valley flood-adjacent (SR 202 / I-90 east). */
const CAMERA_IDS = [9800, 9367, 1089, 1517, 9263, 9952, 9995, 1090];

function main(): void {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: npx tsx carve-wsdot-cameras.ts <cameras_all.json> <cameras.json>");
    process.exit(1);
  }
  const all: Array<{
    CameraID: number;
    Title: string | null;
    Region: string | null;
    CameraLocation: { Description: string | null; Direction: string | null; Latitude: number; Longitude: number; RoadName: string | null } | null;
    ImageURL: string;
    IsActive: boolean;
  }> = JSON.parse(readFileSync(inPath, "utf8"));
  const byId = new Map(all.map((c) => [c.CameraID, c]));
  const carved = CAMERA_IDS.map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`CameraID ${id} not found in input`);
    if (c.ImageURL.includes("AccessCode=") || c.ImageURL.toLowerCase().includes("accesscode")) {
      throw new Error(`ImageURL for ${id} embeds an access code; refusing to carve`);
    }
    return {
      CameraID: c.CameraID,
      Title: c.Title,
      Region: c.Region,
      CameraLocation: c.CameraLocation === null
        ? null
        : {
            Description: c.CameraLocation.Description,
            Direction: c.CameraLocation.Direction,
            RoadName: c.CameraLocation.RoadName,
            Latitude: c.CameraLocation.Latitude,
            Longitude: c.CameraLocation.Longitude,
          },
      ImageURL: c.ImageURL,
      IsActive: c.IsActive,
    };
  });
  const json = {
    origin: "WSDOT Traveler Information API HighwayCamerasREST.svc GetCamerasAsJson (access-code fetch, code not stored — camera ImageURLs are public)",
    cameras: carved,
  };
  writeFileSync(outPath, `${JSON.stringify(json, null, 1)}\n`);
  console.log(`wrote ${carved.length} cameras to ${outPath}`);
}

main();