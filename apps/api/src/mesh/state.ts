import { createHash } from "node:crypto";
import { confidenceFor } from "../confidence.ts";
import type { MeshBeaconDoc, MeshPacketDoc, MeshState } from "./types.ts";
import type { MeshStore } from "./store.ts";

/**
 * GET /mesh/state — the dark-zone dashboard layer (Task 8), and the same shape
 * merged into /map/state as an optional `mesh` section when any packets exist.
 *
 * Privacy (Global Constraint 7, same posture as map/state): no phone number and NO
 * raw deviceId is ever emitted — coverage dots are anonymized to a stable hash
 * prefix of the deviceId plus a ~1 km rounded location. Beacon clusters are ranked
 * by priority (rescue kinds are NEVER decayed or downgraded); hazard reports carry
 * the stored sync-time score composed with the 30-min read-time decay.
 */
export const MESH_DECAY_KIND = "mesh" as const;

/// Stable coverage-dot id: first 10 hex chars of sha256(deviceId).
function hashPrefix(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("hex").slice(0, 10);
}

// ~1.1 km rounding, mirroring map/state's anonymize (kept local: map/state imports
// the TYPE from here, so this file must not depend back on map/state).
function anonymize(lon: number, lat: number): { lat: number; lon: number } {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

export function rankBeacons(clusters: MeshBeaconDoc[]): MeshBeaconDoc[] {
  return [...clusters].sort(
    (a, b) => b.priority - a.priority || b.lastSeen - a.lastSeen || a.clusterId.localeCompare(b.clusterId),
  );
}

/** The stable coverage dot for one stored packet (its device's position; invalid-sig packets contribute nothing). */
function coverageDot(p: MeshPacketDoc): MeshState["coverage"][number] | null {
  if (p.type !== "beacon" && p.type !== "hazard") return null;
  if (p.verify === "mismatch" || p.verify === "invalid") return null;
  return { id: hashPrefix(p.deviceId), ...anonymize(p.lon, p.lat) };
}

export async function assembleMeshState(store: MeshStore, now: number): Promise<MeshState> {
  const [packets, clusters] = await Promise.all([store.listPackets(), store.listBeacons()]);

  const beacons = rankBeacons(clusters).map((b) => ({
    clusterId: b.clusterId,
    kind: b.kind,
    priority: b.priority,
    lat: b.loc.coordinates[1],
    lon: b.loc.coordinates[0],
    reports: b.packetIds.length,
    firstSeen: b.firstSeen,
    lastSeen: b.lastSeen,
    ackedAt: b.ackedAt,
    // Rescue kinds are NEVER decayed or downgraded: the cluster score is the best
    // verified contributing packet's sync-time score, shown as stored.
    score: b.score,
  }));

  const hazardReports = packets
    .filter((p) => p.type === "hazard")
    .sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id))
    .slice(0, 50)
    .map((p) => ({
      id: p.id,
      status: p.status,
      lat: p.lat,
      lon: p.lon,
      ts: p.ts,
      verify: p.verify,
      score:
        p.score === null
          ? null
          : Math.round(p.score * confidenceFor(MESH_DECAY_KIND, p.scoredAt, now) * 100) / 100,
      reasons: p.reasons,
    }));

  // Coverage: one dot per contributing device (its most recently received report).
  const latest = new Map<string, MeshPacketDoc>();
  for (const p of [...packets].sort((a, b) => a.receivedAt - b.receivedAt)) {
    const dot = coverageDot(p);
    if (dot) latest.set(p.deviceId, p);
  }
  const coverage = [...latest.values()].map(coverageDot) as MeshState["coverage"];

  return {
    generatedAt: now,
    beacons,
    hazardReports,
    coverage,
    counts: {
      packets: packets.length,
      beacons: clusters.length,
      devices: coverage.length,
      acked: clusters.filter((b) => b.ackedAt !== null).length,
    },
  };
}