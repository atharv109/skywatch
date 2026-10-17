import { describe, expect, it } from "vitest";
import { fetchNwsAlerts, normalizeNwsAlerts, type NwsAlertPayload } from "../src/ingest/nws.ts";
import { fetchAqiObservation, normalizeAqi, type AqiObservation } from "../src/ingest/aqi.ts";
import { fetchSmokeFeatures, normalizeSmokeFeatures, parseDoyTime } from "../src/ingest/smoke.ts";
import { fetchGaugeReadings, normalizeGaugeReadings } from "../src/ingest/river.ts";
import { geocodeAddress } from "../src/ingest/geocode.ts";
import { readFixture } from "../src/ingest/fixtureio.ts";

const SEATTLE = { lat: 47.6062, lon: -122.3321 };

function jsonFetcher(body: unknown, capture?: { url: string; init?: RequestInit }): typeof fetch {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (capture) {
      capture.url = String(input instanceof Request ? input.url : input);
      capture.init = init;
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return fake as typeof fetch;
}

describe("NWS alerts fetcher (injected fetch)", () => {
  const sample: NwsAlertPayload = {
    type: "FeatureCollection",
    features: [
      {
        geometry: { type: "Polygon", coordinates: [[[-122.5, 47.7], [-122.2, 47.7], [-122.2, 47.5], [-122.5, 47.7]]] },
        properties: {
          id: "urn:oid:2.49.0.1.840.0.test.001.1",
          event: "Flood Advisory",
          severity: "Minor",
          headline: "Flood Advisory for test area",
          areaDesc: "King County, WA",
          effective: "2026-10-17T15:59:00-04:00",
          ends: "2026-10-17T18:00:00-04:00",
        },
      },
      {
        // no geometry + repeated event id: zone-based alert, skipped
        geometry: null,
        properties: { id: "urn:oid:2.49.0.1.840.0.test.002.1", event: "Wind Advisory", severity: "Minor" },
      },
      {
        geometry: { type: "Point", coordinates: [-122.3, 47.6] },
        properties: { id: "urn:oid:2.49.0.1.840.0.test.003.1", event: "Air Quality Alert", severity: "Moderate" },
      },
    ],
  };

  it("sends the required User-Agent and the bare point query (no extra params)", async () => {
    const capture: { url: string; init?: RequestInit } = { url: "" };
    await fetchNwsAlerts(SEATTLE, { fetcher: jsonFetcher(sample, capture) });
    expect(capture.url).toBe("https://api.weather.gov/alerts/active?point=47.6062,-122.3321");
    expect((capture.init?.headers as Record<string, string>)["User-Agent"]).toMatch(/Skywatch/);
  });

  it("normalizes alerts into hazards; event name picks the brief type; geometry-less features skipped", () => {
    const [flood] = normalizeNwsAlerts(sample);
    expect(flood?.type).toBe("flood");
    expect(flood?.severity).toBe(1); // Minor Advisory
    expect(flood?.geometry.type).toBe("Polygon");
    expect(new Set(normalizeNwsAlerts(sample).map((h) => h.type))).toEqual(new Set(["flood", "aqi"]));
    expect(normalizeNwsAlerts(sample)).toHaveLength(2);
  });

  it("treats the empty-features response as success (the normal Seattle case)", async () => {
    const alerts = await fetchNwsAlerts(SEATTLE, { fetcher: jsonFetcher({ type: "FeatureCollection", features: [] }) });
    expect(alerts.features).toEqual([]);
  });
});

describe("AQI fetchers (injected fetch)", () => {
  let capture: { url: string; init?: RequestInit };
  it("falls back to Open-Meteo on the AIR-QUALITY host when no key is set", async () => {
    capture = { url: "" };
    const obs = await fetchAqiObservation(SEATTLE, { fetcher: jsonFetcher({ current: { time: "2026-10-17T19:00", pm2_5: 4.6, us_aqi: 40 } }, capture) });
    expect(capture.url).toContain("https://air-quality-api.open-meteo.com/v1/air-quality");
    expect(capture.url).toContain("us_aqi");
    expect(obs?.source).toBe("Open-Meteo");
    expect(obs?.aqi).toBe(40);
  });

  it("prefers AirNow with a key and picks the PM2.5 row", async () => {
    capture = { url: "" };
    const obs = await fetchAqiObservation(SEATTLE, {
      airnowApiKey: "k",
      fetcher: jsonFetcher([{ ParameterName: "O3", AQI: 30 }, { ParameterName: "PM2.5", AQI: 41, DateObserved: "2026-10-17T08:00:00-07:00" }], capture),
    });
    expect(capture.url).toContain("airnowapi.org/aq/observation/latLong/current");
    expect(capture.url).not.toContain("API_KEY=k");
    expect(capture.url).toContain("API_KEY"); // key is on the URL by AirNow's contract
    expect(obs?.source).toBe("AirNow");
    expect(obs?.aqi).toBe(41);
  });

  it("normalizes to an aqi hazard with band in the title and severity from US AQI", () => {
    const obs: AqiObservation = { aqi: 42, pm25: 4.6, source: "Open-Meteo", observedMs: Date.UTC(2026, 9, 17, 19), lat: 47.6, lon: -122.3 };
    const hazard = normalizeAqi(obs);
    expect(hazard?.type).toBe("aqi");
    expect(hazard?.severity).toBe(1);
    expect(hazard?.title).toContain("AQI 42");
    expect(hazard?.title).toContain("Good");
    expect(normalizeAqi({ ...obs, aqi: 120 })?.severity).toBe(3);
    expect(normalizeAqi({ ...obs, aqi: 200 })?.severity).toBe(4);
    expect(normalizeAqi({ ...obs, aqi: null })).toBeNull();
  });
});

describe("NOAA HMS smoke fetcher (injected fetch, live pagination)", () => {
  it("paginates on exceededTransferLimit with resultOffset and URL-encodes (v1)", async () => {
    const urls: string[] = [];
    const pageOne = { type: "FeatureCollection", properties: { exceededTransferLimit: true }, features: [plume(1)] };
    const pageTwo = { type: "FeatureCollection", properties: {}, features: [plume(2)] };
    const fake: typeof fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return new Response(JSON.stringify(urls.length === 1 ? pageOne : pageTwo), { status: 200 });
    };
    const features = await fetchSmokeFeatures({ fetcher: fake });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("NOAA_Satellite_Smoke_Detection_%28v1%29/FeatureServer/0/query");
    expect(urls[0]).toContain("resultOffset=0");
    expect(urls[1]).toContain("resultOffset=1");
    expect(features).toHaveLength(2);
  });

  it("parses NOAA day-of-year times", () => {
    expect(parseDoyTime("2020255 1610")).toBe(Date.UTC(2020, 8, 11, 16, 10)); // day 255 = Sep 11
    expect(parseDoyTime("2026290 1200")).toBe(Date.UTC(2026, 9, 17, 12, 0));
  });

  it("normalizes plumes with stable sourceIds and density severity", () => {
    const docs = normalizeSmokeFeatures([plume(1), plume(1), plume(2)]);
    expect(docs[0]?.severity).toBe(1);
    expect(docs[2]?.severity).toBe(3);
    expect(new Set(docs.map((d) => d.sourceId)).size).toBe(3); // same-plume duplicates get distinct idx
    expect(normalizeSmokeFeatures([plume(1)])[0]?.sourceId).toBe(docs[0]?.sourceId); // deterministic
  });
});

describe("USGS IV gauge fetcher (injected fetch)", () => {
  it("keeps only the newest provisional (P) reading and ignores non-P", async () => {
    const capture: { url: string; init?: RequestInit } = { url: "" };
    const readings = await fetchGaugeReadings(["12144500"], { fetcher: jsonFetcher(usgsSample(), capture) });
    expect(capture.url).toContain("waterservices.usgs.gov/nwis/iv/?format=json&sites=12144500&parameterCd=00065&siteStatus=active");
    expect(readings).toHaveLength(1);
    expect(readings[0]?.gageHeightFt).toBe(5.1); // 14:30 read wins over 13:00
    expect(readings[0]?.qualifiers).toEqual(["P"]);
  });

  it("normalizes to a flood hazard only above the threshold; site without a stage is skipped", () => {
    const reading = { ...usgsReading(), gageHeightFt: 9.42 };
    const docs = normalizeGaugeReadings([reading]);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.type).toBe("flood");
    expect(docs[0]?.severity).toBe(3);
    expect(normalizeGaugeReadings([{ ...reading, gageHeightFt: 4.0 }, { ...reading, siteId: "99999999" }])).toHaveLength(0);
  });

  it("replay: the flood fixture provides the recorded Snoqualmie reading from disk", async () => {
    const readings = await fetchGaugeReadings(["12144500"], { replay: true });
    expect(readings[0]?.gageHeightFt).toBe(9.42);
    expect(readings[0]?.siteId).toBe("12144500");
    expect(readings[0]?.qualifiers).toEqual(["P"]);
  });
});

describe("Census Geocoder (injected fetch)", () => {
  it("maps x=lon/y=lat from addressMatches", async () => {
    const capture: { url: string; init?: RequestInit } = { url: "" };
    const result = await geocodeAddress("101 Yesler Way, Seattle, WA", {
      fetcher: jsonFetcher({ result: { addressMatches: [{ coordinates: { x: -122.335, y: 47.602 }, matchedAddress: "101 YESLER WAY, SEATTLE, WA", addressComponents: { zip: "98104" } }] } }, capture),
    });
    expect(capture.url).toContain("geocoder/locations/onelineaddress");
    expect(capture.url).toContain("benchmark=Public_AR_Current");
    expect(result).toEqual({ lat: 47.602, lon: -122.335, matchedAddress: "101 YESLER WAY, SEATTLE, WA", zip: "98104" });
  });

  it("returns null (not an error) on the no-match 200 with empty addressMatches", async () => {
    const result = await geocodeAddress("nowhere", { fetcher: jsonFetcher({ result: { addressMatches: [] } }) });
    expect(result).toBeNull();
  });
});

describe("ingest fixture path (REPLAY=1 reads from disk)", () => {
  it("every fetcher's replay branch returns the committed fixture data", async () => {
    const alerts = await fetchNwsAlerts(SEATTLE, { replay: true });
    expect(alerts.features).toHaveLength(1);
    expect(alerts.features[0]?.properties?.event).toBe("Air Quality Alert");

    const aqi = await fetchAqiObservation(SEATTLE, { replay: true });
    expect(aqi?.aqi).toBe(40);
    expect(aqi?.source).toBe("Open-Meteo");

    const smoke = await fetchSmokeFeatures({ replay: true });
    expect(smoke.length).toBeGreaterThan(0);
    expect(smoke[0]?.properties?.["Density"]).toBeTruthy();
  });

  it("readFixture throws with a pointer to the missing file for typos", async () => {
    await expect(readFixture("nope.json")).rejects.toThrow(/nope\.json/);
  });
});

function plume(id: number) {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[-121.0, 47.0], [-122.0, 47.0], [-122.0, 48.0], [-121.0, 47.0]]] },
    properties: { FID: id, Satellite: "GOES-WEST", Start: "2020255 1100", End_: "2020255 1610", Density: id % 2 === 0 ? "Heavy" : "Light" },
  };
}

function usgsSample() {
  return {
    value: {
      timeSeries: [
        {
          sourceInfo: {
            siteName: "SNOQUALMIE RIVER NEAR SNOQUALMIE, WA",
            siteCode: [{ value: "12144500" }],
            geoLocation: { geogLocation: { latitude: 47.5450765, longitude: -121.8423157 } },
          },
          variable: { variableCode: [{ value: "00065" }] },
          values: [
            {
              value: [
                { value: "2.56", qualifiers: ["P"], dateTime: "2026-10-17T12:30:00.000-07:00" },
                { value: "9.9", qualifiers: ["A"], dateTime: "2026-10-17T14:30:00.000-07:00" }, // approved: skipped
                { value: "5.1", qualifiers: ["P"], dateTime: "2026-10-17T14:30:00.000-07:00" },
              ],
            },
          ],
        },
        {
          sourceInfo: { siteName: "No geo", siteCode: [{ value: "1" }] },
          values: [{ value: [{ value: "1.0", qualifiers: ["P"], dateTime: "2026-10-17T12:00:00.000-07:00" }] }], // no geoLocation -> skipped
        },
      ],
    },
  };
}

const usgsReading = () => ({
  siteId: "12144500",
  siteName: "SNOQUALMIE RIVER NEAR SNOQUALMIE, WA",
  lat: 47.5450765,
  lon: -121.8423157,
  gageHeightFt: 2.56,
  qualifiers: ["P"],
  observedMs: Date.UTC(2020, 8, 11, 16, 30),
});