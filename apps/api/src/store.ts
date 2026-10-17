import type { Db } from "mongodb";
import { COLLECTIONS } from "./db/client.ts";
import type { HazardDoc, ResourceDoc, RoadDoc } from "./types/docs.ts";

/**
 * The narrow store surface app code uses, so tests can run a plain in-memory
 * implementation instead of Mongo (no mongo-mock dep). The Mongo implementation
 * wraps the shared collections from db/client.ts — upsert by each doc type's
 * deterministic key is what makes fixture replay idempotent.
 */
export interface AppStore {
  listHazards(): Promise<HazardDoc[]>;
  listResources(): Promise<ResourceDoc[]>;
  listRoads(): Promise<RoadDoc[]>;
  /** Anonymized user dots: [lon, lat] pairs only — no ids, no phone numbers. */
  listUserDots(): Promise<Array<[number, number]>>;
  /** Number of active users = brief count on the map ("briefCount"). */
  countUsers(): Promise<number>;
  /** Single-doc reads for Task 6 (check-in / roads/check): null = not found. */
  getResource(sourceId: string): Promise<ResourceDoc | null>;
  getRoad(cameraId: string): Promise<RoadDoc | null>;
  upsertHazard(doc: HazardDoc): Promise<void>;
  upsertResource(doc: ResourceDoc): Promise<void>;
  upsertRoad(doc: RoadDoc): Promise<void>;
}

function mongoUpsertCol<T extends Record<string, any>>(db: Db, name: string, keyField: keyof T & string, doc: T): Promise<void> {
  // $set on the whole doc (minus _id — immutable, Mongo rejects a $set on it):
  // repeated loads of the same fixture set overwrite their own docs instead of
  // duplicating them (idempotent replay).
  const { _id: _stripped, ...rest } = doc as Record<string, unknown>;
  void _stripped;
  return db
    .collection(name)
    .updateOne({ [keyField]: (doc as Record<string, unknown>)[keyField] }, { $set: rest }, { upsert: true })
    .then(() => undefined);
}

export function mongoStore(db: Db): AppStore {
  return {
    async listHazards() {
      return db.collection<HazardDoc>(COLLECTIONS.hazards).find().toArray();
    },
    async listResources() {
      return db.collection<ResourceDoc>(COLLECTIONS.resources).find().toArray();
    },
    async listRoads() {
      return db.collection<RoadDoc>(COLLECTIONS.roads).find().toArray();
    },
    async listUserDots() {
      const users = await db.collection(COLLECTIONS.users).find().toArray();
      return users
        .map((u) => u["loc"] as { type?: string; coordinates?: [number, number] } | undefined)
        .filter((loc): loc is { type: "Point"; coordinates: [number, number] } => {
          return (
            loc !== undefined && loc.type === "Point" && Array.isArray(loc.coordinates) && loc.coordinates.length === 2
          );
        })
        .map((loc) => loc.coordinates);
    },
    async countUsers() {
      return db.collection(COLLECTIONS.users).countDocuments();
    },
    async getResource(sourceId) {
      // _id projected away: callers re-spread reads into $set upserts (check-in,
      // roads/check) and must never carry the immutable key back in.
      return db
        .collection<ResourceDoc>(COLLECTIONS.resources)
        .findOne({ sourceId }, { projection: { _id: 0 } });
    },
    async getRoad(cameraId) {
      return db
        .collection<RoadDoc>(COLLECTIONS.roads)
        .findOne({ cameraId }, { projection: { _id: 0 } });
    },
    upsertHazard(doc) {
      return mongoUpsertCol(db, COLLECTIONS.hazards, "sourceId", doc);
    },
    upsertResource(doc) {
      return mongoUpsertCol(db, COLLECTIONS.resources, "sourceId", doc);
    },
    upsertRoad(doc) {
      return mongoUpsertCol(db, COLLECTIONS.roads, "cameraId", doc);
    },
  };
}

export function memoryStore(): AppStore {
  const hazards = new Map<string, HazardDoc>();
  const resources = new Map<string, ResourceDoc>();
  const roads = new Map<string, RoadDoc>();
  let dots: Array<[number, number]> = [];
  return {
    async listHazards() {
      return [...hazards.values()];
    },
    async listResources() {
      return [...resources.values()];
    },
    async listRoads() {
      return [...roads.values()];
    },
    async listUserDots() {
      return dots;
    },
    async countUsers() {
      return dots.length;
    },
    async getResource(sourceId) {
      return resources.get(sourceId) ?? null;
    },
    async getRoad(cameraId) {
      return roads.get(cameraId) ?? null;
    },
    upsertHazard(doc) {
      hazards.set(doc.sourceId, doc);
      return Promise.resolve();
    },
    upsertResource(doc) {
      resources.set(doc.sourceId, doc);
      return Promise.resolve();
    },
    upsertRoad(doc) {
      roads.set(doc.cameraId, doc);
      return Promise.resolve();
    },
  };
}