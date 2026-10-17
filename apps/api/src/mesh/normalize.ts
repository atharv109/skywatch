import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { RescueKind } from "./types.ts";

/**
 * Rescue-kind normalization at the door: any casing/emoji variant of the three
 * rescue statuses ("Trapped", "Injured", "Need Rescue") collapses to its canonical
 * kind. Everything else (empty, unknown words) reads as a non-rescue packet: it is
 * stored + scored like an ordinary packet but never clustered.
 */
export function normalizeRescueKind(status: unknown): RescueKind | null {
  if (typeof status !== "string") return null;
  const s = status
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (s.length === 0) return null;
  if (s.includes("trapped")) return "Trapped";
  if (s.includes("injur") || s.includes("hurt")) return "Injured";
  if (s.includes("rescue") || s.includes("need")) return "Need Rescue";
  return null;
}