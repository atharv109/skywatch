/**
 * The mention validator (backend-build-plan.md Task 5, Global Constraint 3: never
 * name a place/road/number that is not in the brief). It reads ONLY the rendered
 * candidate and the locked brief: every shelter/road name the text mentions must
 * appear in the brief (exact-name match, case-insensitive), and every number the
 * text mentions must be traceable to a brief value — including capacity, distance
 * and time claims. A violation is REJECTED: the safety class goes straight to the
 * per-language fallback, the format class gets one retry first (render.ts).
 *
 * Staleness rule made real: the brief builder only emits shelters/roads whose
 * confidence is >= 0.5 (below the floor the shelter is null and expired roads are
 * filtered at match time), and the pipeline builds the brief fresh at send time —
 * so "present in the brief" is exactly "present and fresh".
 *
 * Extraction honest-limit (documented in the task report): name extraction works
 * on capitalized proper-noun windows (all latin-script languages capitalize
 * proper names); single capitalized words are not entity candidates (too many
 * sentence starts), Han/Arabic scripts have no capitals, and numbers are always
 * gated.
 */
import type { GeminiRender } from "./render.ts";
import type { UserBrief } from "../types/brief.ts";

export const MAX_ALERT_CHARS = 300;

export type ViolationKind = "entity" | "format";

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

/** Lowercase connectors that may sit inside a proper-noun run. */
const RUN_CONNECTORS = new Set(["of", "the", "and", "at", "de", "del", "la", "el", "y", "da", "di", "na", "ng"]);
const MAX_NAME_WINDOW = 5;

const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;

/**
 * Proper-noun clauses: names never span sentence enders, commas, colons, CJK
 * punctuation or dashes, so those are clause boundaries. Han/Arabic (no
 * capitalization) reads as clause-only fragments there — their invented names
 * are a documented gap; the number gate and the fallback carry that floor.
 */
const CLAUSE_SPLIT = /[.!?。！？;；:：,，、\n–—]+/u;

/** "08" -> "8"; used so zero-padded renders still match brief values. */
function normalizeNumber(raw: string): string {
  const stripped = raw.replace(/^0+(?=\d)/, "");
  return Number.isInteger(Number(stripped)) ? String(Number(stripped)) : stripped;
}

function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER_PATTERN)) {
    for (const form of [m[0], normalizeNumber(m[0])]) out.add(form);
  }
  return out;
}

/**
 * Every digit-run the rendered text may use must already appear somewhere in the
 * brief — string fields included (titles, timing, hours, ids) since the brief's
 * own JSON is the allowlist. The opaque userId (Mongo ObjectId hex) is excluded so
 * its digit soup cannot widen the gate. 911 rides in through brief.emergency and
 * is also whitelisted explicitly (it is the emergency number in every language).
 */
function allowedNumbers(brief: UserBrief): Set<string> {
  const sources: unknown[] = [
    brief.hazards,
    brief.actions,
    brief.shelter,
    brief.blockedRoads,
    brief.officialSource,
    brief.emergency,
    "911",
  ];
  return numberTokens(sources.map((s) => JSON.stringify(s)).join(" "));
}

/** Digit runs found inside the brief's entity-name strings only (shelter/road names, camera ids, titles). */
function allowedNameNumbers(brief: UserBrief): Set<string> {
  const names = [
    brief.shelter?.name ?? "",
    ...brief.blockedRoads.flatMap((r) => [r.name, r.cameraId]),
    ...brief.hazards.map((h) => h.title),
  ];
  return numberTokens(names.join(" "));
}

/*
 * Context-bound number claims (fix round 1): a digit the bare allowlist happens
 * to contain is still a hallucination when the phrase around it names a quantity
 * the brief does not carry. Capacity-like phrases bind to nothing (the locked
 * brief has no capacity field — every such claim rejects); time-ago phrases bind
 * to verifiedMinutesAgo; distance phrases bind to shelter.distanceKm and only in
 * metric units ("miles never"); severity digits bind to actual hazard severities;
 * milepost digits bind to entity-name digits. Bare digits with none of these
 * contexts keep the plain presence-anywhere allowlist.
 */
const CAPACITY_RES: RegExp[] = [
  /(\d+(?:\.\d+)?)\s*[-–]?\s*(?:people|persons?|beds?|cots?|seats?|spots?|families?|personas|camas|tao|người|أشخاص|أسرّة|床位)/giu,
  /(?:\b(?:capacity|capacidad|sức\s*chứa)\b[^.!?\n\d]{0,12})(\d+(?:\.\d+)?)/giu,
  /(\d+(?:\.\d+)?)\s*人/gu,
];
const KM_RE = /(\d+(?:\.\d+)?)\s*(?:kilometers?|kilometres?|kilometros?|km\b|公里|كم)/giu;
const BAD_DISTANCE_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(?:miles?\b|mi\b|meters?\b|metres?\b|feet\b|foot\b|yards?\b|英里|英尺|أميال|أقدام|dặm\b|milya\b)/giu;
const MINUTES_AGO_RE = /(\d+)\s*(?:minutes?|mins?)\s*ago/giu;
const HOURS_AGO_RE = /(\d+)\s*(?:hours?|hrs?)\s*ago/giu;
const DAYS_AGO_RE = /(\d+)\s*(?:days?|weeks?)\s*ago/giu;
const SEVERITY_RE = /(?:\blevel\b|\bseverity\b)\s*(?:of\s*)?(\d+)/giu;
const MILEPOST_RE = /(?:\bMP\b|\bmilepost\b)\s*\.?\s*(\d+)/giu;

function roughlyEquals(raw: string, value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(Number(raw)) && Math.abs(Number(raw) - value) < 1e-9;
}

function numberContextViolations(section: string, brief: UserBrief): Violation[] {
  const violations: Violation[] = [];
  const shelter = brief.shelter;
  const push = (detail: string) => violations.push({ kind: "entity", detail });

  // Capacity-like claims: the locked brief carries no capacity value at all.
  for (const re of CAPACITY_RES) {
    for (const m of section.matchAll(re)) push(`capacity claim "${m[0].trim()}" — the brief carries no capacity value`);
  }
  // Distances: non-metric units are always inventions (unit swap), km must equal distanceKm.
  for (const m of section.matchAll(BAD_DISTANCE_UNIT_RE)) push(`distance "${m[0].trim()}" uses a unit the brief has no value for`);
  for (const m of section.matchAll(KM_RE)) {
    if (!roughlyEquals(m[1]!, shelter?.distanceKm)) {
      push(`distance "${m[0].trim()}" is not the brief's shelter distance`);
    }
  }
  // Time-ago claims: bound to verifiedMinutesAgo (hours scaled); any other unit rejects.
  for (const m of section.matchAll(DAYS_AGO_RE)) push(`staleness claim "${m[0].trim()}" is not a brief value`);
  for (const m of section.matchAll(MINUTES_AGO_RE)) {
    if (!roughlyEquals(m[1]!, shelter?.verifiedMinutesAgo)) {
      push(`staleness claim "${m[0].trim()}" does not match verifiedMinutesAgo`);
    }
  }
  for (const m of section.matchAll(HOURS_AGO_RE)) {
    if (!roughlyEquals(String(Number(m[1]) * 60), shelter?.verifiedMinutesAgo)) {
      push(`staleness claim "${m[0].trim()}" does not match verifiedMinutesAgo`);
    }
  }
  // Severity digits: only in hazard-context phrases, and only real brief severities.
  const severities = brief.hazards.map((h) => h.severity);
  for (const m of section.matchAll(SEVERITY_RE)) {
    if (!severities.includes(Number(m[1]))) {
      push(`severity claim "${m[0].trim()}" is not a brief severity`);
    }
  }
  // Milepost digits must come from an entity name / camera id, not severity etc.
  const nameNumbers = allowedNameNumbers(brief);
  for (const m of section.matchAll(MILEPOST_RE)) {
    if (!nameNumbers.has(m[1]!)) {
      push(`milepost claim "${m[0].trim()}" is not a brief entity value`);
    }
  }
  return violations;
}

/** Maximal runs of capitalized tokens per clause ("Martin Luther King Jr Way", "SR 99"). */
function properEntityRuns(text: string): string[] {
  const isCapital = (t: string) => /^\p{Lu}/u.test(t) && /\p{L}/u.test(t);
  const isNumber = (t: string) => /^\d/.test(t);
  const runs: string[] = [];
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const tokens = clause
      .split(/[ \t]+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}%]+$/u, ""))
      .filter((w) => w.length > 0);
    let current: string[] = [];
    const flush = () => {
      if (current.length >= 2 && current.some(isCapital)) runs.push(current.join(" "));
      current = [];
    };
    for (const token of tokens) {
      if (isCapital(token) || isNumber(token) || RUN_CONNECTORS.has(token.toLowerCase())) {
        current.push(token);
      } else {
        flush();
      }
    }
    flush();
  }
  return runs;
}

/**
 * A run is an invented entity when some connector-free segment of it has a
 * capitalized sub-window not contained in any allowed brief phrase (shelter
 * name, blocked-road name, official source, hazard title, emergency line;
 * case-insensitive). Windowing (not whole-run matching) stops one invented name
 * hiding inside a list of real ones, and stops two adjacent real names fusing
 * into a false violation.
 *
 * Fix round 1 (b16): before judging a failed window, ONE leading non-brief
 * capitalized token is stripped — "Avoid I-5" / "Take SR 99" (command verb +
 * allowed name) must not reject, while multi-word invented names keep failing
 * because their remaining windows still mismatch.
 */
function nameViolations(text: string, brief: UserBrief): Violation[] {
  const allowed = [
    brief.shelter?.name ?? "",
    ...brief.blockedRoads.map((r) => r.name),
    brief.officialSource.name,
    ...brief.hazards.map((h) => h.title),
    brief.emergency,
  ]
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  const windowInBrief = (tokens: string[]): boolean => {
    const phrase = tokens.join(" ").toLowerCase();
    return allowed.some((name) => name === phrase || name.includes(phrase));
  };
  const violations: Violation[] = [];
  for (const run of properEntityRuns(text)) {
    const segments: string[][] = [];
    let segment: string[] = [];
    for (const token of run.split(" ")) {
      if (RUN_CONNECTORS.has(token.toLowerCase())) {
        if (segment.length > 0) segments.push(segment);
        segment = [];
      } else {
        segment.push(token);
      }
    }
    if (segment.length > 0) segments.push(segment);
    const invented = segments.some((seg) => {
      // Pure-number tokens are the number gate's job (every number must equal a
      // brief value); name windows check capitalized words only, so "Gọi 911"
      // / "SR 99" style phrases are not re-verified as "names".
      const words = seg.filter((t) => !/^\d/.test(t));
      for (let size = 2; size <= Math.min(MAX_NAME_WINDOW, words.length); size++) {
        for (let start = 0; start + size <= words.length; start++) {
          const window = words.slice(start, start + size);
          if (windowInBrief(window)) continue;
          // strip ONE leading non-brief capitalized token ("Avoid", "Take", "Use")
          if (windowInBrief(window.slice(1))) continue;
          return true;
        }
      }
      return false;
    });
    if (invented) {
      violations.push({ kind: "entity", detail: `mentions "${run}" which is not in the brief` });
    }
  }
  return violations;
}

/**
 * Validate one rendered candidate against the brief. voiceScript is validated for
 * entity safety too (the voice agent reads it to the user); only `text` carries
 * the 300-char bound.
 */
export function validateRendered(candidate: GeminiRender, brief: UserBrief): ValidationResult {
  const violations: Violation[] = [];
  if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) {
    return { ok: false, violations: [{ kind: "format", detail: "empty text" }] };
  }
  if (candidate.text.length > MAX_ALERT_CHARS) {
    violations.push({ kind: "format", detail: `text is ${candidate.text.length} chars (limit ${MAX_ALERT_CHARS})` });
  }
  if (typeof candidate.voiceScript !== "string" || candidate.voiceScript.trim().length === 0) {
    return { ok: false, violations: [{ kind: "format", detail: "missing voiceScript" }] };
  }
  const allowed = allowedNumbers(brief);
  for (const section of [candidate.text, candidate.voiceScript]) {
    for (const token of numberTokens(section)) {
      if (!allowed.has(token)) {
        violations.push({ kind: "entity", detail: `numbers: "${token}" is not a brief value` });
      }
    }
    violations.push(...numberContextViolations(section, brief));
    violations.push(...nameViolations(section, brief));
  }
  return { ok: violations.length === 0, violations };
}

/** Entity violations are hallucinated shelter/road/number claims: no retry, straight to the fallback. */
export function hasEntityViolation(result: ValidationResult): boolean {
  return result.violations.some((v) => v.kind === "entity");
}