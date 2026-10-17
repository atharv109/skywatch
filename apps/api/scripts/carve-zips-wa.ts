/**
 * Carves apps/api/fixtures/zips-wa.tsv from the GeoNames postal dump.
 *
 * Source (verified 2026-10-17): https://download.geonames.org/export/zip/US.zip
 * (US.txt is tab-delimited; column order per readme.txt: 1 country code, 2 postal code,
 * 3 place name, 4 admin name1, 5 admin code1 (state), ... , 10 latitude, 11 longitude).
 * This script keeps rows with admin code1 == WA, dedupes by postal code (first row wins),
 * and writes `zip<TAB>lat<TAB>lon`. Download US.zip into a TEMP folder outside the repo;
 * nothing from the dump is committed except the filtered output.
 *
 * Usage: npx tsx apps/api/scripts/carve-zips-wa.ts <path/to/US.txt> <path/to/output/zips-wa.tsv>
 */
import { readFileSync, writeFileSync } from "node:fs";

function main(): void {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: npx tsx carve-zips-wa.ts <US.txt> <zips-wa.tsv>");
    process.exit(1);
  }
  const lines = readFileSync(inPath, "utf8").split("\n");
  const byZip = new Map<string, { lat: string; lon: string }>();
  for (const line of lines) {
    if (line.length === 0) continue;
    const f = line.split("\t");
    if (f[4] !== "WA") continue;
    const zip = f[1] ?? "";
    const lat = f[9];
    const lon = f[10];
    if (!zip || !lat || !lon || byZip.has(zip)) continue;
    byZip.set(zip, { lat, lon });
  }
  const out: string[] = ["zip\tlat\tlon"];
  for (const [zip, { lat, lon }] of [...byZip.entries()].sort()) {
    out.push(`${zip}\t${lat}\t${lon}`);
  }
  writeFileSync(outPath, `${out.join("\n")}\n`);
  console.log(`wrote ${byZip.size} WA zip rows to ${outPath}`);
}

main();