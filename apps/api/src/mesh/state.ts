import { createHash } from "node:crypto";
import { confidenceFor } from "../confidence.ts";
import type { ResourceDoc } from "../types/docs.ts";
import type { MeshBeaconDoc, MeshMessageView, MeshPacketDoc, MeshPhotoDoc, MeshState } from "./types.ts";
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
 *
 * Task 8b additions: `messages` (mesh chat, transport not facts — never scored,
 * never decayed, deviceId hashed on both ends) and `resources` (the dashboard's
 * resource pins with map-display status semantics, so node maps show
 * verified-open shelters the same way /map/state does).
 */
export const MESH_DECAY_KIND = "mesh" as const;

/// Stable coverage-dot id: first 10 hex chars of sha256(deviceId). Also the deviceId
/// hash the msg type routes direct messages by (`to` === hashPrefix(deviceHash-owner)).
export function hashPrefix(deviceId: string): string {
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

/**
 * The stable coverage dot for one stored packet (its device's position; invalid-sig
 * packets contribute nothing). Task 8b: `msg` packets add NO dots — a chat message
 * may originate from a device whose beacon/hazard report already covers it, and a
 * message is not a position-fact-bearing report; the dot set stays beacon|hazard.
 */
function coverageDot(p: MeshPacketDoc): MeshState["coverage"][number] | null {
  if (p.type !== "beacon" && p.type !== "hazard") return null;
  if (p.verify === "mismatch" || p.verify === "invalid") return null;
  return { id: hashPrefix(p.deviceId), ...anonymize(p.lon, p.lat) };
}

/**
 * MIRROR NOTE (displayedStatus — same convention as downlink.ts's per-language ack
 * table): byte-for-byte mirror of map/state.ts's displayedStatus, kept HERE because
 * this file must not depend back on map/state.ts (map/state imports this module's
 * shape). map/state.ts remains the display-rule source of truth a corrected rule
 * flows from — keep the two in lockstep (cross-ref both sites).
 */
function displayedStatus(status: string, confidence: number): "open" | "unknown" | "closed" | "full" {
  if (status === "open" && confidence < 0.5) return "unknown";
  if (status === "open") return "open";
  if (status === "closed") return "closed";
  if (status === "full") return "full";
  return "unknown";
}

/** The read view of one msg packet (shared by /mesh/state and the downlink bundle). `photos` resolves its photoRef (review I1 fix: messages expose the photo pointer + resolved view). */
export function messageView(p: MeshPacketDoc, photos: Map<string, MeshPhotoDoc>): MeshMessageView {
  const photo = p.photoRef !== null ? photos.get(p.photoRef) : undefined;
  return {
    id: p.id,
    from: hashPrefix(p.deviceId),
    to: p.to,
    text: p.status,
    ts: p.ts,
    hops: p.hops,
    photoRef: p.photoRef,
    hasPhoto: photo !== undefined,
    photoKind: photo?.kind ?? null,
    photoUrl: photo !== undefined ? `/mesh/photo/${p.photoRef}` : null,
  };
}

export async function assembleMeshState(
  store: MeshStore,
  now: number,
  resources: ResourceDoc[] = [],
): Promise<MeshState> {
  const [packets, clusters, photos] = await Promise.all([
    store.listPackets(),
    store.listBeacons(),
    store.listPhotos(),
  ]);
  // Task 8e: photoRef -> uploaded bytes. A packet's hasPhoto is true ONLY when its
  // pointer resolves to actual bytes (a declared-but-never-uploaded ref renders as
  // "no photo" — no dangling 404 links on the dashboard).
  const byRef = new Map(photos.map((p) => [p.photoRef, p] as const));

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
    .map((p) => {
      // Task 8e photo view (dashboard gallery strip links photoUrl).
      const photo = p.photoRef !== null ? byRef.get(p.photoRef) : undefined;
      return {
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
        hasPhoto: photo !== undefined,
        photoKind: photo?.kind ?? null,
        photoUrl: photo ? `/mesh/photo/${p.photoRef}` : null,
        photoVision: p.photoVision ?? null,
      };
    });

  // Coverage: one dot per contributing device (its most recently received report).
  const latest = new Map<string, MeshPacketDoc>();
  for (const p of [...packets].sort((a, b) => a.receivedAt - b.receivedAt)) {
    const dot = coverageDot(p);
    if (dot) latest.set(p.deviceId, p);
  }
  const coverage = [...latest.values()].map(coverageDot) as MeshState["coverage"];

  // Task 8b mesh chat: newest 50 by device ts (the thread order the node pages
  // render), type "msg" only — acks/briefs/reports never surface as a message.
  const messages = packets
    .filter((p) => p.type === "msg")
    .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
    .slice(0, 50)
    .map((p) => messageView(p, byRef));

  // Task 8b resource pins: same compose as /map/state's resources (all non-road
  // resources ride the shelter half-life; displayedStatus applies read-time).
  const resourcePins = resources.map((r) => {
    const confidence = confidenceFor("shelter", r.verifiedAt, now);
    return {
      sourceId: r.sourceId,
      kind: r.kind,
      name: r.name,
      status: displayedStatus(r.status, confidence),
      lat: r.loc.coordinates[1],
      lon: r.loc.coordinates[0],
    };
  });

  return {
    generatedAt: now,
    beacons,
    hazardReports,
    coverage,
    messages,
    resources: resourcePins,
    counts: {
      packets: packets.length,
      beacons: clusters.length,
      devices: coverage.length,
      acked: clusters.filter((b) => b.ackedAt !== null).length,
    },
  };
}