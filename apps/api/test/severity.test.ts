import { describe, expect, it } from "vitest";
import { severityFromAqi, severityFromDensity, severityFromGage, severityFromNws } from "../src/ingest/severity.ts";

describe("severityFromAqi (US AQI bands -> 1..4)", () => {
  it("maps the EPA bands with lower-band boundary convention", () => {
    expect(severityFromAqi(0)).toBe(1);
    expect(severityFromAqi(50)).toBe(1); // boundary belongs to Good
    expect(severityFromAqi(51)).toBe(2);
    expect(severityFromAqi(100)).toBe(2);
    expect(severityFromAqi(101)).toBe(3);
    expect(severityFromAqi(150)).toBe(3);
    expect(severityFromAqi(151)).toBe(4);
    expect(severityFromAqi(600)).toBe(4);
  });
});

describe("severityFromNws (CAP severity word + event wording)", () => {
  it("maps the CAP severity vocabulary", () => {
    expect(severityFromNws("Extreme", undefined)).toBe(4);
    expect(severityFromNws("Severe", undefined)).toBe(3);
    expect(severityFromNws("Moderate", undefined)).toBe(2);
    expect(severityFromNws("Minor", undefined)).toBe(1);
    expect(severityFromNws(undefined, undefined)).toBe(1);
    expect(severityFromNws("NonsenseWord", undefined)).toBe(1);
  });
  it("floors a Warning at 3 and Emergency at 4 regardless of the level word", () => {
    expect(severityFromNws("Minor", "Flood Warning")).toBe(3);
    expect(severityFromNws("Moderate", "Flood Warning")).toBe(3);
    expect(severityFromNws("Severe", "Flash Flood Warning")).toBe(3);
    expect(severityFromNws("Minor", "Flash Flood Emergency")).toBe(4);
    expect(severityFromNws("Moderate", "Air Quality Alert")).toBe(2); // not a Warning
    expect(severityFromNws("Minor", "Flood Advisory")).toBe(1);
  });
});

describe("severityFromDensity (NOAA HMS smoke)", () => {
  it("maps Light/Medium/Heavy and falls back low", () => {
    expect(severityFromDensity("Light")).toBe(1);
    expect(severityFromDensity("Medium")).toBe(2);
    expect(severityFromDensity("Heavy")).toBe(3);
    expect(severityFromDensity("Weird")).toBe(1);
    expect(severityFromDensity(undefined)).toBe(1);
  });
});

describe("severityFromGage (USGS gage height vs flood stage)", () => {
  it("returns null below half of flood stage (no hazard) or bad stage", () => {
    expect(severityFromGage(2.56, 9.0)).toBeNull(); // the real 2026-10-17 reading
    expect(severityFromGage(9.42, 0)).toBeNull();
  });
  it("maps watch/action/flood/major bands", () => {
    expect(severityFromGage(4.5, 9.0)).toBe(1); // 50-89%
    expect(severityFromGage(8.2, 9.0)).toBe(2); // ~91% action stage
    expect(severityFromGage(8.99, 9.0)).toBe(2); // just under flood
    expect(severityFromGage(9.0, 9.0)).toBe(3); // at flood stage
    expect(severityFromGage(9.42, 9.0)).toBe(3); // the demo fixture value
    expect(severityFromGage(10.0, 9.0)).toBe(4); // > 110%
  });
});