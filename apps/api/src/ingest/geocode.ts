import type { Fetcher } from "./nws.ts";

/**
 * US Census Geocoder (verified 2026-10-17, data-sources-report.md §7):
 *   https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=<enc>&benchmark=Public_AR_Current&format=json
 * - NO MATCH IS STILL HTTP 200 with `result.addressMatches: []` — that is return null, not an error.
 * - Coordinates: `x` = longitude, `y` = latitude (the geocoder's own axis naming).
 * - Soft rate limits are community-documented (~1 req / 4 s); signup flow calls it once per user.
 */

const GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface GeocodeResult {
  lat: number;
  lon: number;
  matchedAddress: string;
  zip: string | null;
}

interface CensusPayload {
  result?: {
    addressMatches?: Array<{
      coordinates?: { x?: number; y?: number };
      matchedAddress?: string;
      addressComponents?: { zip?: string };
    }>;
  };
}

export async function geocodeAddress(
  address: string,
  opts: { fetcher?: Fetcher } = {},
): Promise<GeocodeResult | null> {
  const doFetch = opts.fetcher ?? fetch;
  const url = `${GEOCODER_URL}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Census Geocoder failed: HTTP ${res.status}`);
  const body = (await res.json()) as CensusPayload;
  const match = body.result?.addressMatches?.[0];
  const lon = match?.coordinates?.x;
  const lat = match?.coordinates?.y;
  if (!match || typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return {
    lat,
    lon,
    matchedAddress: match.matchedAddress ?? "",
    zip: match.addressComponents?.zip ?? null,
  };
}