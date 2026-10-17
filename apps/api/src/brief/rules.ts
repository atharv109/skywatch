import type { BriefAction, HazardType } from "../types/brief.ts";

/**
 * The brief action rule table (backend-build-plan.md Task 4): (hazardType, severity
 * band) -> ordered action ids, English text from ACTION_TEXT, hard cap 5 after
 * dedupe across hazards. Severity floors: alert/severity 1-2 bands stay
 * informational, 3-4 bands are actionable. Severity values themselves always come
 * from src/ingest/severity.ts — this table only reads them.
 */

export const MAX_ACTIONS = 5;

/** English action text keyed by kebab id (rule rows reference these). */
export const ACTION_TEXT: Record<string, string> = {
  "close-windows": "Close windows and doors to keep outside air and smoke out.",
  "run-air-filter": "Run an air filter or fan-filter setup if you have one.",
  "mask-if-outside": "If you go outside, wear an N95 or better mask.",
  "check-on-neighbors": "Check on neighbors by phone if they are at risk.",
  "reduce-outdoor-activity": "Cut back on outdoor activity today.",
  "monitor-news": "Stay tuned to local news and official alerts.",
  "check-on-people": "Check on the people you look after.",
  "follow-official-orders": "Follow instructions from local officials right away.",
  "shelter-in-place": "Go indoors and stay inside until officials say it is safe.",
  "avoid-floodwater": "Never walk or drive through floodwater — turn around, do not drown.",
  "move-upstairs": "If water is rising, get to higher ground immediately.",
  "get-ready-to-move": "Be packed and ready to move if officials ask you to evacuate.",
};

export interface ActionRule {
  type: HazardType;
  /** Inclusive severity band; bands are written disjoint (1-2, 3-4) so one row fires per hazard. */
  minSeverity: number;
  maxSeverity: number;
  actions: readonly string[];
}

export const RULES: readonly ActionRule[] = [
  { type: "alert", minSeverity: 1, maxSeverity: 2, actions: ["monitor-news", "check-on-people"] },
  {
    type: "alert",
    minSeverity: 3,
    maxSeverity: 4,
    actions: ["monitor-news", "check-on-people", "follow-official-orders", "shelter-in-place"],
  },
  { type: "smoke", minSeverity: 1, maxSeverity: 2, actions: ["close-windows", "reduce-outdoor-activity"] },
  {
    type: "smoke",
    minSeverity: 3,
    maxSeverity: 4,
    actions: ["close-windows", "mask-if-outside", "check-on-neighbors", "run-air-filter"],
  },
  { type: "aqi", minSeverity: 1, maxSeverity: 2, actions: ["reduce-outdoor-activity", "monitor-news"] },
  { type: "aqi", minSeverity: 3, maxSeverity: 4, actions: ["close-windows", "reduce-outdoor-activity", "mask-if-outside"] },
  { type: "flood", minSeverity: 1, maxSeverity: 2, actions: ["avoid-floodwater", "check-on-neighbors"] },
  { type: "flood", minSeverity: 3, maxSeverity: 4, actions: ["avoid-floodwater", "move-upstairs", "get-ready-to-move"] },
];

/**
 * Ordered actions for a set of hazards, deduped, capped at MAX_ACTIONS. Hazards are
 * handled worst-first so the most urgent type's actions lead; informational low
 * bands of other hazards follow.
 */
export function selectActions(hazards: Array<{ type: HazardType; severity: number }>): BriefAction[] {
  const worstFirst = [...hazards].sort((a, b) => b.severity - a.severity || a.type.localeCompare(b.type));
  const ids: string[] = [];
  for (const hazard of worstFirst) {
    for (const rule of RULES) {
      if (rule.type !== hazard.type) continue;
      if (hazard.severity < rule.minSeverity || hazard.severity > rule.maxSeverity) continue;
      for (const id of rule.actions) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids.slice(0, MAX_ACTIONS).map((id) => ({ id, text: ACTION_TEXT[id] ?? "" }));
}