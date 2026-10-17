import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import type { Lang, UserBrief } from "../types/brief.ts";
import type { Point } from "../types/docs.ts";
import { COLLECTIONS } from "../db/client.ts";

/**
 * Signup state machine states (backend-build-plan.md Task 3): none → asked-address →
 * asked-lang → active. "none" is never stored — the first message creates the user
 * directly in asked-address.
 */
export type SignupState = "asked-address" | "asked-lang" | "active";

/** The users doc shape from the deliver side (surrogate id = Mongo _id; briefs use this as userId). */
export interface UserRecord {
  id: string;
  /** Unique per db/client.ts index. The Photon sender handle: E.164 or iMessage email. */
  phone: string;
  platform: "imessage" | "sms";
  /** Photon space id (opaque, e.g. "any;-;+15551234567") — where replies are sent. */
  spaceId: string;
  lang: Lang;
  state: SignupState;
  /** GeoJSON Point [lon, lat]; null until signup resolves the address/ZIP. */
  loc: Point | null;
  zip: string | null;
  /** Global Constraint 4: both granted on the first message. */
  consentText: boolean;
  consentVoice: boolean;
  /** Invalid-address attempts in the current signup run. */
  addressAttempts: number
  /** True once ≥2 bad addresses → we switched the prompt to ZIP-only. */
  askedZip: boolean;
  /** Ambiguous language reply → we defaulted to en and asked for confirmation. */
  langConfirmPending: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationEntry {
  userId: string;
  from: "user" | "bot";
  text: string;
  /** epoch ms */
  at: number;
}

export type OutboxKind = "reply" | "alert";
export type OutboxStatus = "sent" | "not_wired" | "failed" | "rate_limited" | "consent_hold";

/**
 * Alert rendering provenance (Task 5): the exact brief the text was rendered from,
 * the user language, and how the text was produced. Written on `kind: "alert"`
 * rows so the demo can show what the model saw vs what was delivered.
 */
export interface OutboxMeta {
  lang: Lang;
  source: "gemini" | "fallback";
  brief: UserBrief;
}

/**
 * Every outbound passes through here (Global Constraint 3). The rate-limit gate
 * (send.ts) reads back `kind: "alert"` rows by userId + rateKey.
 */
export interface OutboxRecord {
  userId: string;
  kind: OutboxKind;
  /** e.g. hazard sourceId or "scenario:type"; null for plain replies. */
  rateKey: string | null;
  spaceId: string;
  platform: string;
  text: string;
  status: OutboxStatus;
  /** Only set for failed attempts (NotWiredError message / SDK error). */
  error: string | null;
  /** Task 5: rendered-alert provenance (alert rows only). */
  meta?: OutboxMeta | undefined;
  createdAt: number;
  sentAt: number | null;
}

/**
 * The narrow store surface the deliver path uses (mirrors AppStore in store.ts).
 * Mongo impl backs it with the shared users/conversations/outbox collections;
 * tests run against memoryDeliverStore with no Mongo dependency.
 */
export interface DeliverStore {
  getUserByPhone(phone: string): Promise<UserRecord | null>;
  /** By the surrogate id (= Mongo _id string); the consent re-read for deliverAlert lives here. */
  getUserById(id: string): Promise<UserRecord | null>;
  createUser(user: Omit<UserRecord, "id">): Promise<UserRecord>;
  updateUser(user: UserRecord): Promise<void>;
  /** True when a user existed and was removed (STOP). */
  deleteUserByPhone(phone: string): Promise<boolean>;
  appendConversation(entry: ConversationEntry): Promise<void>;
  appendOutbox(record: OutboxRecord): Promise<void>;
  /** Newest alert outbox row for userId+rateKey with createdAt >= since (rate gate lookup). */
  lastOutboxAlert(userId: string, rateKey: string, since: number): Promise<OutboxRecord | null>;
  /**
   * The user's current brief (Task 6 conversational gate + getBrief tool): the
   * `meta.brief` of the newest alert outbox row that carries one. Null = the
   * pipeline has not briefed this user (hold-the-line reply, never the tool loop).
   */
  lastBrief(userId: string): Promise<UserBrief | null>;
  /** Last `limit` conversation turns for a user, oldest-first (chat history). */
  recentConversation(userId: string, limit: number): Promise<ConversationEntry[]>;
  /**
   * Users the match pipeline briefs: active signup state, consent granted (both
   * flags), and a resolved location. Task 4 pipeline + per-user brief matching.
   */
  listBriefableUsers(): Promise<UserRecord[]>;
  // read access for tests / Task 5-6 dashboards:
  listOutbox(): Promise<OutboxRecord[]>;
  listConversations(): Promise<ConversationEntry[]>;
}

function userToDoc(user: Omit<UserRecord, "id">): Record<string, unknown> {
  return { ...user };
}

function docToUser(doc: Record<string, unknown>): UserRecord {
  return {
    id: String(doc["_id"]),
    phone: String(doc["phone"]),
    platform: doc["platform"] as UserRecord["platform"],
    spaceId: String(doc["spaceId"]),
    lang: doc["lang"] as Lang,
    state: doc["state"] as UserRecord["state"],
    loc: (doc["loc"] ?? null) as Point | null,
    zip: (doc["zip"] ?? null) as string | null,
    consentText: doc["consentText"] === true,
    consentVoice: doc["consentVoice"] === true,
    addressAttempts: Number(doc["addressAttempts"] ?? 0),
    askedZip: doc["askedZip"] === true,
    langConfirmPending: doc["langConfirmPending"] === true,
    createdAt: Number(doc["createdAt"]),
    updatedAt: Number(doc["updatedAt"]),
  };
}

function docToConversation(doc: Record<string, unknown>): ConversationEntry {
  return {
    userId: String(doc["userId"]),
    from: doc["from"] as "user" | "bot",
    text: String(doc["text"]),
    at: Number(doc["at"]),
  };
}

function docToRecord(doc: Record<string, unknown>): OutboxRecord {
  return {
    userId: String(doc["userId"]),
    kind: doc["kind"] as OutboxKind,
    rateKey: (doc["rateKey"] ?? null) as string | null,
    spaceId: String(doc["spaceId"]),
    platform: String(doc["platform"]),
    text: String(doc["text"]),
    status: doc["status"] as OutboxStatus,
    error: (doc["error"] ?? null) as string | null,
    meta: (doc["meta"] ?? undefined) as OutboxMeta | undefined,
    createdAt: Number(doc["createdAt"]),
    sentAt: (doc["sentAt"] ?? null) as number | null,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

export function mongoDeliverStore(db: Db): DeliverStore {
  const users = db.collection<Record<string, unknown>>(COLLECTIONS.users);
  const convos = db.collection<Record<string, unknown>>(COLLECTIONS.conversations);
  const outbox = db.collection<Record<string, unknown>>(COLLECTIONS.outbox);
  return {
    async getUserByPhone(phone) {
      const doc = await users.findOne({ phone });
      return doc ? docToUser(doc) : null;
    },
    // A malformed/foreign id must read as "not found", not throw.
    async getUserById(id) {
      try {
        const doc = await users.findOne({ _id: new ObjectId(id) });
        return doc ? docToUser(doc) : null;
      } catch {
        return null;
      }
    },
    async createUser(user) {
      const doc = { ...userToDoc(user), _id: new ObjectId() };
      try {
        await users.insertOne(doc);
        return docToUser(doc);
      } catch (err) {
        // users.phone is unique (db/client.ts index): a concurrent signup won the race.
        if (isDuplicateKey(err)) {
          const existing = await users.findOne({ phone: user.phone });
          if (existing) return docToUser(existing);
        }
        throw err;
      }
    },
    async updateUser(user) {
      await users.replaceOne({ phone: user.phone }, userToDoc(user));
    },
    async deleteUserByPhone(phone) {
      const res = await users.deleteOne({ phone });
      return res.deletedCount > 0;
    },
    async appendConversation(entry) {
      await convos.insertOne({ userId: entry.userId, from: entry.from, text: entry.text, at: entry.at });
    },
    async appendOutbox(record) {
      await outbox.insertOne({ ...record });
    },
    async lastOutboxAlert(userId, rateKey, since) {
      const doc = await outbox.findOne(
        { userId, kind: "alert", rateKey, createdAt: { $gte: since } },
        { sort: { createdAt: -1 } },
      );
      return doc ? docToRecord(doc) : null;
    },
    async lastBrief(userId) {
      const doc = await outbox.findOne(
        { userId, kind: "alert", "meta": { $exists: true, $ne: null }, "meta.brief": { $exists: true, $ne: null } },
        { sort: { createdAt: -1 } },
      );
      const brief = doc ? docToRecord(doc).meta?.brief : null;
      return (brief as UserBrief | undefined) ?? null;
    },
    async recentConversation(userId, limit) {
      const docs = await convos
        .find({ userId })
        .sort({ at: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return docs
        .map(docToConversation)
        .reverse();
    },
    async listOutbox() {
      const docs = await outbox.find().toArray();
      return docs.map(docToRecord);
    },
    async listConversations() {
      const docs = await convos.find().toArray();
      return docs.map(docToConversation);
    },
    async listBriefableUsers() {
      const docs = await users
        .find({ state: "active", consentText: true, consentVoice: true, loc: { $exists: true, $ne: null } })
        .toArray();
      return docs.map(docToUser);
    },
  };
}

export function memoryDeliverStore(): DeliverStore {
  const users = new Map<string, UserRecord>();
  const convos: ConversationEntry[] = [];
  const sent: OutboxRecord[] = [];
  let nextId = 1;
  return {
    async getUserByPhone(phone) {
      return users.get(phone) ?? null;
    },
    async getUserById(id) {
      for (const record of users.values()) {
        if (record.id === id) return record;
      }
      return null;
    },
    async createUser(user) {
      const record: UserRecord = { ...user, id: `mem-${nextId++}` };
      users.set(user.phone, record);
      return record;
    },
    async updateUser(user) {
      users.set(user.phone, user);
    },
    async deleteUserByPhone(phone) {
      return users.delete(phone);
    },
    async appendConversation(entry) {
      convos.push({ ...entry });
    },
    async appendOutbox(record) {
      sent.push({ ...record });
    },
    async lastOutboxAlert(userId, rateKey, since) {
      let best: OutboxRecord | null = null;
      for (const record of sent) {
        if (record.userId === userId && record.kind === "alert" && record.rateKey === rateKey && record.createdAt >= since) {
          if (!best || record.createdAt > best.createdAt) best = record;
        }
      }
      return best;
    },
    async lastBrief(userId) {
      let best: OutboxRecord | null = null;
      for (const record of sent) {
        if (record.userId === userId && record.kind === "alert" && record.meta?.brief) {
          if (!best || record.createdAt > best.createdAt) best = record;
        }
      }
      return best?.meta?.brief ?? null;
    },
    async recentConversation(userId, limit) {
      const mine = convos.filter((entry) => entry.userId === userId);
      return mine.slice(Math.max(0, mine.length - limit));
    },
    async listOutbox() {
      return [...sent];
    },
    async listConversations() {
      return [...convos];
    },
    async listBriefableUsers() {
      return [...users.values()].filter((u) => u.state === "active" && u.consentText && u.consentVoice && u.loc !== null);
    },
  };
}