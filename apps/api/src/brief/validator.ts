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
          const window = words.slice(start, start + size).join(" ").toLowerCase();
          if (!allowed.some((name) => name === window || name.includes(window))) {
            return true;
          }
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
    violations.push(...nameViolations(section, brief));
  }
  return { ok: violations.length === 0, violations };
}

/** Entity violations are hallucinated shelter/road/number claims: no retry, straight to the fallback. */
export function hasEntityViolation(result: ValidationResult): boolean {
  return result.violations.some((v) => v.kind === "entity");
}