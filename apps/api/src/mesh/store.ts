import type { Db } from "mongodb";
import { COLLECTIONS } from "../db/client.ts";
import { haversineKm } from "../match/geo.ts";
import type { Point } from "../types/docs.ts";
import { applyPhotoVerdictToDoc } from "./score.ts";
import type { MeshBeaconDoc, MeshDeviceDoc, MeshPacketDoc, MeshPhotoDoc, RescueKind } from "./types.ts";
import type { PhotoVerdict } from "./photovision.ts";

/**
 * The mesh store surface (Task 8): packets, pinned device keys, beacon clusters —
 * same split as the other stores (Mongo production path from db/client.ts +
 * an in-memory implementation for hermetic tests). Task 8e adds the photo store
 * (mesh_photos, upsert by photoRef).
 */
export interface MeshStore {
  getDevice(deviceId: string): Promise<MeshDeviceDoc | null>;
  /** First-packet pinning: insert-if-absent (unique deviceId); a lost race leaves the winner's doc intact. */
  pinDevice(doc: MeshDeviceDoc): Promise<void>;
  /** Promote a legacy device to a signed one (sig was verified against the newly carried pubkey). */
  setDevicePubkey(deviceId: string, pubkey: string, at: number): Promise<void>;
  /** Insert one packet; false = a packet with this id already exists (gateway-retry dedup). */
  insertPacket(doc: MeshPacketDoc): Promise<boolean>;
  listPackets(): Promise<MeshPacketDoc[]>;
  /** Upsert one photo by photoRef (idempotent gateway retries overwrite). */
  putPhoto(doc: MeshPhotoDoc): Promise<void>;
  getPhoto(photoRef: string): Promise<MeshPhotoDoc | null>;
  listPhotos(): Promise<MeshPhotoDoc[]>;
  /** The packet carrying this photoRef (the photo-pipeline boost target), or null. */
  findPacketByPhotoRef(photoRef: string): Promise<MeshPacketDoc | null>;
  /**
   * Apply a photo-vision verdict to the ONE packet carrying photoRef (forwarding-only
   * score refinement via score.applyPhotoVerdictToDoc — idempotent, never a recompute).
   * Beacon clusters that contain the packet keep their best (max) score. Returns the
   * updated packet, or null when no packet / nothing scoreable references photoRef.
   */
  applyPhotoVerdict(photoRef: string, verdict: PhotoVerdict): Promise<MeshPacketDoc | null>;
  /** Nearest cluster of the same kind within radiusM of loc (server-side over the beacons 2dsphere index). */
  findBeaconCluster(kind: RescueKind, loc: Point, radiusM: number): Promise<MeshBeaconDoc | null>;
  insertBeacon(doc: MeshBeaconDoc): Promise<void>;
  /** Merge one contributed packet into a cluster: lastSeen/score/priority take the max, ids add if new. */
  mergeBeacon(
    clusterId: string,
    patch: { lastSeen: number; priority: number; packetId: string; sourceId: string; score: number },
  ): Promise<void>;
  /** First ack wins (ackedAt stays at the earliest acknowledgement). */
  ackBeacon(clusterId: string, ackedAt: number): Promise<void>;
  listBeacons(): Promise<MeshBeaconDoc[]>;
}

const isDupKey = (err: unknown): boolean => (err as { code?: number } | null)?.code === 11000;

export function mongoMeshStore(db: Db): MeshStore {
  return {
    async getDevice(deviceId) {
      return db.collection<MeshDeviceDoc>(COLLECTIONS.meshDevices).findOne({ deviceId }, { projection: { _id: 0 } });
    },
    async pinDevice(doc) {
      // Plain insert (not upsert): pinning must never overwrite an existing device's
      // key — the unique index turns a lost pin race into a no-op error. The stored
      // doc shapes never carry _id (none of the mesh docs read the immutable key back).
      await db
        .collection(COLLECTIONS.meshDevices)
        .insertOne(doc as never)
        .catch((err) => {
          if (!isDupKey(err)) throw err;
        });
    },
    async setDevicePubkey(deviceId, pubkey, at) {
      await db.collection(COLLECTIONS.meshDevices).updateOne(
        { deviceId, pubkey: null },
        { $set: { pubkey, legacy: false, lastSeen: at } },
      );
    },
    async insertPacket(doc) {
      try {
        await db.collection<MeshPacketDoc>(COLLECTIONS.meshPackets).insertOne(doc as never);
        return true;
      } catch (err) {
        if (isDupKey(err)) return false;
        throw err;
      }
    },
    async listPackets() {
      return db.collection<MeshPacketDoc>(COLLECTIONS.meshPackets).find({}, { projection: { _id: 0 } }).toArray();
    },
    async putPhoto(doc) {
      // Upsert by photoRef: a gateway retry (or a re-shot ref) overwrites byte-for-byte.
      await db
        .collection<MeshPhotoDoc>(COLLECTIONS.meshPhotos)
        .replaceOne({ photoRef: doc.photoRef }, doc as never, { upsert: true });
    },
    async getPhoto(photoRef) {
      return db.collection<MeshPhotoDoc>(COLLECTIONS.meshPhotos).findOne({ photoRef }, { projection: { _id: 0 } });
    },
    async listPhotos() {
      return db.collection<MeshPhotoDoc>(COLLECTIONS.meshPhotos).find({}, { projection: { _id: 0 } }).toArray();
    },
    async findPacketByPhotoRef(photoRef) {
      return db
        .collection<MeshPacketDoc>(COLLECTIONS.meshPackets)
        .findOne({ photoRef }, { projection: { _id: 0 } });
    },
    async applyPhotoVerdict(photoRef, verdict) {
      const doc = await db
        .collection<MeshPacketDoc>(COLLECTIONS.meshPackets)
        .findOne({ photoRef, score: { $ne: null } }, { projection: { _id: 0 } });
      if (!doc) return null;
      const updated = applyPhotoVerdictToDoc(doc, verdict);
      if (!updated || updated === doc) return doc;
      await db.collection(COLLECTIONS.meshPackets).updateOne(
        { id: doc.id },
        { $set: { score: updated.score, reasons: updated.reasons, photoVision: updated.photoVision } },
      );
      // Rescue beacons: the cluster keeps the BEST contributing score ($max, the
      // mergeBeacon convention) — the photo boost must not be lost to the cluster.
      if (doc.type === "beacon") {
        await db
          .collection(COLLECTIONS.beacons)
          .updateOne({ packetIds: doc.id }, { $max: { score: updated.score } });
      }
      return updated;
    },
    async findBeaconCluster(kind, loc, radiusM) {
      const hits = await db
        .collection<MeshBeaconDoc>(COLLECTIONS.beacons)
        .aggregate<MeshBeaconDoc>()
        .geoNear({
          near: { type: "Point", coordinates: loc.coordinates },
          distanceField: "distanceM",
          maxDistance: radiusM,
          query: { kind },
        })
        // $geoNear's own `limit` is rejected on newer servers — cap after (Task 6 pattern).
        .limit(1)
        .toArray();
      return hits[0] ?? null;
    },
    async insertBeacon(doc) {
      await db.collection(COLLECTIONS.beacons).insertOne(doc as never);
    },
    async mergeBeacon(clusterId, patch) {
      await db.collection(COLLECTIONS.beacons).updateOne(
        { clusterId },
        {
          // Rescue kinds keep the max on every axis: lastSeen refresh time, best
          // score, highest priority (a co-located higher-priority kind merge).
          $max: { lastSeen: patch.lastSeen, score: patch.score, priority: patch.priority },
          $addToSet: { packetIds: patch.packetId, sources: patch.sourceId },
        },
      );
    },
    async ackBeacon(clusterId, ackedAt) {
      await db.collection(COLLECTIONS.beacons).updateOne({ clusterId, ackedAt: null }, { $set: { ackedAt } });
    },
    async listBeacons() {
      return db.collection<MeshBeaconDoc>(COLLECTIONS.beacons).find({}, { projection: { _id: 0 } }).toArray();
    },
  };
}

export function memoryMeshStore(): MeshStore {
  const devices = new Map<string, MeshDeviceDoc>();
  const packets = new Map<string, MeshPacketDoc>();
  const beacons = new Map<string, MeshBeaconDoc>();
  const photos = new Map<string, MeshPhotoDoc>();
  return {
    async getDevice(deviceId) {
      return devices.get(deviceId) ?? null;
    },
    async pinDevice(doc) {
      if (devices.has(doc.deviceId)) return;
      devices.set(doc.deviceId, { ...doc });
    },
    async setDevicePubkey(deviceId, pubkey, at) {
      const doc = devices.get(deviceId);
      if (doc && doc.pubkey === null) {
        devices.set(deviceId, { ...doc, pubkey, legacy: false, lastSeen: at });
      }
    },
    async insertPacket(doc) {
      if (packets.has(doc.id)) return false;
      packets.set(doc.id, { ...doc });
      return true;
    },
    async listPackets() {
      return [...packets.values()];
    },
    async putPhoto(doc) {
      photos.set(doc.photoRef, { ...doc });
    },
    async getPhoto(photoRef) {
      return photos.get(photoRef) ?? null;
    },
    async listPhotos() {
      return [...photos.values()];
    },
    async findPacketByPhotoRef(photoRef) {
      for (const doc of packets.values()) {
        if (doc.photoRef === photoRef) return doc;
      }
      return null;
    },
    async applyPhotoVerdict(photoRef, verdict) {
      let target: MeshPacketDoc | null = null;
      for (const doc of packets.values()) {
        if (doc.photoRef === photoRef) { target = doc; break; }
      }
      if (!target) return null;
      const updated = applyPhotoVerdictToDoc(target, verdict);
      if (!updated || updated.score === null) return null;
      packets.set(target.id, updated);
      // Rescue beacons: the cluster keeps the BEST contributing score (mergeBeacon's max).
      if (target.type === "beacon") {
        for (const cluster of beacons.values()) {
          if (cluster.packetIds.includes(target.id)) cluster.score = Math.max(cluster.score, updated.score);
        }
      }
      return updated;
    },
    async findBeaconCluster(kind, loc, radiusM) {
      let best: MeshBeaconDoc | null = null;
      let bestD = Infinity;
      for (const doc of beacons.values()) {
        if (doc.kind !== kind) continue;
        const d = haversineKm(loc.coordinates, doc.loc.coordinates);
        if (d <= radiusM / 1000 && d < bestD) {
          best = doc;
          bestD = d;
        }
      }
      return best;
    },
    async insertBeacon(doc) {
      beacons.set(doc.clusterId, { ...doc });
    },
    async mergeBeacon(clusterId, patch) {
      const doc = beacons.get(clusterId);
      if (!doc) return;
      doc.lastSeen = Math.max(doc.lastSeen, patch.lastSeen);
      doc.score = Math.max(doc.score, patch.score);
      doc.priority = Math.max(doc.priority, patch.priority);
      if (!doc.packetIds.includes(patch.packetId)) doc.packetIds.push(patch.packetId);
      if (!doc.sources.includes(patch.sourceId)) doc.sources.push(patch.sourceId);
    },
    async ackBeacon(clusterId, ackedAt) {
      const doc = beacons.get(clusterId);
      if (doc && doc.ackedAt === null) doc.ackedAt = ackedAt;
    },
    async listBeacons() {
      return [...beacons.values()];
    },
  };
}