/**
 * Explicit severity mapping 1..4 for every ingest source. Assumptions documented
 * per function; the point is that severity is never invented ad hoc in fetchers.
 */

/**
 * US AQI (EPA bands; AirNow `AQI` and Open-Meteo `us_aqi` are the same scale):
 *   0-50 Good -> 1, 51-100 Moderate -> 2, 101-150 Unhealthy for Sensitive Groups -> 3,
 *   >150 Unhealthy+ -> 4. Boundary values belong to the lower band (EPA breakpoint
 *   convention: 50 is Good, 51 is Moderate, ...).
 */
export function severityFromAqi(aqi: number): number {
  if (aqi <= 50) return 1;
  if (aqi <= 100) return 2;
  if (aqi <= 150) return 3;
  return 4;
}

/**
 * NWS alert `severity` word (CAP vocabulary: Extreme|Severe|Moderate|Minor|Unknown):
 *   Extreme -> 4, Severe -> 3, Moderate -> 2, Minor|Unknown/other -> 1.
 * Bumps: an event wording of "Warning" carries higher urgency than the CAP level
 * word suggests (a "Minor" Flood Warning is still actionable), so Warning floors at
 * 3; an "...Emergency..." event is the top of the scale. Advisory/Watch keep the level word.
 */
export function severityFromNws(severity: string | undefined, event: string | undefined): number {
  let level: number;
  switch (severity) {
    case "Extreme":
      level = 4;
      break;
    case "Severe":
      level = 3;
      break;
    case "Moderate":
      level = 2;
      break;
    default:
      level = 1;
  }
  if (event?.includes("Emergency")) return 4;
  if (event?.includes("Warning") && level < 3) return 3;
  return level;
}

/**
 * NOAA HMS smoke plume Density word: Light -> 1, Medium -> 2, Heavy -> 3, unknown -> 1.
 * Level 4 stays reserved for AQI > 150 / NWS Extreme·Emergency (a Heavy plume is
 * area-wide context, whereas those others are direct exposure measurements/urgency).
 */
export function severityFromDensity(density: string | undefined): number {
  switch (density) {
    case "Medium":
      return 2;
    case "Heavy":
      return 3;
    default:
      return 1;
  }
}

/**
 * USGS gage height vs flood stage: reading below 50% of flood stage is not a hazard
 * (null); 50-89% -> 1 (watch the river), 90-99% -> 2 (action stage), 100-110% -> 3
 * (over flood stage), >110% -> 4 (major flooding).
 */
export function severityFromGage(gageFt: number, floodStageFt: number): number | null {
  if (!(floodStageFt > 0) || gageFt < floodStageFt * 0.5) return null;
  const ratio = gageFt / floodStageFt;
  if (ratio > 1.1) return 4;
  if (ratio >= 1.0) return 3;
  if (ratio >= 0.9) return 2;
  return 1;
}