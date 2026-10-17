/**
 * Task 6 voice check-in queue (backend-build-plan.md: "writes a verifyQueue record
 * Delivery consumes; returns the list"). Documents live in the `verify_requests`
 * collection (name + unique requestId index registered in db/client.ts); the
 * memory implementation lets tests run without Mongo.
 *
 * Privacy (Task 3 carry): verify_requests never embed a phone number — Delivery
 * dials from its own partner contact book keyed by resourceId. Any map/state or
 * dashboard surface built over these records keeps that guarantee.
 */

export interface VerifyRequestDoc {
  /** Deterministic upsert key: `vr:<resourceId>:<hazardSourceId>` — idempotent re-runs. */
  requestId: string;
  resourceId: string;
  resourceName: string;
  /** The hazard that triggered the request (the check-in script cites it). */
  hazardSourceId: string;
  /** ElevenLabs check-in agent that will own the call (agent_id→request carry for the post-call webhook). */
  agentId: string | null;
  /** Delivery dispatch target (the poll contract GET /tools/checkin/next?deviceId=). */
  deviceId: string | null;
  status: "pending" | "dispatched" | "answered";
  outcome: string | null;
  conversationId: string | null;
  manual: boolean;
  createdAt: number;
  dispatchedAt: number | null;
  answeredAt: number | null;
}

export interface VerifyStore {
  /**
   * Create (or re-open) one request per resourceId+hazard: an existing
   * pending/dispatched request with the same requestId is left untouched; an
   * answered/expired one is re-armed only once per hour (its answeredAt must be
   * older than the hour — the check-in cadence cap). Returns null when nothing
   * should be created.
   */
  createRequest(doc: VerifyRequestDoc): Promise<VerifyRequestDoc | null>;
  /** Delivery's poll contract: pending requests for a deviceId (null deviceId = any dispatcher). */
  checkoutPending(deviceId: string | null, now: number): Promise<VerifyRequestDoc[]>;
  /** Most recent dispatched request carrying this agentId, for post-call outcome routing. */
  latestDispatchedByAgent(agentId: string): Promise<VerifyRequestDoc | null>;
  /** Record the call outcome on one request. */
  recordOutcome(requestId: string, outcome: string, conversationId: string | null, now: number): Promise<void>;
  /** How many of this resource's requests were answered since `since` (the per-resource/hour cap input). */
  countAnsweredSince(resourceId: string, since: number, now: number): Promise<number>;
  listRequests(): Promise<VerifyRequestDoc[]>;
}

/** Check-in requests for one resource re-arm (auto-refresh) at most once per hour. */
export const VERIFY_REARM_HOUR_MS = 60 * 60 * 1000;

export function mongoVerifyStore(db: import("mongodb").Db): VerifyStore {
  const col = db.collection<VerifyRequestDoc>("verify_requests");
  return {
    async createRequest(doc) {
      const existing = await col.findOne({ requestId: doc.requestId });
      if (existing && (existing.status === "pending" || existing.status === "dispatched")) return null;
      if (existing && (existing.answeredAt ?? 0) > doc.createdAt - VERIFY_REARM_HOUR_MS) return null;
      if (existing) {
        // _id is immutable: the re-arm must never spread it back into $set.
        const { _id: _stripped, ...reArmed } = existing as VerifyRequestDoc & Record<string, unknown>;
        void _stripped;
        const armed = {
          ...reArmed,
          status: "pending" as const,
          outcome: null,
          conversationId: null,
          createdAt: doc.createdAt,
          dispatchedAt: null,
          answeredAt: null,
          manual: doc.manual,
        };
        await col.updateOne({ requestId: doc.requestId }, { $set: armed });
        return armed;
      }
      await col.insertOne(doc);
      return doc;
    },
    async checkoutPending(deviceId, now) {
      const filter: Record<string, unknown> = { status: "pending" };
      if (deviceId) filter["deviceId"] = { $in: [deviceId, null] };
      const docs = await col.find(filter).toArray();
      if (docs.length === 0) return [];
      await col.updateMany(
        { requestId: { $in: docs.map((d) => d.requestId) } },
        { $set: { status: "dispatched", dispatchedAt: now } },
      );
      return docs.map((d) => ({ ...d, status: "dispatched" as const, dispatchedAt: now }));
    },
    async latestDispatchedByAgent(agentId) {
      const doc = await col.findOne({ agentId, status: "dispatched" }, { sort: { dispatchedAt: -1 } });
      return doc ?? null;
    },
    async recordOutcome(requestId, outcome, conversationId, now) {
      await col.updateOne(
        { requestId },
        { $set: { status: "answered", outcome, conversationId, answeredAt: now } },
      );
    },
    async countAnsweredSince(resourceId, since) {
      return col.countDocuments({ resourceId, answeredAt: { $gte: since } });
    },
    async listRequests() {
      return col.find().toArray();
    },
  };
}

export function memoryVerifyStore(): VerifyStore {
  const requests = new Map<string, VerifyRequestDoc>();
  return {
    async createRequest(doc) {
      const existing = requests.get(doc.requestId);
      if (existing && (existing.status === "pending" || existing.status === "dispatched")) return null;
      if (existing && (existing.answeredAt ?? 0) > doc.createdAt - VERIFY_REARM_HOUR_MS) return null;
      if (existing) {
        const reArmed = { ...existing, status: "pending" as const, outcome: null, conversationId: null, createdAt: doc.createdAt, dispatchedAt: null, answeredAt: null, manual: doc.manual };
        requests.set(doc.requestId, reArmed);
        return reArmed;
      }
      requests.set(doc.requestId, { ...doc });
      return doc;
    },
    async checkoutPending(deviceId, now) {
      const out: VerifyRequestDoc[] = [];
      for (const doc of [...requests.values()]) {
        if (doc.status !== "pending") continue;
        if (doc.deviceId && deviceId && doc.deviceId !== deviceId) continue;
        if (doc.deviceId && !deviceId) continue;
        const dispatched = { ...doc, status: "dispatched" as const, dispatchedAt: now };
        requests.set(doc.requestId, dispatched);
        out.push(dispatched);
      }
      return out;
    },
    async latestDispatchedByAgent(agentId) {
      let best: VerifyRequestDoc | null = null;
      for (const doc of requests.values()) {
        if (doc.agentId === agentId && doc.status === "dispatched") {
          if (!best || (doc.dispatchedAt ?? 0) > (best.dispatchedAt ?? 0)) best = doc;
        }
      }
      return best;
    },
    async recordOutcome(requestId, outcome, conversationId, now) {
      const doc = requests.get(requestId);
      if (doc) requests.set(requestId, { ...doc, status: "answered", outcome, conversationId, answeredAt: now });
    },
    async countAnsweredSince(resourceId, since) {
      let count = 0;
      for (const doc of requests.values()) {
        if (doc.resourceId === resourceId && (doc.answeredAt ?? 0) >= since) count += 1;
      }
      return count;
    },
    async listRequests() {
      return [...requests.values()];
    },
  };
}