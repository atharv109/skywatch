import { randomUUID } from "node:crypto";
import { haversineKm } from "../match/geo.ts";
import type { MatchStore } from "../match/store.ts";
import type { Point } from "../types/docs.ts";
import { buildDownlink } from "./downlink.ts";
import { hashPrefix } from "./state.ts";
import { normalizeRescueKind } from "./normalize.ts";
import { scoreUplink } from "./score.ts";
import { sigMessage, verifySig } from "./sig.ts";
import type { MeshStore } from "./store.ts";
import {
  MESH_MSG_STATUS_MAX,
  RESCUE_PRIORITY,
  SKYWATCH_CORE_ID,
  SKYWATCH_ROUTE,
  type MeshBeaconDoc,
  type MeshPacketDoc,
  type MeshPacketIn,
  type ParsedPacket,
  type RescueKind,
  type SkywatchChat,
  type VerifyState,
} from "./types.ts";
import type { DownlinkBundle } from "./types.ts";

/**
 * The /mesh/sync batch processor (Task 8). Per packet, in order:
 *   1. shape validation (broken shapes are only counted — there is no dedup key;
 *      SIG-FAILED packets ARE stored, verify-marked + unscored, never dropped silently),
 *   2. dedup by id (idempotent gateway retries; unique index backs it),
 *   3. signature verification with first-packet pubkey pinning (mesh_devices),
 *   4. scoring once (score.ts) — corroboration is computed over the WHOLE batch
 *      union so the result does not depend on packet arrival order,
 *   5. rescue-beacon clustering for verified beacons (same normalized kind within
 *      100 m merges; unsigned packets never create rescue clusters/acks).
 * Then the downlink bundle for the gateway (downlink.ts) rides the response.
 *
 * Task 8b (mesh chat): `msg` packets ride steps 1-3 + dedup exactly like the other
 * types and are scored by nothing, clustered into nothing, and decayed by nothing —
 * they are transport, not facts (state.ts/downlink.ts expose them as `messages`).
 * Task 8d (Ask Skywatch): a msg addressed `to: "SKYWATCH"` is routed to the Task 6
 * chat loop and answered as a trusted-core (verify:"core") msg packet stored before
 * the bundle is built, so the same sync's response already carries the answer.
 */

export const MAX_BATCH = 200;
export const CLUSTER_RADIUS_M = 100;
export const CORROBORATION_RADIUS_KM = 0.15;

export class SyncError extends Error {
  /** Only the two mesh route statuses (400 body errors / 503 unavailable) — keeps c.json typed. */
  status: 400 | 503;
  constructor(message: string, status: 400 | 503 = 400) {
    super(message);
    this.status = status;
  }
}

interface VerifyResult {
  verify: VerifyState;
  verifyReason: string | null;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type ParseResult = { ok: true; packet: ParsedPacket } | { ok: false; id: string | null; error: string };

function parsePacket(raw: MeshPacketIn): ParseResult {
  const fail = (error: string): ParseResult => ({
    ok: false,
    id: typeof raw?.id === "string" && raw.id.length > 0 && raw.id.length <= 128 ? raw.id : null,
    error,
  });
  if (typeof raw !== "object" || raw === null) return { ok: false, id: null, error: "packet must be an object" };
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    return fail("id must be a string of 1..128 chars");
  }
  const type = raw.type;
  if (type !== "beacon" && type !== "hazard" && type !== "ack" && type !== "brief" && type !== "msg") {
    return fail("type must be one of: beacon|hazard|ack|brief|msg");
  }
  if (!isFiniteNum(raw.lat) || raw.lat < -90 || raw.lat > 90) return fail("lat must be a finite number in -90..90");
  if (!isFiniteNum(raw.lon) || raw.lon < -180 || raw.lon > 180) return fail("lon must be a finite number in -180..180");
  if (!isFiniteNum(raw.ts)) return fail("ts must be a finite epoch-ms number");
  if (typeof raw.deviceId !== "string" || raw.deviceId.length === 0 || raw.deviceId.length > 128) {
    return fail("deviceId must be a string of 1..128 chars");
  }
  if (raw.deviceId === SKYWATCH_CORE_ID) {
    // Task 8d: the trusted-core id is reserved — a gateway claiming it would TOFU-pin
    // itself INTO the trusted identity and could spoof answers.
    return fail("deviceId is reserved (SKYWATCH-CORE answers as the trusted core)");
  }
  if (raw.hops !== undefined && (!isFiniteNum(raw.hops) || raw.hops < 0)) return fail("hops must be a number >= 0");
  if (raw.ttl !== undefined && (!isFiniteNum(raw.ttl) || raw.ttl <= 0)) return fail("ttl must be a number > 0");
  let status: string;
  let to: string | null = null;
  if (type === "msg") {
    // Task 8b mesh chat: the text rides the status field, preserved VERBATIM up to
    // MESH_MSG_STATUS_MAX — a longer/absent/non-string text is shape-broken
    // (rejected, only counted) rather than truncated, unlike the other types'
    // 200-slice status.
    if (typeof raw.status !== "string" || raw.status.length === 0 || raw.status.length > MESH_MSG_STATUS_MAX) {
      return fail(`msg status (the message text) must be a string of 1..${MESH_MSG_STATUS_MAX} chars`);
    }
    status = raw.status;
    // to null/absent = broadcast to the mesh; a string = direct message carrying the
    // destination deviceId hash (the same hash prefix that anonymizes coverage dots).
    if (raw.to !== undefined && raw.to !== null) {
      if (typeof raw.to !== "string" || raw.to.length === 0 || raw.to.length > 128) {
        return fail("msg to must be null (broadcast) or a deviceId hash string of 1..128 chars");
      }
      // Task 8d: "SKYWATCH" (case-insensitive) is canonicalized — the question route.
      to = raw.to.toUpperCase() === SKYWATCH_ROUTE ? SKYWATCH_ROUTE : raw.to;
    }
  } else {
    status = typeof raw.status === "string" ? raw.status.slice(0, 200) : "";
  }
  const packet: ParsedPacket = {
    id,
    type,
    status,
    rescueKind: type === "beacon" ? normalizeRescueKind(status) : null,
    lat: raw.lat,
    lon: raw.lon,
    ts: raw.ts,
    hops: isFiniteNum(raw.hops) ? raw.hops : 0,
    ttl: isFiniteNum(raw.ttl) ? raw.ttl : 7,
    photo: typeof raw.photo === "string" && raw.photo.length > 0,
    deviceId: raw.deviceId,
    sig: typeof raw.sig === "string" && raw.sig.length > 0 ? raw.sig : null,
    pubkey: typeof raw.pubkey === "string" && raw.pubkey.length > 0 ? raw.pubkey : null,
    legacy: raw.legacy === true,
    to,
  };
  return { ok: true, packet };
}

/**
 * Verify one shape-valid packet against the device's pinned key. When the packet
 * carries a pubkey and the device is unregistered with no pinned key, the pubkey is
 * PINNED first (trust-on-first-use, per the plan ruling) — a pin race is harmless:
 * the unique index keeps the first pin and this packet still verifies against the
 * key it itself carried.
 */
async function verifyPacket(store: MeshStore, packet: ParsedPacket, now: number): Promise<VerifyResult> {
  const device = await store.getDevice(packet.deviceId);
  if (packet.pubkey !== null) {
    if (device && device.pubkey !== null && device.pubkey !== packet.pubkey) {
      return { verify: "mismatch", verifyReason: "pubkey mismatch after pinning (device key is already pinned)" };
    }
    if (packet.sig === null) {
      return { verify: "invalid", verifyReason: "pubkey carried without a sig" };
    }
    if (!device && !packet.legacy) {
      await store.pinDevice({ deviceId: packet.deviceId, pubkey: packet.pubkey, legacy: packet.legacy, firstSeen: now, lastSeen: now });
    }
    if (device && device.pubkey === null) {
      // Legacy-pinned device now carrying a key: pin upgrade only if the sig verifies.
      if (verifySig(packet.sig, sigMessage(packet), packet.pubkey)) {
        await store.setDevicePubkey(packet.deviceId, packet.pubkey, now);
        return { verify: "ok", verifyReason: null };
      }
      return { verify: "invalid", verifyReason: "sig verification failed (ed25519 mismatch)" };
    }
    return verifySig(packet.sig, sigMessage(packet), packet.pubkey)
      ? { verify: "ok", verifyReason: null }
      : { verify: "invalid", verifyReason: "sig verification failed (ed25519 mismatch)" };
  }
  if (packet.legacy) return { verify: "unsigned", verifyReason: "unsigned device (legacy packet, not signature-verified)" };
  if (device && device.pubkey === null) {
    return { verify: "invalid", verifyReason: "unsigned after legacy pinning (device key is not pinned)" };
  }
  if (device && device.pubkey !== null) {
    return { verify: "mismatch", verifyReason: "unsigned after pinning (device key is already pinned)" };
  }
  return { verify: "invalid", verifyReason: "no pubkey and device not pinned (send pubkey on the first packet or legacy:true)" };
}

function packetDoc(packet: ParsedPacket, verify: VerifyResult, score: number | null, reasons: string[], now: number): MeshPacketDoc {
  // Beacons carry the CANONICAL kind label as their status; everything else keeps
  // the (trimmed) caller status.
  return {
    id: packet.id,
    type: packet.type,
    rescueKind: packet.rescueKind,
    status: packet.rescueKind ? packet.rescueKind : packet.status,
    lat: packet.lat,
    lon: packet.lon,
    ts: packet.ts,
    hops: packet.hops,
    ttl: packet.ttl,
    photo: packet.photo,
    deviceId: packet.deviceId,
    verify: verify.verify,
    verifyReason: verify.verifyReason,
    score,
    scoredAt: now,
    reasons,
    receivedAt: now,
    to: packet.to,
  };
}

export interface SyncOutcome {
  received: number;
  inserted: number;
  deduped: number;
  /** Shape-broken packets (no dedup key) — ids echo back when one was parseable. */
  rejected: number;
  rejectedIds: string[];
  scored: number;
  unscored: number;
  bundle: DownlinkBundle;
}

export interface SyncBody {
  deviceId: unknown;
  lat: unknown;
  lon: unknown;
  packets: unknown;
}

export async function processSync(
  store: MeshStore,
  match: MatchStore,
  body: SyncBody,
  now: number,
  // Task 8d Ask Skywatch: optional (tests that only exercise the packet path
  // pass nothing). When set, every to:"SKYWATCH" question is answered and the
  // trusted-core reply is stored BEFORE the downlink build — the same sync's
  // bundle already carries the answer.
  askSkywatch?: SkywatchChat,
): Promise<SyncOutcome> {
  if (typeof body?.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > 128) {
    throw new SyncError("deviceId must be a string of 1..128 chars");
  }
  if (!isFiniteNum(body.lat) || body.lat < -90 || body.lat > 90) throw new SyncError("lat must be a finite number in -90..90");
  if (!isFiniteNum(body.lon) || body.lon < -180 || body.lon > 180) throw new SyncError("lon must be a finite number in -180..180");
  if (!Array.isArray(body.packets)) throw new SyncError("packets must be an array");
  if (body.packets.length > MAX_BATCH) throw new SyncError(`batch cap: at most ${MAX_BATCH} packets per sync`);

  const existing = await store.listPackets();
  const existingIds = new Set(existing.map((p) => p.id));
  const parsed: Array<{ packet: ParsedPacket; verify: VerifyResult }> = [];
  const rejectedIds: string[] = [];
  const batchSeen = new Set<string>();
  let deduped = 0;

  for (const raw of body.packets as MeshPacketIn[]) {
    const result = parsePacket(raw);
    if (!result.ok) {
      // No dedup key to store under: shape-broken packets are only counted, with
      // their id echoed back when one was parseable.
      rejectedIds.push(result.id ?? `unparseable#${body.packets.indexOf(raw)}`);
      continue;
    }
    const packet = result.packet;
    if (existingIds.has(packet.id) || batchSeen.has(packet.id)) {
      deduped += 1;
      continue;
    }
    batchSeen.add(packet.id);
    const verify = await verifyPacket(store, packet, now);
    parsed.push({ packet, verify });
  }

  // Corroboration universe, computed per packet over the WHOLE batch union so the
  // score does not depend on packet arrival order: every verified packet already
  // stored plus every verified sibling in this batch (verified only — an unsigned
  // or spoofed packet can never boost another packet's score).
  const corroboratorsFor = (packet: ParsedPacket): number => {
    const peers: Array<{ id: string; deviceId: string; type: string; lat: number; lon: number }> = [
      ...existing.filter((p) => p.verify === "ok").map((p) => ({ id: p.id, deviceId: p.deviceId, type: p.type, lat: p.lat, lon: p.lon })),
      ...parsed
        .filter(({ verify }) => verify.verify === "ok")
        .map(({ packet }) => packet)
        .map((p) => ({ id: p.id, deviceId: p.deviceId, type: p.type, lat: p.lat, lon: p.lon })),
    ];
    const seenDevices = new Set<string>();
    let count = 0;
    for (const peer of peers) {
      if (peer.id === packet.id || peer.deviceId === packet.deviceId) continue;
      if (peer.type !== packet.type) continue;
      if (seenDevices.has(peer.deviceId)) continue;
      if (haversineKm([packet.lon, packet.lat], [peer.lon, peer.lat]) > CORROBORATION_RADIUS_KM) continue;
      seenDevices.add(peer.deviceId);
      count += 1;
    }
    return count;
  };

  const docs: Array<{ packet: ParsedPacket; doc: MeshPacketDoc }> = [];
  let scoredCount = 0;
  let unscored = 0;

  for (const { packet, verify } of parsed) {
    if (verify.verify !== "ok" && verify.verify !== "unsigned") {
      unscored += 1;
      docs.push({
        packet,
        doc: packetDoc(
          packet,
          verify,
          null,
          [
            `${verify.verifyReason} — packet recorded unscored, never dropped silently`,
            verify.verify === "mismatch" ? "misuse after pinning" : "sig invalid",
          ],
          now,
        ),
      });
      continue;
    }
    if (packet.type !== "beacon" && packet.type !== "hazard") {
      // Relay-only types ride the mesh but are scored by nothing.
      unscored += 1;
      docs.push({ packet, doc: packetDoc(packet, verify, null, ["not scored (relay packet type)"], now) });
      continue;
    }
    const hazards = await match.intersectingHazards(
      { type: "Point", coordinates: [packet.lon, packet.lat] },
      now,
    );
    const scored = scoreUplink({
      hazards,
      corroborators: corroboratorsFor(packet),
      photo: packet.photo,
      unsigned: verify.verify === "unsigned",
    });
    scoredCount += 1;
    docs.push({ packet, doc: packetDoc(packet, verify, scored.score, scored.reasons, now) });
  }

  let inserted = 0;
  for (const { packet, doc } of docs) {
    if (!(await store.insertPacket(doc))) {
      deduped += 1;
      continue;
    }
    inserted += 1;
    // Verified rescue beacons only: unsigned packets are recorded + scored but
    // NEVER create rescue clusters (and, through them, never create downlink acks).
    if (packet.rescueKind !== null && doc.verify === "ok") {
      const kind: RescueKind = packet.rescueKind;
      const point: Point = { type: "Point", coordinates: [packet.lon, packet.lat] };
      const cluster = await store.findBeaconCluster(kind, point, CLUSTER_RADIUS_M);
      if (cluster) {
        await store.mergeBeacon(cluster.clusterId, {
          lastSeen: Math.max(packet.ts, now),
          priority: RESCUE_PRIORITY[kind],
          packetId: packet.id,
          sourceId: packet.deviceId,
          score: doc.score ?? 0,
        });
      } else {
        const created: MeshBeaconDoc = {
          clusterId: `bc:${randomUUID()}`,
          kind,
          priority: RESCUE_PRIORITY[kind],
          loc: point,
          firstSeen: packet.ts,
          lastSeen: packet.ts,
          ackedAt: null,
          packetIds: [packet.id],
          sources: [packet.deviceId],
          score: doc.score ?? 0,
        };
        await store.insertBeacon(created);
      }
    }
  }

  // Task 8d Ask Skywatch: route every stored question packet (msg to the
  // canonical SKYWATCH route, any verify state — transport posture: the question
  // is user text regardless of sig state) through the Task 6 chat loop and store
  // the trusted-core reply as a new msg packet, direct to the asker's hash,
  // anchored at the ASKER's own coordinates. A context-build failure answers
  // NOTHING rather than something wrong (the asker re-asks); the answer text is
  // validator-safe by construction and sliced to the packet cap.
  for (const { packet } of docs) {
    if (!askSkywatch || packet.type !== "msg" || packet.to !== SKYWATCH_ROUTE) continue;
    const askerHash = hashPrefix(packet.deviceId);
    const question = {
      id: packet.id,
      text: packet.status,
      askerHash,
      loc: { type: "Point", coordinates: [packet.lon, packet.lat] } as Point,
    };
    let reply: string;
    try {
      reply = await askSkywatch(question, now);
    } catch (err) {
      console.error("ask-skywatch failed:", err instanceof Error ? err.message : err);
      continue;
    }
    if (reply.trim().length === 0) continue;
    const doc: MeshPacketDoc = {
      id: `chat:${randomUUID()}`,
      type: "msg",
      rescueKind: null,
      status: reply.slice(0, MESH_MSG_STATUS_MAX),
      lat: packet.lat,
      lon: packet.lon,
      ts: now,
      hops: 0,
      ttl: 7,
      photo: false,
      deviceId: SKYWATCH_CORE_ID,
      verify: "core",
      verifyReason: null,
      score: null,
      scoredAt: now,
      reasons: ["Ask Skywatch (trusted core) — server-composed via the Task 6 chat loop + validator; never scored, never clustered"],
      receivedAt: now,
      to: askerHash,
    };
    if (await store.insertPacket(doc)) inserted += 1;
  }

  const bundle = await buildDownlink(store, match, { deviceId: body.deviceId, lat: body.lat, lon: body.lon }, now);
  return {
    received: body.packets.length,
    inserted,
    deduped,
    rejected: rejectedIds.length,
    rejectedIds,
    scored: scoredCount,
    unscored,
    bundle,
  };
}