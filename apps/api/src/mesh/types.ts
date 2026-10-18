/**
 * Task 8 document + transport shapes for the Offline Mode (mesh) backend.
 *
 * Transport (locked packet format, frontend-owned Wi-Fi-hotspot relay): dark phones
 * relay over the hotspot LAN; the self-discovered GATEWAY node POSTs the whole mesh
 * queue to `POST /mesh/sync` in one batch and rebroadcasts the downlink bundle this
 * backend returns. The backend knows nothing about WebRTC — this is a pure HTTP
 * batch contract, and TTL decrement / hop counting happen at the relay, not here.
 */
import type { BlockedRoad, ShelterBrief } from "../types/brief.ts";
import type { Point } from "../types/docs.ts";

export const MESH_PACKET_TYPES = ["beacon", "hazard", "ack", "brief", "msg"] as const;
export type MeshPacketType = (typeof MESH_PACKET_TYPES)[number];

/** User chat text over the mesh (Task 8b): the free-text cap on a msg packet's `status`. */
export const MESH_MSG_STATUS_MAX = 280;

/**
 * Task 8d "Ask Skywatch": a msg packet addressed (case-insensitively) to
 * SKYWATCH_ROUTE is a QUESTION routed to the Skywatch chat loop at sync time; the
 * answer is stored as a NEW msg packet from device SKYWATCH_CORE_ID, signed by
 * nobody — it carries verify:"core" (the trusted-core exemption: the server IS the
 * author, so there is nothing to verify; never clustered, never scored, always
 * delivered). Gateways may never CLAIM this deviceId (rejected at the door).
 */
export const SKYWATCH_ROUTE = "SKYWATCH";
export const SKYWATCH_CORE_ID = "SKYWATCH-CORE";

/** Canonical normalized rescue kinds (the packet's raw `status` is normalized at the door). */
export const RESCUE_KINDS = ["Trapped", "Injured", "Need Rescue"] as const;
export type RescueKind = (typeof RESCUE_KINDS)[number];

/** Priority rank for clustering/dashboards: Trapped > Injured > Need Rescue. */
export const RESCUE_PRIORITY: Record<RescueKind, number> = {
  Trapped: 3,
  Injured: 2,
  "Need Rescue": 1,
};

/** Uplink packet exactly as the gateway received it (pre-validation; all fields unknown until normalizePacket checks shape). */
export interface MeshPacketIn {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  lat?: unknown;
  lon?: unknown;
  ts?: unknown;
  hops?: unknown;
  ttl?: unknown;
  photo?: unknown;
  deviceId?: unknown;
  sig?: unknown;
  /** Ed25519 pubkey (base64 raw, 32 bytes) carried by the gateway; pinned on the device's first packet. */
  pubkey?: unknown;
  /** legacy:true = the device could not sign (no WebCrypto Ed25519) — stored UNVERIFIED, scored with an "unsigned device" reason, never clustered. */
  legacy?: unknown;
  /** Task 8b (msg only): null/absent = broadcast to the mesh; a string = direct message to that deviceId hash. */
  to?: unknown;
}

/** Shape-validated packet (normalizePacket in sync.ts). */
export interface ParsedPacket {
  id: string;
  type: MeshPacketType;
  status: string;
  /** Rescue kind for beacon packets (normalized), null for everything else. */
  rescueKind: RescueKind | null;
  lat: number;
  lon: number;
  ts: number;
  hops: number;
  ttl: number;
  /** Presence flag ONLY — image bytes are never stored (privacy/retention; today's sync-time scorer does not read pixels). */
  photo: boolean;
  deviceId: string;
  sig: string | null;
  pubkey: string | null;
  legacy: boolean;
  /** Task 8b (msg only): destination deviceId hash, null = broadcast (always null for the other types). */
  to: string | null;
}

/**
 * Task 8d Ask Skywatch: one question packet handed to the chat loop, and the async
 * seam sync.ts calls for an answer. Context resolves at the ASKER's coordinates
 * (the question carries the stranded user's location), via a point-based brief —
 * the same brief builder / tool route flow use.
 */
export interface SkywatchQuestion {
  /** The asker's packet id (correlation only). */
  id: string;
  /** The question text, verbatim. */
  text: string;
  /** hashPrefix of the asker's deviceId — the reply is addressed direct to this. */
  askerHash: string;
  /** The asker's own coordinates (Point [lon, lat]). */
  loc: Point;
}

/** Returns the answer text (validator-safe, ≤ the packet cap after slice at sync). */
export type SkywatchChat = (question: SkywatchQuestion, now: number) => Promise<string>;

/**
 * Verify states: "ok" = sig verified, "unsigned" = legacy device (no WebCrypto),
 * "core" = the server's own trusted-core packet (Task 8d Ask Skywatch reply —
 * server-signed by construction, nothing to verify; never clustered, always
 * delivered), "mismatch"/"invalid" = sig failure (stored, never dropped silently).
 */
export type VerifyState = "ok" | "unsigned" | "core" | "mismatch" | "invalid";

/** One stored uplink packet (mesh_packets; unique index on id — the dedup key). */
export interface MeshPacketDoc {
  id: string;
  type: MeshPacketType;
  rescueKind: RescueKind | null;
  status: string;
  lat: number;
  lon: number;
  /** Device-side epoch ms, as received (may be skewed — never used for decay: decay uses scoredAt). */
  ts: number;
  hops: number;
  ttl: number;
  photo: boolean;
  deviceId: string;
  verify: VerifyState;
  verifyReason: string | null;
  /** Sync-time score, stored once and never recomputed (null = unscored: verify failure or relay type). */
  score: number | null;
  /** Backend clock when scored — read-time decay composes from here. */
  scoredAt: number;
  reasons: string[];
  receivedAt: number;
  /** Task 8b (msg only): destination deviceId hash, null = broadcast. */
  to: string | null;
}

/** One mesh device (mesh_devices; unique index on deviceId). First-packet TOFU pinning. */
export interface MeshDeviceDoc {
  deviceId: string;
  /** Base64 raw Ed25519 pubkey (32 bytes); null = pinned as a legacy (unsigned) device. */
  pubkey: string | null;
  legacy: boolean;
  firstSeen: number;
  lastSeen: number;
}

/** One rescue-beacon cluster (beacons; 2dsphere loc). Same normalized kind within 100 m merges into one doc. */
export interface MeshBeaconDoc {
  clusterId: string;
  kind: RescueKind;
  priority: number;
  /** Cluster anchor = the first contributing packet's loc (stable across merges). */
  loc: Point;
  /** Earliest contributing packet ts. */
  firstSeen: number;
  /** Latest contributing packet ts ($max on merge). */
  lastSeen: number;
  /** Set when the downlink bundle first acked this cluster to a contributor. */
  ackedAt: number | null;
  packetIds: string[];
  /** Contributing deviceIds — the downlink ack attribution key. */
  sources: string[];
  /** Best verified contributing packet score, stored once — rescue kinds are NEVER decayed/downgraded at read time. */
  score: number;
}

/** GET /mesh/state + the /map/state optional `mesh` section (dark-zone dashboard layer). */

/**
 * Task 8b: one mesh chat message as READ (never raw deviceId — `from`/`to` are the
 * same sha256 deviceId-hash prefixes that anonymize coverage dots; the `text` is the
 * original msg packet's status, preserved verbatim). Transport, not facts: rendered
 * nowhere server-side, never scored, never decayed.
 */
export interface MeshMessageView {
  id: string;
  from: string;
  to: string | null;
  text: string;
  ts: number;
  hops: number;
}

export interface MeshState {
  generatedAt: number;
  /** Clusters ranked by priority, then most recently seen (priority > score for beacons). */
  beacons: Array<{
    clusterId: string;
    kind: RescueKind;
    priority: number;
    lat: number;
    lon: number;
    reports: number;
    firstSeen: number;
    lastSeen: number;
    ackedAt: number | null;
    score: number;
  }>;
  hazardReports: Array<{
    id: string;
    status: string;
    lat: number;
    lon: number;
    ts: number;
    verify: VerifyState;
    /** Stored score composed with the 30-min read-time decay (null = unscored packet). */
    score: number | null;
    reasons: string[];
  }>;
  /** Anonymized coverage dots: deviceId hashed to a stable prefix + rounded location. */
  coverage: Array<{ id: string; lat: number; lon: number }>;
  /** Task 8b: mesh chat, newest 50 (type "msg" only — beacons/acks/briefs are never a message). */
  messages: MeshMessageView[];
  /** Task 8b: resource pins (shelters etc.) with the map-display status semantics (+ read-time confidence), so node maps show verified-open shelters. */
  resources: Array<{
    sourceId: string;
    kind: string;
    name: string;
    status: "open" | "unknown" | "closed" | "full";
    lat: number;
    lon: number;
  }>;
  counts: { packets: number; beacons: number; devices: number; acked: number };
}

/** The POST /mesh/sync response downlink bundle the gateway rebroadcasts. */
export interface DownlinkBundle {
  generatedAt: number;
  /** Template-composed brief (fallbackRender — never Gemini, no free text). */
  brief: { text: string; voiceScript: string };
  /** brief.shelter semantics: non-null only when a shelter is verified-open (confidence >= 0.5). */
  nearestVerifiedShelter: ShelterBrief | null;
  /** max 2, only fresh flooded/blocked verdicts (the locked blockedRoads semantics). */
  blockedRoads: BlockedRoad[];
  /** Ack packets for clusters this device contributed beacons to. */
  acks: Array<{ beaconClusterId: string; message: string }>;
  /** Task 8b: newest 20 mesh messages addressed to the gateway's hash or broadcast within its area — user text passed through verbatim (the template rule binds only server-COMPOSED strings). */
  messages: MeshMessageView[];
}